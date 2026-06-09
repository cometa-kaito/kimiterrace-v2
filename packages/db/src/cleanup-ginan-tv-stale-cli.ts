import postgres from "postgres";
import { GINAN_SCHOOL_NAME } from "./seed-ginan-tv-devices.js";

/**
 * 岐南 TV デバイスの **重複/陳腐化行クリーンアップ**（一回限りの運用スクリプト）。
 *
 * ## 背景
 * 2026-06-09 の現地プロビジョニングで、各クラス(電子工学科 1〜3 年)の `tv_devices` に
 * 実機の新 device_id を登録した結果、過去の **プレースホルダ行**（staging 既定 device_id）と
 * **旧 PoC 機の device_id** が応答なし(🔴)のゴミ行として残った（1 クラスにつき複数行）。
 * 本 CLI は「稼働中の実機 device_id（KEEP）以外の岐南 tv_devices」を **ソフト削除**(`deleted_at`)し、
 * KEEP 行のスケジュールを **表示開始時=7時** に揃える。
 *
 * ## 安全設計（誤爆防止）
 * - **KEEP device_id は env `CLEANUP_GINAN_TV_KEEP_DEVICE_IDS`（JSON 配列）で明示必須**。
 *   未指定/空なら **fail-loud で中断**（staging 等で「KEEP 以外を全削除」する事故を防ぐ）。
 * - スコープは **岐南（schools.name）の tv_devices に限定**（他校に触れない）。
 * - **ソフト削除のみ**（`deleted_at` を立てる＝可逆。物理 DELETE はしない）。
 * - 冪等: 既に `deleted_at` のものは対象外。再実行で多重に消さない。
 *
 * ## RLS（ルール2）/ 監査（ルール1）
 * 接続は migrator DSN(`DATABASE_URL`)。tx 内で `set_config('app.current_user_role','system_admin', true)`
 * を張り `system_admin_full_access` policy 経由で書く（seed-ginan-tv-devices-cli と同作法）。
 * 監査は監査カラム(`updated_at`/`deleted_at`)＋本コミット(スクリプト)＋実行ログ(JSON)で担保。
 *
 * ## 実行方法
 * migrate と同一イメージに同梱し、Cloud Run Job の command 上書きで起動:
 *   `command=["node","dist/cleanup-ginan-tv-stale-cli.js"]`
 *   env: `DATABASE_URL`（Secret）, `CLEANUP_GINAN_TV_KEEP_DEVICE_IDS`(JSON), 任意 `CLEANUP_GINAN_TV_ON_HOUR`(既定 7)
 * ★ ログにも例外にも DATABASE_URL を出さない（device_id は PII でないため出力可）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない＝migrate イメージで pgvector 推移依存を避ける）。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL_NAME;
const ON_HOUR = Number(process.env.CLEANUP_GINAN_TV_ON_HOUR ?? "7");

/** KEEP（残す＝稼働中実機）device_id を env から厳格パース。未指定/空/不正は fail-loud。 */
function parseKeepDeviceIds(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "CLEANUP_GINAN_TV_KEEP_DEVICE_IDS (JSON array of device_id to KEEP) is required. " +
        "未指定での実行は禁止（KEEP 以外を全ソフト削除する事故防止）。",
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

  const keepIds = parseKeepDeviceIds(process.env.CLEANUP_GINAN_TV_KEEP_DEVICE_IDS); // fail-loud before DB

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let exitCode = 0;
  let softDeleted: string[] = [];
  let rescheduled: string[] = [];
  let schoolId: string | undefined;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で system_admin_full_access policy を通す（tx スコープ）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // 岐南（テナント）解決。無ければ fail-loud（他校に触れないため必須）。
      const schoolRows = await tx<{ id: string }[]>`
        SELECT id FROM schools WHERE name = ${SCHOOL_NAME} ORDER BY created_at ASC LIMIT 1`;
      schoolId = schoolRows[0]?.id;
      if (!schoolId) {
        throw new Error(`school not found by name: ${SCHOOL_NAME}`);
      }

      // ① ソフト削除: 岐南スコープ・未削除・KEEP 以外。RETURNING で実際に消した device_id を確認。
      const del = await tx<{ deviceId: string }[]>`
        UPDATE tv_devices
        SET deleted_at = now(), updated_at = now()
        WHERE school_id = ${schoolId}
          AND deleted_at IS NULL
          AND device_id <> ALL(${keepIds}::text[])
        RETURNING device_id AS "deviceId"`;
      softDeleted = del.map((r) => r.deviceId);

      // ② KEEP 行のスケジュール表示開始時を ON_HOUR に（jsonb マージ。未削除のみ）。
      const upd = await tx<{ deviceId: string }[]>`
        UPDATE tv_devices
        SET schedule_json = COALESCE(schedule_json, '{}'::jsonb) || ${JSON.stringify({ onHour: ON_HOUR })}::jsonb,
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
