import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { tvDowntimeCause } from "../_shared/enums.js";
import { schools } from "./schools.js";
import { tvDevices } from "./tv-devices.js";

/**
 * F16 (ADR-023): TV デバイスの **ダウンタイム（無応答インシデント）記録**テーブル。
 *
 * ## 役割
 * 定期チェッカ（`apps/jobs` の死活ジョブ）が `tv_devices.last_seen_at` のギャップで down 判定したとき、
 * 「いつ落ちたか・いつ復帰したか・何秒落ちていたか」を 1 インシデント = 1 行で残す。F16 受け入れ条件
 * §1 / §5（稼働率・ダウンタイム履歴表示）の単一ソース。
 *
 * ## ライフサイクル（チェッカが 1 分間隔で走査）
 *  1. **down 遷移**: `now - last_seen_at > 閾値` かつ `monitoring_enabled` の TV を検出したら、
 *     `recovered_at IS NULL` の未解決行が無い場合に限り 1 行 INSERT する（`went_down_at` = 最後の
 *     `last_seen_at`、`recovered_at`/`duration_sec` は NULL）。同時に `tv_devices.alert_state='down'`。
 *  2. **継続中（down→down）**: 既に未解決行があれば **何もしない**（idempotent / send-once、F16 §2）。
 *     再走査で同一アウテージを二重計上しない。
 *  3. **recover 遷移**: `last_seen_at` が閾値内に戻ったら、未解決行を `recovered_at` = 復帰観測時刻、
 *     `duration_sec` = recovered_at - went_down_at（秒）で締め、`tv_devices.alert_state='ok'`。
 *
 * ## なぜ duration_sec を「保存」するか（派生だが格納）
 * `recovered_at - went_down_at` から都度算出もできるが、稼働率レポート（F16 §5、F08 連携）が大量行を
 * 集計するため、復帰時に 1 度だけ確定して格納する（recovered_at が NULL の継続中行は duration_sec も
 * NULL = 「まだ計測中」を表現できる）。未解決行は `recovered_at IS NULL` で一意に識別する。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は migrations/0018_tv_device_downtime_rls.sql で
 * tenant_isolation（school_id 一致）+ system_admin_full_access を付与する（0016_tv_devices_rls.sql と
 * 同一パターン）。チェッカは全校横断で走るため `system_admin` role context で INSERT/UPDATE し、
 * 解決した school_id を pin する（BYPASSRLS 不使用、ルール2）。school_admin は自校のダウン履歴のみ閲覧。
 *
 * ## device_id 参照（tv_devices.device_id への FK）
 * F16 受け入れ条件 §1 に従い `tv_devices.device_id`（グローバル UNIQUE）を FK 参照する。`tv_devices.id`
 * でなく device_id を持つのは、ポーリング/起動報告が device_id 軸で TV を識別し、ダウンタイム履歴も
 * 「どの端末か」を device_id で辿るため。UNIQUE 列なので FK 先として有効。デバイス退役（ソフトデリート）
 * 後も死活履歴は保全する必要があるため、削除カスケードはしない（restrict）。
 *
 * ## PII 非格納（ルール4）
 * 個人を識別する情報を入れない。`cause_hint` は機械推定の列挙値のみ、`notes` は運用メモ（PII を入れない）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。チェッカ書き込みは created_by/updated_by = null（システム = `system://
 * tv-health-check`）。created_by/updated_by → users(id) の FK は循環依存回避のため migrations/0018 で
 * 後付けする（_shared/audit.ts と 0004/0006/0014/0016 と同じパターン）。
 *
 * 関連: ADR-023（死活監視方式）, ADR-022（ポーリング）, F16 §1/§2/§5, ADR-019（RLS 二層）。
 * 非スコープ（本スライス）: Cloud Run Job + Cloud Scheduler の Terraform 配線（ルール8、未作成 #94）/
 *   アラート配信チャネル（メール/Slack 等、F16 §4 — チャネル設計 + シークレット決定が要る）/ 管理 UI の
 *   稼働率・履歴表示（F16 §5、apps/web レーン）。本スライスは「テーブル + ギャップ判定ロジック +
 *   状態遷移 + ダウンタイム記録 + テスト」。
 */
export const tvDeviceDowntime = pgTable(
  "tv_device_downtime",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 対象 TV の device_id（tv_devices.device_id はグローバル UNIQUE、FK 先として有効）。退役後も
    // 死活履歴を残すため親削除は restrict（インシデント行を残したまま端末行を消させない）。
    deviceId: text("device_id")
      .notNull()
      .references(() => tvDevices.deviceId, { onDelete: "restrict" }),
    // テナント分離キー。チェッカが down 判定した TV の school_id を pin する。学校削除時は restrict。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // ダウン判定の基準時刻 = 最後に観測した last_seen_at（「ここから無応答」の起点）。
    wentDownAt: timestamp("went_down_at", { withTimezone: true, mode: "date" }).notNull(),
    // 復帰観測時刻（ポーリング再開を検出したチェッカ実行時刻）。継続中は NULL。
    recoveredAt: timestamp("recovered_at", { withTimezone: true, mode: "date" }),
    // ダウン継続秒数（recovered_at - went_down_at）。復帰時に確定して格納。継続中は NULL。
    durationSec: integer("duration_sec"),
    // 原因の機械推定（復帰時に起動報告 last_boot_at と突合）。確定できなければ unknown / NULL。
    causeHint: tvDowntimeCause("cause_hint"),
    // 運用メモ（任意・自由文字列）。★ PII を入れない。
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => ({
    // 「この TV の未解決インシデントはあるか / 履歴一覧」を引く（down→down idempotency 判定 + §5 表示）。
    ixDevice: index("ix_tv_device_downtime_device").on(t.deviceId),
    // school 別のダウンタイム履歴一覧（管理 UI / 稼働率レポート）。
    ixSchool: index("ix_tv_device_downtime_school").on(t.schoolId),
  }),
);
