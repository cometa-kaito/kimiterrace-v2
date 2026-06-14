import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { tvProvisioningStatus } from "../_shared/enums.js";
import { classes } from "./classes.js";
import { schools } from "./schools.js";
import { tvDevices } from "./tv-devices.js";

/**
 * C方式 TV プロビジョニングの **ジョブテーブル**（クラウド UI でジョブ作成 → 現地ローカルエージェントが
 * claim → adb 一連を実行 → ステップ毎に status 報告）。
 *
 * ## 役割（ハイブリッド: クラウド UI × ローカルエージェント）
 * adb は「TV と同じ校内 LAN 上の機械」でしか実行できず、v2 は Cloud Run（クラウド）。よって本表を
 * 介して非同期に橋渡しする。`/ops/tv-devices/provision` の Server Action が tv_devices 行を事前作成 +
 * signage_url を発行した上で pending ジョブを 1 件 INSERT する。設置作業中だけ起動する現地ノート PC の
 * `node provision-agent.js` が `POST /api/tv/provisioning/claim` で 1 件 claim → 手元で adb を実行 →
 * `POST /api/tv/provisioning/:id/status` で各ステップを報告する。
 *
 * ## 段階ワークフロー（status enum、破壊的操作の前に必ずキャプチャ）
 *  pending → claimed → preflight（県Wi-Fi 設定キャプチャ）→ awaiting_physical（人手の reset/再接続を依頼）
 *  → provisioning（install / Device Owner / オフタイマー無効 / prefs 注入 / 起動）→ succeeded / failed。
 *
 * ## 秘密非格納（ルール5）
 * `prod-tv-poll-secret` 等の鍵は **ジョブに載せない**。エージェントが Secret Manager から取得して prefs に
 * 注入する。本表が持つのは非秘密パラメータ（device_id / signage_url / schedule / target_mac / target_ip）と
 * ステップ結果ログ（`steps_json`、PII・秘密非格納）のみ。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。作成は system_admin（cross-tenant 操作、ONBOARDING_ROLES）。RLS は
 * migrations/0021_tv_provisioning_jobs_rls.sql で tenant_isolation（school_id 一致）+ system_admin_full_access
 * を付与（0016_tv_devices_rls.sql と同一パターン）。claim / status 報告（エージェント API、セッション無し）は
 * `system_admin` role context で cross-tenant 解決する（pollTvConfig / tv_device_commands と同方針、BYPASSRLS
 * 不使用）。
 *
 * ## 監査（ルール1 / NFR04）
 * `auditColumns` を付与。ジョブ作成は `audit_log` に 1 件残す（createProvisioningJob、writeCreateAudit と同形）。
 * claim / status 遷移は高頻度かつ設定変更でないため監査せず `steps_json` に履歴を残す（ack / 心拍 touch と
 * 同方針）。created_by / updated_by → users(id) の FK は循環依存回避のため migrations/0021 で後付けする。
 *
 * 関連: 承認済み計画（C方式 TV プロビジョニング）, ADR-022（ポーリング）, ADR-019（RLS 二層）。
 */
export const tvProvisioningJobs = pgTable(
  "tv_provisioning_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // テナント分離キー。フォームで選択した設置先の学校。学校削除は restrict（ジョブ履歴を残す）。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 設置クラス（任意・サイネージ文脈/ラベル用）。クラス削除でこの紐付けのみ外す（set null、school_id は不変）。
    classId: uuid("class_id").references(() => classes.id, { onDelete: "set null" }),
    // 事前作成した tv_devices 行（PK）。デバイス退役（削除）後もジョブ履歴を残すため set null。
    tvDeviceRowId: uuid("tv_device_row_id").references(() => tvDevices.id, {
      onDelete: "set null",
    }),
    // 対象 TV の device_id（事前作成時は採番済、reset で再生成される実機 UUID を後で報告し上書きしうる）。
    deviceId: text("device_id"),
    // 現地 LAN 上の TV の IP（`adb connect <ip>:5555` 用）。任意（USB 接続時は空）。
    targetIp: text("target_ip"),
    // 段階ワークフローの状態（enum）。既定 pending（未 claim）。
    status: tvProvisioningStatus("status").notNull().default("pending"),
    // 直近ステップの人間可読ラベル（UI のライブ進捗表示用）。
    currentStep: text("current_step"),
    // ステップ毎の結果ログ（jsonb 配列）。秘密・PII 非格納（鍵やキャプチャ生値は載せない）。
    stepsJson: jsonb("steps_json"),
    // 発行済みサイネージ表示 URL（`<base>/signage/<token>`）。token plaintext は本列のみ、DB の hash は magic_links。
    signageUrl: text("signage_url"),
    // 表示スケジュール（enabled / on_hour / off_hour / 曜日 bitmask）。tv_devices.schedule_json と同形。
    scheduleJson: jsonb("schedule_json"),
    // 県教委 Wi-Fi の固定 MAC（reset 安全判定の基準。factory-mac 比較に使う）。
    targetMac: varchar("target_mac", { length: 32 }),
    // 失敗時のエラー要約（UI 表示・トラブルシュート用）。
    error: text("error"),
    // claim したエージェント識別子（status 報告の認可キーにも使う = claim したエージェントのみ報告可）。
    claimedBy: text("claimed_by"),
    // claim 時刻。
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    // 失効期限（任意・将来の掃除ジョブ用）。NULL = 無期限。
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    ...auditColumns,
  },
  (t) => ({
    // エージェントの claim（status='pending' を古い順に 1 件）が引く。
    ixStatus: index("ix_tv_provisioning_jobs_status").on(t.status),
    // school 別のジョブ一覧（管理 UI / 監査）。
    ixSchool: index("ix_tv_provisioning_jobs_school").on(t.schoolId),
    // device_id 軸の照会。
    ixDevice: index("ix_tv_provisioning_jobs_device").on(t.deviceId),
  }),
);
