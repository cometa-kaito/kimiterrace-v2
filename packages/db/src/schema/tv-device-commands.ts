import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { tvCommandStatus, tvCommandType } from "../_shared/enums.js";
import { schools } from "./schools.js";
import { tvDevices } from "./tv-devices.js";

/**
 * F15 (ADR-022): TV デバイスへの **リモートコマンドキュー**テーブル。
 *
 * ## 役割（ポーリング型・send-once）
 * 管理者が UI から「サイネージリロード」「強制起動」「強制終了」「サービス再起動」を発行すると、本表に
 * 1 行 INSERT される（`status='pending'`）。TV は ADR-022 のポーリング（`GET /api/tv/config`、60 秒間隔）
 * で**自分宛の pending コマンドを pull** し、実行後に ack（`POST /api/tv/commands/ack`）で `delivered` に
 * 落とす。サーバ → TV へは一度も能動接続しない（ADR-022: 学校 Wi-Fi はアウトバウンドのみ許可が多い）。
 *
 * ## ライフサイクル
 *  1. **発行**: 管理者操作で `status='pending'`、`issued_at=now()`、`issued_by`=actor。
 *  2. **配信 + ack（冪等）**: TV がポーリングで pending を受領 → 実行 → ack で `status='delivered'` +
 *     `acknowledged_at=now()`。ack は **冪等**: 既に delivered の行を再 ack しても二重遷移しない
 *     （pending → delivered の 1 方向のみ。再送・タイミング競合でも安全）。
 *  3. **失効（本スライス非実装）**: `expires_at` 超過で配信されないまま `expired` に落とす掃除ジョブは
 *     follow-up（Cloud Run Job/Scheduler、ルール8）。本スライスは列のみ用意し、poll は expires_at が
 *     未来 or NULL の pending のみ配信する。
 *
 * ## device_id 参照（tv_devices.device_id への FK、ポーリング解決軸）
 * F15 §1 に従い `tv_devices.device_id`（グローバル UNIQUE）を FK 参照する。ポーリングは device_id 軸で
 * TV を識別するため、コマンドキューも device_id で「どの端末宛か」を辿る（tv_device_downtime と同方針）。
 * UNIQUE 列なので FK 先として有効。デバイス退役（ソフトデリート）後もコマンド履歴を監査保全するため
 * 削除カスケードはしない（restrict）。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。`tv_devices.school_id` から継承して INSERT する（F15 §1）。
 * RLS は migrations/0019_tv_device_commands_rls.sql で tenant_isolation（school_id 一致）+
 * system_admin_full_access を付与する（0016_tv_devices_rls.sql と同一パターン）。発行（管理 UI）は自校
 * テナント context（system_admin はテナントスコープで school_admin に降格）。配信/ack（ポーリング経路）は
 * セッション無しのため `system_admin` role context で cross-tenant 解決し、解決 school_id を pin する
 * （recordPresenceEvent / pollTvConfig と同じ ADR-019 二層 RLS、BYPASSRLS 不使用、ルール2）。
 *
 * ## PII 非格納（ルール4）
 * 個人を識別する情報を入れない。`params_json` はコマンド引数の機械メタのみ（リロード対象 URL 等の設定値）、
 * 生徒名・保護者名等を入れてはならない。ポーリング応答に載せる payload も最小限（id + command + params）。
 *
 * ## 監査（ルール1 / NFR04）
 * `auditColumns` を付与。コマンド発行は対象テーブル操作として既存 `audit_log` に 1 件残す（F15 §1/§5。
 * 新規列を作らず NFR04 ハッシュチェーンに寄せる）。created_by/updated_by → users(id) の FK は循環依存
 * 回避のため migrations/0019 で後付けする（_shared/audit.ts と 0004/0006/0014/0016/0018 と同じパターン）。
 * ack（ポーリング経路）は actor=null（システム）で監査せず status 遷移のみ（心拍 touch と同じく高頻度・
 * 設定変更ではないため。F15 §1 の監査対象は「設定変更・コマンド発行・削除」= 発行のみ）。
 *
 * 関連: ADR-022（ポーリング）, F15 §1/§4.2/§5, ADR-019（RLS 二層）。
 * 非スコープ（本スライス）: 失効掃除ジョブ（Cloud Run Job/Scheduler、ルール8）/ reboot 等の追加コマンド
 *   種別（末尾 ADD VALUE で拡張）/ 配信失敗（failed）の ack 経路（列のみ予約）。
 */
export const tvDeviceCommands = pgTable(
  "tv_device_commands",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 対象 TV の device_id（tv_devices.device_id はグローバル UNIQUE、FK 先として有効）。退役後も
    // コマンド履歴を残すため親削除は restrict（キュー行を残したまま端末行を消させない）。
    deviceId: text("device_id")
      .notNull()
      .references(() => tvDevices.deviceId, { onDelete: "restrict" }),
    // テナント分離キー。発行時に tv_devices.school_id から継承して明示 INSERT する。学校削除は restrict。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // コマンド種別（signage_reload / signage_open / signage_exit / service_restart）。値域は enum で固定。
    command: tvCommandType("command").notNull(),
    // コマンド引数（任意・機械メタのみ、PII 非格納）。例: signage_reload の対象 URL 上書き等。NULL = 引数なし。
    paramsJson: jsonb("params_json"),
    // ライフサイクル状態。既定 pending（発行直後・未配信）。配信で delivered、失効で expired。
    status: tvCommandStatus("status").notNull().default("pending"),
    // 発行（エンキュー）時刻。発行者は issued_by（監査 actor とも一致）。
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // 発行者（users.id）。システム発行は将来 null 可だが本スライスは管理者発行のみ。FK は 0019 で後付け。
    issuedBy: uuid("issued_by"),
    // TV が受領（ack）した時刻。配信前は NULL。冪等 ack: pending → delivered の 1 回だけセットする。
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "date" }),
    // 失効期限（任意）。NULL = 無期限。掃除ジョブ（本スライス非実装）が超過 pending を expired に落とす。
    // poll 配信は expires_at が未来 or NULL の pending のみ返す（期限切れを配信しない）。
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    ...auditColumns,
  },
  (t) => ({
    // 「この TV 宛の pending コマンドはあるか」をポーリングが引く（device_id + status の複合）。
    ixDeviceStatus: index("ix_tv_device_commands_device_status").on(t.deviceId, t.status),
    // school 別のコマンド履歴一覧（管理 UI / 監査）。
    ixSchool: index("ix_tv_device_commands_school").on(t.schoolId),
  }),
);
