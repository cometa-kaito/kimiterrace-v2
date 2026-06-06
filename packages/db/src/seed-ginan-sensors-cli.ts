import postgres from "postgres";
import {
  GINAN_ECE_DEPARTMENT_NAME,
  GINAN_ECE_SENSOR_DEVICES,
  GINAN_SCHOOL_NAME,
  validateGinanSeedDevices,
} from "./seed-ginan-sensors.js";

/**
 * F13 (#391, ADR-020): 岐阜県立岐南工業高校「電子工学科 1〜3 年」の設置済み SwitchBot 人感センサーを
 * v2 の `sensor_devices`（センサー管理）へ登録する **シード実行エントリ**。
 * データ（実 MAC・出典）は {@link ./seed-ginan-sensors.ts} を参照。
 *
 * ## 実行方法
 * - ローカル: `DATABASE_URL=postgres://... node dist/seed-ginan-sensors-cli.js`
 * - staging: migrate と同一イメージに本 CLI を同梱し、Cloud Run Job の command 上書きで起動する
 *   （`command=["node","dist/seed-ginan-sensors-cli.js"]`、seed-staging-cli と同パターン）。
 *
 * ## 前提（このシードは作らない）
 * 学校 `岐阜県立岐南工業高校` と `departments=電子工学科` / 1〜3 年の grades・classes は **既存**であること。
 * 本シードは責務を「センサー登録のみ」に絞る（ルール6: 1 PR = 1 機能）。学校が見つからなければ
 * 孤児行を作らず **fail-loud** で中断する。
 *
 * ## RLS（ルール2 / staging は migrator が非 BYPASSRLS + FORCE RLS）
 * 接続は migrate と同じ migrator DSN（`DATABASE_URL`）。テーブルは FORCE ROW LEVEL SECURITY ゆえ
 * 生 INSERT は tenant_isolation の WITH CHECK で弾かれる。tx 内で
 * `set_config('app.current_user_role','system_admin', true)` を張り、`system_admin_full_access`
 * policy（0002_rls_policies.sql）を通して書き込む（seed の常道、seed-staging-cli と同じ）。
 *
 * ## 冪等性 / class 紐づけ（best-effort）
 * `ON CONFLICT (device_mac) DO NOTHING` で再実行安全（既存は上書きしない＝UI 手編集を壊さない）。
 * class_id は 電子工学科 × 学年で一意に解決できた場合のみ紐づけ、0 件 / 複数件は **NULL**（location_label が
 * 教室文脈を保持）。後から UI / 別シードで紐づけ可能。
 *
 * ## 監査（ルール1） / 秘密（ルール5）
 * created_by/updated_by は省略 = NULL（システム作成）。created_at/updated_at/installed_at は DB 既定 now()。
 * ★ ログにもエラーにも DATABASE_URL を出さない（device MAC は ADR-020 上 PII でなく公開シードにも載るため出力可）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない）
 * drizzle schema barrel は pgvector 経由で `@kimiterrace/ai` に推移依存し migrate イメージで
 * ERR_MODULE_NOT_FOUND になるため、`postgres` の生 SQL で書く（migrate-cli / seed-staging-cli と同じ）。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL_NAME;
const DEPARTMENT_NAME = process.env.SEED_GINAN_DEPARTMENT_NAME ?? GINAN_ECE_DEPARTMENT_NAME;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  // DB に触れる前に配列の自己整合性を検証（MAC 正規形・一意・ラベル長）。
  validateGinanSeedDevices(GINAN_ECE_SENSOR_DEVICES);

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  const perDevice: Array<{ grade: number; deviceMac: string; class: string; action: string }> = [];
  let inserted = 0;
  let skipped = 0;
  // 解決した tenant を成功ログに出して可査性を担保する（schools.name は一意でないため）。
  let resolvedSchoolId: string | undefined;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で system_admin_full_access policy を通すため system_admin context を張る（tx スコープ）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // 学校（テナント）を名前で解決。見つからなければ fail-loud（孤児センサーを作らない）。
      const schoolRows = await tx<{ id: string }[]>`
        SELECT id FROM schools WHERE name = ${SCHOOL_NAME} ORDER BY created_at ASC LIMIT 1`;
      const schoolId = schoolRows[0]?.id;
      if (!schoolId) {
        throw new Error(
          `school not found by name: ${SCHOOL_NAME}（先に学校レコードを作成してください）`,
        );
      }
      resolvedSchoolId = schoolId;

      for (const d of GINAN_ECE_SENSOR_DEVICES) {
        // class 紐づけは best-effort: 電子工学科（departments）→ 学年（grades）→ クラス（classes）を辿り、
        // 当該学年のクラスが一意に決まる時のみ紐づける。0/複数件は NULL（location_label が文脈を保持）。
        const classRows = await tx<{ id: string }[]>`
          SELECT c.id
          FROM classes c
          JOIN grades g ON c.grade_id = g.id
          JOIN departments dep ON g.department_id = dep.id
          WHERE c.school_id = ${schoolId}
            AND g.school_id = ${schoolId}
            AND dep.school_id = ${schoolId}
            AND dep.name = ${DEPARTMENT_NAME}
            AND c.grade = ${d.grade}`;

        let classId: string | null = null;
        let classNote: string;
        const onlyClass = classRows.length === 1 ? classRows[0] : undefined;
        if (onlyClass) {
          classId = onlyClass.id;
          classNote = "linked";
        } else if (classRows.length > 1) {
          classNote = `ambiguous(${classRows.length})->null`;
        } else {
          classNote = "no-class->null";
        }

        // device_mac はグローバル一意（ux_sensor_devices_device_mac）。既存は DO NOTHING で温存（冪等）。
        const ins = await tx<{ id: string }[]>`
          INSERT INTO sensor_devices (school_id, device_mac, location_label, class_id)
          VALUES (${schoolId}, ${d.deviceMac}, ${d.locationLabel}, ${classId})
          ON CONFLICT (device_mac) DO NOTHING
          RETURNING id`;

        if (ins.length === 1) {
          inserted++;
          perDevice.push({
            grade: d.grade,
            deviceMac: d.deviceMac,
            class: classNote,
            action: "inserted",
          });
        } else {
          skipped++;
          perDevice.push({
            grade: d.grade,
            deviceMac: d.deviceMac,
            class: classNote,
            action: "skipped(exists)",
          });
        }
      }
    });

    // 識別子・件数のみ（DATABASE_URL は出さない。device MAC は ADR-020 上 PII でない）。
    console.log(
      JSON.stringify({
        event: "seed.ginan.sensors.done",
        schoolName: SCHOOL_NAME,
        schoolId: resolvedSchoolId,
        department: DEPARTMENT_NAME,
        inserted,
        skipped,
        total: GINAN_ECE_SENSOR_DEVICES.length,
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
