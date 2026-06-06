import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { type BackfillPresenceRow, parseBackfillNdjson } from "./backfill-presence.js";

/**
 * F13 (#391, ADR-020): PoC 本番（LP / Turso `motion_events`）の来場検知履歴を v2 `events`(type='presence')
 * へ **冪等に取り込む（backfill）実行エントリ**。パース/正規化は backfill-presence.ts、入力データ（実イベント）は
 * 同梱の NDJSON（`_kt_backfill_data.ndjson`、未コミットの build-context ファイル＝学校の在室時刻を公開リポジトリに
 * 残さないため）。
 *
 * ## 取り込みロジック（webhook ingest と同一の安全則を生 SQL で再現）
 * `sensor-presence.ts recordPresenceEvent` と同じく:
 *   1. `system_admin` role context（FORCE RLS 下で `system_admin_full_access` / `audit_log_insert` を通す）。
 *   2. device_mac（正規形）→ school_id/class_id を **cross-tenant 解決**（device_mac はグローバル UNIQUE）。
 *      未登録 device（テスト機等）は skip（unknown_device、events に書かない）。
 *   3. `events`(type='presence') に **occurred_at=元の検知時刻**で INSERT、`ON CONFLICT DO NOTHING`
 *      （部分 UNIQUE `ux_events_presence_dedup` = (school_id, payload->>'device_mac', occurred_at)）。
 *      → 何度実行しても重複しない（冪等）。webhook で既に入った分や、cutover 後の再実行とも自然に合流。
 *   4. 取り込み後に **一括監査ログ**を1件記録（ルール1: bulk operation は record_id=null 可）。件数のみ・PII なし。
 *
 * ## 実行
 * - staging: migrate イメージに本 CLI + NDJSON を含めて build し、Cloud Run Job の command 上書きで起動
 *   （`command=["node","dist/backfill-presence-cli.js"]`、seed Job と同パターン）。DATABASE_URL=migrator DSN。
 *
 * ## 秘密（ルール5）/ PII（ルール4）
 * DATABASE_URL はログ・エラーに出さない。payload/監査は device/検知メタ + 時刻のみ（個人識別情報なし）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない）
 * barrel は pgvector 経由で `@kimiterrace/ai` に推移依存し migrate イメージで壊れるため、`postgres` の生 SQL
 * で書く（seed-staging-cli / seed-ginan-sensors-cli と同じ）。
 */

const DATA_PATH =
  process.env.BACKFILL_DATA_PATH ??
  fileURLToPath(new URL("../_kt_backfill_data.ndjson", import.meta.url));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  let text: string;
  try {
    text = readFileSync(DATA_PATH, "utf8");
  } catch {
    console.error(`backfill data file not found: ${DATA_PATH}`);
    process.exit(1);
    return;
  }
  const rows: BackfillPresenceRow[] = parseBackfillNdjson(text);
  if (rows.length === 0) {
    console.error("backfill data file has 0 valid rows");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  let recorded = 0;
  let duplicate = 0;
  let unknownDevice = 0;
  let resolvedSchoolId: string | null = null;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で system_admin policy（system_admin_full_access / audit_log_insert）を通す。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      for (const row of rows) {
        // device_mac（正規形）→ school_id/class_id を解決。表記ゆれ吸収のため保存値も正規化して照合。
        // decommissioned は計上しない（recordPresenceEvent と同則）。未登録は skip。
        const dev = await tx<{ school_id: string; class_id: string | null }[]>`
          SELECT school_id, class_id
          FROM sensor_devices
          WHERE upper(replace(replace(device_mac, ':', ''), '-', '')) = ${row.deviceMac}
            AND decommissioned_at IS NULL
          LIMIT 1`;
        const resolved = dev[0];
        if (!resolved) {
          unknownDevice++;
          continue;
        }
        resolvedSchoolId = resolved.school_id;

        // events(type='presence') に元の検知時刻で INSERT。type は enum リテラル、occurred_at は ms→timestamptz
        // を DB 側変換（JS Date を bind しない）。payload は JSON.stringify + ::jsonb（sql.json 罠回避）。
        const payload = JSON.stringify({
          source: "switchbot",
          device_mac: row.deviceMac,
          detection_state: row.detectionState,
          time_of_sample_ms: row.occurredAtMs,
          event_version: null,
          class_id: resolved.class_id,
          backfill: true,
        });
        const ins = await tx<{ id: string }[]>`
          INSERT INTO events (school_id, type, occurred_at, payload)
          VALUES (
            ${resolved.school_id},
            'presence',
            to_timestamp(${row.occurredAtMs}::double precision / 1000),
            ${payload}::jsonb
          )
          ON CONFLICT DO NOTHING
          RETURNING id`;
        if (ins[0]) {
          recorded++;
        } else {
          duplicate++;
        }
      }

      // 一括監査ログ（ルール1）。bulk op ゆえ record_id=null。actor=null（システム）。件数のみ（PII なし）。
      // row_hash は append-only ハッシュチェーントリガが計算（"" を上書き）。
      await tx`
        INSERT INTO audit_log (actor_user_id, school_id, table_name, record_id, operation, diff, row_hash)
        VALUES (
          NULL,
          ${resolvedSchoolId},
          'events',
          NULL,
          'insert',
          ${JSON.stringify({
            event: "presence_backfill",
            source: "lp_turso_motion_events",
            recorded,
            duplicate,
            unknown_device: unknownDevice,
            total: rows.length,
          })}::jsonb,
          ''
        )`;
    });

    console.log(
      JSON.stringify({
        event: "backfill.presence.done",
        schoolId: resolvedSchoolId,
        recorded,
        duplicate,
        unknownDevice,
        total: rows.length,
      }),
    );
  } catch (err) {
    // postgres driver 例外。DSN は含まない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
