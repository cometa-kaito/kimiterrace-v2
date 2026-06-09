import postgres from "postgres";
import { GINAN_SCHOOL_NAME, GINAN_TV_DEFAULT_SCHEDULE } from "./seed-ginan-tv-devices.js";

/**
 * 岐南 TV デバイスの **重複/陳腐化行クリーンアップ**（一回限りの運用スクリプト）。
 *
 * ## 背景
 * 2026-06-09 の現地プロビジョニングで各クラス(電子工学科 1〜3 年)の `tv_devices` に実機の新 device_id を
 * 登録した結果、過去の **プレースホルダ行**(staging 既定 device_id)と **旧 PoC 機 device_id** が
 * 応答なし(🔴)のゴミ行として残った。本 CLI は「稼働中の実機 device_id(KEEP)以外の岐南 tv_devices」を
 * **ソフト削除**(`deleted_at`)し、KEEP 行のスケジュールを **既定(平日 ON_HOUR–17:00)** に SET する。
 *
 * ## 安全設計（誤爆防止）
 * - **KEEP device_id は env `CLEANUP_GINAN_TV_KEEP_DEVICE_IDS`(JSON 配列)で明示必須**。未指定/空は fail-loud。
 * - スコープは **岐南(schools.name)の tv_devices に限定**（他校に触れない）。
 * - **ソフト削除のみ**(`deleted_at`＝可逆。物理 DELETE なし)。冪等(既 deleted は対象外)。
 *
 * ## スケジュール更新（②）は full SET（マージしない）
 * jsonb `||` マージは postgres@3 経由で既存キー(enabled/offHour/weekdays)を失う挙動を実測したため、
 * seed-ginan-tv-devices-cli と同じ **full SET**（`GINAN_TV_DEFAULT_SCHEDULE` を基底に onHour だけ上書き）にする。
 *
 * ## RLS(ルール2)/ 監査(ルール1)
 * migrator DSN(`DATABASE_URL`)接続。tx 内で `set_config('app.current_user_role','system_admin', true)` を張り
 * `system_admin_full_access` policy 経由で書く。監査は監査カラム(`updated_at`/`deleted_at`)＋本コミット＋実行ログ。
 *
 * ## 実行方法
 * migrate と同一イメージに同梱し Cloud Run Job の command 上書きで起動:
 *   `command=["node","dist/cleanup-ginan-tv-stale-cli.js"]`
 *   env: `DATABASE_URL`(Secret), `CLEANUP_GINAN_TV_KEEP_DEVICE_IDS`(JSON), 任意 `CLEANUP_GINAN_TV_ON_HOUR`(既定 7)
 * ★ ログにも例外にも DATABASE_URL を出さない(device_id は PII でない)。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL_NAME;
const ON_HOUR = Number(process.env.CLEANUP_GINAN_TV_ON_HOUR ?? "7");

/** KEEP(残す＝稼働中実機)device_id を env から厳格パース。未指定/空/不正は fail-loud。 */
function parseKeepDeviceIds(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "CLEANUP_GINAN_TV_KEEP_DEVICE_IDS (JSON array of device_id to KEEP) is required. 未指定での実行は禁止。",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CLEANUP_GINAN_TV_KEEP_DEVICE_IDS must be a JSON array of strings");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((x) => typeof x === "string" && x.length > 0)
  ) {
    throw new Error(
      "CLEANUP_GINAN_TV_KEEP_DEVICE_IDS must be a non-empty JSON array of non-empty strings",
    );
  }
  return parsed as string[];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  if (!Number.isInteger(ON_HOUR) || ON_HOUR < 0 || ON_HOUR > 23) {
    console.error("CLEANUP_GINAN_TV_ON_HOUR must be an integer in 0..23");
    process.exit(1);
  }

  const keepIds = parseKeepDeviceIds(process.env.CLEANUP_GINAN_TV_KEEP_DEVICE_IDS);

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let exitCode = 0;
  let softDeleted: string[] = [];
  let rescheduled: string[] = [];
  let schoolId: string | undefined;

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      const schoolRows = await tx<{ id: string }[]>`
        SELECT id FROM schools WHERE name = ${SCHOOL_NAME} ORDER BY created_at ASC LIMIT 1`;
      schoolId = schoolRows[0]?.id;
      if (!schoolId) {
        throw new Error(`school not found by name: ${SCHOOL_NAME}`);
      }

      // ① ソフト削除: 岐南スコープ・未削除・KEEP 以外。
      const del = await tx<{ deviceId: string }[]>`
        UPDATE tv_devices
        SET deleted_at = now(), updated_at = now()
        WHERE school_id = ${schoolId}
          AND deleted_at IS NULL
          AND device_id <> ALL(${keepIds}::text[])
        RETURNING device_id AS "deviceId"`;
      softDeleted = del.map((r) => r.deviceId);

      // ② KEEP 行のスケジュールを full SET(既定の平日 ON_HOUR–17:00)。マージは使わない。
      const scheduleJson = JSON.stringify({ ...GINAN_TV_DEFAULT_SCHEDULE, onHour: ON_HOUR });
      const upd = await tx<{ deviceId: string }[]>`
        UPDATE tv_devices
        SET schedule_json = ${scheduleJson}::jsonb,
            updated_at = now()
        WHERE school_id = ${schoolId}
          AND deleted_at IS NULL
          AND device_id = ANY(${keepIds}::text[])
        RETURNING device_id AS "deviceId"`;
      rescheduled = upd.map((r) => r.deviceId);
    });

    console.log(
      JSON.stringify({
        event: "cleanup.ginan.tv-stale.done",
        schoolName: SCHOOL_NAME,
        schoolId,
        keepCount: keepIds.length,
        softDeleted,
        softDeletedCount: softDeleted.length,
        rescheduled,
        onHour: ON_HOUR,
      }),
    );
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
