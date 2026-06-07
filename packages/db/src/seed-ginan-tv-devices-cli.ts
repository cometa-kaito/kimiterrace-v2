import postgres from "postgres";
import {
  GINAN_ECE_DEPARTMENT_NAME,
  GINAN_ECE_TV_DEVICES,
  GINAN_SCHOOL_NAME,
  GINAN_TV_DEFAULT_SCHEDULE,
  validateGinanTvSeedDevices,
} from "./seed-ginan-tv-devices.js";

/**
 * F15 (ADR-022): 岐阜県立岐南工業高等学校「電子工学科 1〜3 年」の教室 TV サイネージ端末を v2 の
 * `tv_devices`（TV デバイス管理）へ登録する **シード実行エントリ**。
 * データ（device_id・実 target_mac・既定スケジュール・出典）は {@link ./seed-ginan-tv-devices.ts} を参照。
 *
 * ## 実行方法
 * - ローカル: `DATABASE_URL=postgres://... node dist/seed-ginan-tv-devices-cli.js`
 * - staging: migrate と同一イメージに本 CLI を同梱し、Cloud Run Job の command 上書きで起動する
 *   （`command=["node","dist/seed-ginan-tv-devices-cli.js"]`、seed-ginan-sensors-cli と同パターン）。
 *
 * ## 前提（このシードは作らない）
 * 学校 `岐阜県立岐南工業高等学校` と `departments=電子工学科` / 1〜3 年の grades・classes は **既存**であること。
 * 本シードは責務を「TV デバイス登録のみ」に絞る（ルール6: 1 PR = 1 機能）。学校が見つからなければ
 * 孤児行を作らず **fail-loud** で中断する（seed-ginan-sensors-cli と同規律）。
 *
 * ## RLS（ルール2 / staging は migrator が非 BYPASSRLS + FORCE RLS）
 * 接続は migrate と同じ migrator DSN（`DATABASE_URL`）。tv_devices は FORCE ROW LEVEL SECURITY ゆえ
 * 生 INSERT は tenant_isolation の WITH CHECK で弾かれる。tx 内で
 * `set_config('app.current_user_role','system_admin', true)` を張り、`system_admin_full_access`
 * policy（0016_tv_devices_rls.sql）を通して書き込む（seed の常道、seed-ginan-sensors-cli と同じ）。
 *
 * ## 冪等性 / 教室コンテキスト紐づけ（best-effort）
 * `ON CONFLICT (device_id) DO NOTHING` で再実行安全（既存は上書きしない＝UI 手編集を壊さない）。
 * department_id / grade_id / class_id は 電子工学科 × 学年で一意に解決できた場合のみ紐づけ、0 件 / 複数件は
 * **NULL**（label が教室文脈を保持）。後から UI / 別シードで紐づけ可能。
 *
 * ## 監査（ルール1） / 秘密（ルール5）
 * created_by/updated_by は省略 = NULL（システム作成）。signage_url / webhook_url（秘密を含みうる）は
 * 設定せず NULL（運用者が後から UI / Secret 経由で設定）。schedule_json は既定値を投入し UI で変更可。
 * ★ ログにもエラーにも DATABASE_URL を出さない（device_id / target_mac は ADR-020/F15 上 PII でなく出力可）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない）
 * drizzle schema barrel は pgvector 経由で `@kimiterrace/ai` に推移依存し migrate イメージで
 * ERR_MODULE_NOT_FOUND になるため、`postgres` の生 SQL で書く（migrate-cli / seed-ginan-sensors-cli と同じ）。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL_NAME;
const DEPARTMENT_NAME = process.env.SEED_GINAN_DEPARTMENT_NAME ?? GINAN_ECE_DEPARTMENT_NAME;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  // DB に触れる前に配列の自己整合性を検証（device_id 形式・一意・MAC 形式・ラベル長）。
  validateGinanTvSeedDevices(GINAN_ECE_TV_DEVICES);

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  const perDevice: Array<{
    grade: number;
    deviceId: string;
    context: string;
    action: string;
  }> = [];
  let inserted = 0;
  let skipped = 0;
  let resolvedSchoolId: string | undefined;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で system_admin_full_access policy を通すため system_admin context を張る（tx スコープ）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // 学校（テナント）を名前で解決。見つからなければ fail-loud（孤児 TV を作らない）。
      const schoolRows = await tx<{ id: string }[]>`
        SELECT id FROM schools WHERE name = ${SCHOOL_NAME} ORDER BY created_at ASC LIMIT 1`;
      const schoolId = schoolRows[0]?.id;
      if (!schoolId) {
        throw new Error(
          `school not found by name: ${SCHOOL_NAME}（先に学校レコードを作成してください）`,
        );
      }
      resolvedSchoolId = schoolId;

      // 学科（department）を名前で best-effort 解決（無い学校構成なら NULL）。
      const deptRows = await tx<{ id: string }[]>`
        SELECT id FROM departments
        WHERE school_id = ${schoolId} AND name = ${DEPARTMENT_NAME}
        ORDER BY created_at ASC LIMIT 1`;
      const departmentId = deptRows[0]?.id ?? null;

      const scheduleJson = JSON.stringify(GINAN_TV_DEFAULT_SCHEDULE);

      for (const d of GINAN_ECE_TV_DEVICES) {
        // 教室コンテキスト（class_id / grade_id）は best-effort: 電子工学科（departments）→ 学年（grades）→
        // クラス（classes）を辿り、当該学年のクラスが一意に決まる時のみ class_id / grade_id を紐づける。
        // 0/複数件は NULL（label が文脈を保持。seed-ginan-sensors-cli と同規律）。
        const classRows = await tx<{ classId: string; gradeId: string | null }[]>`
          SELECT c.id AS "classId", c.grade_id AS "gradeId"
          FROM classes c
          JOIN grades g ON c.grade_id = g.id
          JOIN departments dep ON g.department_id = dep.id
          WHERE c.school_id = ${schoolId}
            AND g.school_id = ${schoolId}
            AND dep.school_id = ${schoolId}
            AND dep.name = ${DEPARTMENT_NAME}
            AND c.grade = ${d.grade}`;

        let classId: string | null = null;
        let gradeId: string | null = null;
        let contextNote: string;
        const onlyClass = classRows.length === 1 ? classRows[0] : undefined;
        if (onlyClass) {
          classId = onlyClass.classId;
          gradeId = onlyClass.gradeId;
          contextNote = "linked";
        } else if (classRows.length > 1) {
          contextNote = `ambiguous(${classRows.length})->null`;
        } else {
          contextNote = "no-class->null";
        }

        // device_id はグローバル一意（ux_tv_devices_device_id）。既存は DO NOTHING で温存（冪等）。
        // jsonb は ${JSON.stringify(obj)}::jsonb で bind（postgres@3 の sql.json ラッパ罠回避）。
        const ins = await tx<{ id: string }[]>`
          INSERT INTO tv_devices
            (school_id, device_id, label, target_mac, schedule_json, department_id, grade_id, class_id)
          VALUES
            (${schoolId}, ${d.deviceId}, ${d.label}, ${d.targetMac}, ${scheduleJson}::jsonb,
             ${departmentId}, ${gradeId}, ${classId})
          ON CONFLICT (device_id) DO NOTHING
          RETURNING id`;

        if (ins.length === 1) {
          inserted++;
          perDevice.push({
            grade: d.grade,
            deviceId: d.deviceId,
            context: contextNote,
            action: "inserted",
          });
        } else {
          skipped++;
          perDevice.push({
            grade: d.grade,
            deviceId: d.deviceId,
            context: contextNote,
            action: "skipped(exists)",
          });
        }
      }
    });

    // 識別子・件数のみ（DATABASE_URL は出さない。device_id / target_mac は PII でない）。
    console.log(
      JSON.stringify({
        event: "seed.ginan.tv-devices.done",
        schoolName: SCHOOL_NAME,
        schoolId: resolvedSchoolId,
        department: DEPARTMENT_NAME,
        inserted,
        skipped,
        total: GINAN_ECE_TV_DEVICES.length,
        devices: perDevice,
      }),
    );
  } catch (err) {
    // err は postgres driver 例外。DSN 全文は含まない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
