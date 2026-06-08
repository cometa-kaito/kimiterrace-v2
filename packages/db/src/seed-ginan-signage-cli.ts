import postgres from "postgres";
import {
  GINAN_ECE_DEPARTMENT_NAME,
  GINAN_SCHOOL_NAME,
  GINAN_SIGNAGE_GRADES,
  buildSignageUrl,
  generateToken,
  hashToken,
  isV2SignageUrl,
  resolveSignageBaseUrl,
  resolveSignageTtlDays,
} from "./seed-ginan-signage.js";

/**
 * F15 / F05 (ADR-022 / ADR-019): 岐阜県立岐南工業高等学校「電子工学科 1〜3 年」の各クラスに
 * **サイネージ表示用 magic link** を発行し、対応する `tv_devices.signage_url` を v2 形
 * （`https://app.school-signage.net/signage/<token>`）に設定する **シード実行エントリ**。
 * 純ロジック（トークン生成・URL 組立・env 解決）は {@link ./seed-ginan-signage.ts} を参照。
 *
 * ## 実行方法
 * - ローカル: `DATABASE_URL=postgres://... node dist/seed-ginan-signage-cli.js`
 * - prod cutover: migrate と同一イメージに本 CLI を同梱し、Cloud Run Job の command 上書きで起動する
 *   （`command=["node","dist/seed-ginan-signage-cli.js"]`、他 seed-ginan-*-cli と同パターン）。
 *
 * ## 前提（このシードは作らない）
 * 学校 `岐阜県立岐南工業高等学校` + `departments=電子工学科` / 1〜3 年 grades・classes、および
 * **TV デバイス行**（`tv_devices`、`seed-ginan-tv-devices-cli` で登録済・class_id 紐づけ済）が既存であること。
 * 見つからない学年は orphan を作らず **skip**（device 無し）し、学校が無ければ fail-loud で中断する。
 *
 * ## RLS（ルール2 / migrator は非 BYPASSRLS + FORCE RLS）
 * 接続は migrate と同じ migrator DSN（`DATABASE_URL`）。tx 内で
 * `set_config('app.current_user_role','system_admin', true)` + `set_config('app.current_school_id', <id>, true)`
 * を張り、magic_links / tv_devices の tenant_isolation（WITH CHECK）と system_admin policy の双方を通す。
 *
 * ## 冪等性
 * 既に signage_url が v2 形（同 base 配下 `/signage/`）に設定済みのデバイスは **skip**（トークンを churn しない）。
 * 未設定のデバイスにのみ新規 magic link を発行し signage_url を UPDATE する。再実行は安全
 * （設定済みは skip。NULL のまま再実行すると新トークンを 1 つ発行する＝過剰発行を避けるため通常 1 回だけ実行する）。
 *
 * ## 秘匿（ルール5） / 監査（ルール1）
 * ★ plaintext トークン・signage_url（トークンを含む）・DATABASE_URL は **ログにもエラーにも出さない**。
 * 出力は識別子（device_id / magic_link id）と件数のみ。created_by/updated_by は省略 = NULL（システム作成）。
 * magic_links は他 seed と同じくアプリ層 audit_log を書かない（システム bootstrap、created_by=null）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない）
 * drizzle schema barrel は pgvector 経由で `@kimiterrace/ai` に推移依存し migrate イメージで
 * ERR_MODULE_NOT_FOUND になるため、`postgres` の生 SQL で書く（migrate-cli / 他 seed-ginan-*-cli と同じ）。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL_NAME;
const DEPARTMENT_NAME = process.env.SEED_GINAN_DEPARTMENT_NAME ?? GINAN_ECE_DEPARTMENT_NAME;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  // 純ロジックで env を解決（不正なら DB 接触前に fail-fast）。
  const baseUrl = resolveSignageBaseUrl(process.env.SIGNAGE_BASE_URL);
  const ttlDays = resolveSignageTtlDays(process.env.SEED_GINAN_SIGNAGE_TTL_DAYS);

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  const perGrade: Array<{
    grade: number;
    deviceId: string;
    action: string;
  }> = [];
  let created = 0;
  let skipped = 0;
  let resolvedSchoolId: string | undefined;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で tenant_isolation / system_admin policy を通すため role + school context を張る（tx スコープ）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // 学校（テナント）を名前で解決。見つからなければ fail-loud（孤児リンクを作らない）。
      const schoolRows = await tx<{ id: string }[]>`
        SELECT id FROM schools WHERE name = ${SCHOOL_NAME} ORDER BY created_at ASC LIMIT 1`;
      const schoolId = schoolRows[0]?.id;
      if (!schoolId) {
        throw new Error(
          `school not found by name: ${SCHOOL_NAME}（先に学校レコードを作成してください）`,
        );
      }
      resolvedSchoolId = schoolId;

      // magic_links / tv_devices の tenant_isolation（WITH CHECK = school_id = current_school_id）を満たす。
      await tx`SELECT set_config('app.current_school_id', ${schoolId}, true)`;

      for (const grade of GINAN_SIGNAGE_GRADES) {
        // 電子工学科 × 学年でクラスを一意解決（0/複数件は skip。岐南は学年 1 クラス前提）。
        const classRows = await tx<{ classId: string }[]>`
          SELECT c.id AS "classId"
          FROM classes c
          JOIN grades g ON c.grade_id = g.id
          JOIN departments dep ON g.department_id = dep.id
          WHERE c.school_id = ${schoolId}
            AND g.school_id = ${schoolId}
            AND dep.school_id = ${schoolId}
            AND dep.name = ${DEPARTMENT_NAME}
            AND c.grade = ${grade}`;
        const cls = classRows.length === 1 ? classRows[0] : undefined;
        if (!cls) {
          perGrade.push({
            grade,
            deviceId: "-",
            action:
              classRows.length > 1 ? `skip(class-ambiguous:${classRows.length})` : "skip(no-class)",
          });
          skipped++;
          continue;
        }
        const classId = cls.classId;

        // 当該クラスに紐づく TV デバイスを取得（seed-ginan-tv が class_id を紐づけ済み）。
        const devRows = await tx<{ id: string; deviceId: string; signageUrl: string | null }[]>`
          SELECT id, device_id AS "deviceId", signage_url AS "signageUrl"
          FROM tv_devices
          WHERE school_id = ${schoolId}
            AND deleted_at IS NULL
            AND class_id = ${classId}
          ORDER BY created_at ASC
          LIMIT 1`;
        const dev = devRows[0];
        if (!dev) {
          perGrade.push({ grade, deviceId: "-", action: "skip(no-device)" });
          skipped++;
          continue;
        }

        // 冪等: 既に v2 signage が設定済みならトークンを churn せず skip。
        if (isV2SignageUrl(dev.signageUrl, baseUrl)) {
          perGrade.push({ grade, deviceId: dev.deviceId, action: "skip(signage-set)" });
          skipped++;
          continue;
        }

        // magic link を発行（plaintext は signage_url にのみ載せ、DB には hash のみ・ルール5）。
        const token = generateToken();
        const tokenHash = hashToken(token);
        // expires_at は timestamptz。postgres@3 の Date bind 罠（#486）を避け、SQL 側 make_interval で構築。
        const mlRows = await tx<{ id: string }[]>`
          INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
          VALUES (
            ${schoolId}, ${classId}, ${tokenHash},
            now() + make_interval(days => ${ttlDays}::int)
          )
          RETURNING id`;
        const magicLinkId = mlRows[0]?.id;
        if (!magicLinkId) {
          throw new Error(
            `magic_links INSERT returned 0 rows for class ${classId} (RLS rejection?)`,
          );
        }

        // signage_url を v2 形に設定。updated_at は明示更新（auditColumns の updated_at は $onUpdate 無し・ルール1）。
        const signageUrl = buildSignageUrl(baseUrl, token);
        const upd = await tx<{ id: string }[]>`
          UPDATE tv_devices
          SET signage_url = ${signageUrl}, updated_at = now()
          WHERE id = ${dev.id}
          RETURNING id`;
        if (upd.length !== 1) {
          throw new Error(
            `tv_devices UPDATE affected ${upd.length} rows for device ${dev.deviceId}`,
          );
        }

        created++;
        // 注: signage_url / token はログに出さない（識別子のみ）。
        perGrade.push({ grade, deviceId: dev.deviceId, action: `set(ml=${magicLinkId})` });
      }
    });

    // 識別子・件数のみ（token / signage_url / DATABASE_URL は出さない）。
    console.log(
      JSON.stringify({
        event: "seed.ginan.signage.done",
        schoolName: SCHOOL_NAME,
        schoolId: resolvedSchoolId,
        department: DEPARTMENT_NAME,
        signageBase: baseUrl,
        ttlDays,
        created,
        skipped,
        total: GINAN_SIGNAGE_GRADES.length,
        grades: perGrade,
      }),
    );
  } catch (err) {
    // err は postgres driver 例外。DSN 全文・token は含まない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
