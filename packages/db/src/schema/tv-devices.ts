import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { tvAlertState } from "../_shared/enums.js";
import { classes } from "./classes.js";
import { departments } from "./departments.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * F15 / F16 (ADR-022 / ADR-023): 教室設置の Google TV（自作 Android アプリ
 * `com.kimiterrace.tvbridge` 稼働）のリモート設定レジストリ兼 死活心拍テーブル。
 *
 * ## 役割 — 1 テーブルで F15 と F16 の土台を兼ねる
 * - **F15（ポーリング設定配信、ADR-022）**: TV が 60 秒ごとに `GET /api/tv/config?device_id=...&key=...`
 *   を叩き、本テーブルの設定フィールド（`signage_url` / `target_mac` / `schedule_json` / `version`）を
 *   pull する。サーバ → TV へは一度も能動接続しない（学校 Wi-Fi はアウトバウンドのみ許可が多い）。
 *   設定変更のたび `version` を +1（monotonic）し、TV は版差分時のみ反映する。
 * - **F16（死活監視、ADR-023）**: 上記ポーリングが更新する `last_seen_at` の鮮度が**そのまま死活信号**
 *   になる。定期チェッカ（別スライス）が `now - last_seen_at > 閾値` で down 判定する。新たな常時接続
 *   （WebSocket 等）は張らない。`alert_state` は重複通知抑止のための状態フラグ（F16 §2）。
 *
 * ## なぜ sensor_devices（F13）と別テーブルか（重複でない）
 * `sensor_devices`（F13, ADR-020）は **BLE/PIR 人感センサー**の物理 MAC レジストリで webhook 解決専用。
 * 本テーブルは **Google TV 端末**そのもののリモート設定 + ポーリング心拍であり、識別子・ライフサイクル
 * （設定版管理・死活）・運用 UI がまったく異なる。F15 §1 が新規 `tv_devices` を明示的に要求しており、
 * sensor_devices の拡張では設計が破綻する（TV は MAC で解決されず device_id で識別、設定 pull が中核）。
 * なお TV 経由で来た presence を将来 `events.tv_device_id` で紐付ける拡張は F15 §1 にあるが、本基盤
 * スライスでは events 非接触（follow-up）。
 *
 * ## device_id のグローバル一意性（ポーリング解決の要）
 * `device_id` は TV が初回起動時に生成する推測不能な UUIDv4（F15 §5）。`GET /api/tv/config` は
 * **ユーザーセッション無し**の公開経路で `device_id → school_id` を全校横断で一意に解決する必要がある
 * ため、`device_id` を**グローバル UNIQUE**にする（sensor_devices.device_mac と同じ設計思想）。複合
 * UNIQUE だと同一 device_id を 2 校が登録でき、ポーリング解決が曖昧化して A 校 TV へ B 校設定を配信
 * しうる（テナント越境汚染。許容不可）。グローバル一意なら一行に解決され構造的に防げる。
 *
 * 注: この UNIQUE は `tv_device_commands` / `tv_device_downtime` の `device_id` FK の参照先でもある
 * （FK は非部分 UNIQUE を要求）。ソフトデリートしても行は残り device_id を保持するため、同一 device_id の
 * 再登録は不可（撤去端末を別 device_id で再プロビジョニングする運用で対応する）。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は migrations/0016_tv_devices_rls.sql で
 * tenant_isolation（school_id 一致）+ system_admin_full_access を付与する。ポーリング経路は
 * セッション無しのため、`recordPresenceEvent`（F13）と同じく system_admin role context で cross-tenant
 * 解決し、解決した school_id を pin して `last_seen_at` を更新する（BYPASSRLS 不使用、ルール2）。
 *
 * ## PII 非格納（ルール4）
 * 本テーブルおよびポーリング応答に**個人を識別する情報を入れない**。`label` は「電子工学科 1年」等の
 * 設置場所ラベル（自由文字列）で、生徒名・保護者名等の PII を入れてはならない。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため
 * migrations/0016 で後付けする（_shared/audit.ts と 0004/0006/0014 と同じパターン）。設定変更・コマンド
 * 発行は対象テーブル操作として既存 `audit_log` に寄せる（F15 §1、新規列を作らない）。
 *
 * 関連: ADR-022（ポーリング）, ADR-023（死活監視）, F15, F16, ADR-019（RLS 二層）。
 * 非スコープ（本基盤スライス）: `tv_device_commands` / `tv_device_tokens`（コマンドキュー・個別トークン、
 *   F15 §1）/ `tv_device_downtime`（F16 §1）/ 定期チェッカ・アラート（F16 §2-4）/ 設定編集 UI（F15 §4.2-4.4）/
 *   `events.tv_device_id` 拡張（F15 §1）。本スライスは「レジストリ + ポーリング config + last_seen 心拍 + 一覧」。
 */

// サイネージ ON/OFF スケジュールの型・純ロジックは **drizzle 非依存の `tv-schedule.ts`** に分離した
// （client コンポーネント / config-edit-core が `@kimiterrace/db/tv-schedule` から VALUE を import しても
// pg-core を巻き込まないため。#148 の client バンドル罠の回避）。ここでは jsonb 列の `$type` 用に型だけ取り込む。
import type { TvSchedule } from "./tv-schedule.js";

export type { TvSchedule, TvScheduleWindow } from "./tv-schedule.js";
export {
  MAX_SCHEDULE_WINDOWS,
  resolveScheduleWindows,
  scheduleWindowToMinutes,
} from "./tv-schedule.js";

export const tvDevices = pgTable(
  "tv_devices",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // TV が初回起動時に生成する推測不能な UUIDv4（F15 §5）。ポーリング解決キー。グローバル一意
    // （上記コメント参照、テナント越境配信防止）。drizzle 側で uuid 型にすると TV 生成値が UUID 形式で
    // ない場合に解決前に弾けるが、PoC の素朴 TV 実装が任意文字列を送る余地を残すため text にする
    // （正規化は将来トークン体系で締める。F15 §5 Phase 2）。
    deviceId: text("device_id").notNull(),
    // テナント分離キー。学校削除時は restrict（デバイス行を残したまま親を消させない）。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 表示用ラベル（例: "電子工学科 1年"）。自由文字列。★ PII を入れない。
    label: varchar("label", { length: 200 }),
    // 教室コンテキスト（F15 §1）。signage_url から自動抽出してフィールドに反映（UI 側、別スライス）。
    // いずれも nullable。親削除で SET NULL（デバイス行は残す＝過去の死活/設定履歴を保全）。
    gradeId: uuid("grade_id").references(() => grades.id, { onDelete: "set null" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    classId: uuid("class_id").references(() => classes.id, { onDelete: "set null" }),
    // BLE スキャン対象センサー MAC（センサー交換時に変更）。UI 上はマスク表示（F15 §5）。
    targetMac: varchar("target_mac", { length: 64 }),
    // サイネージ表示 URL。
    signageUrl: text("signage_url"),
    // TV が presence 等を転送する webhook URL（F13 連携）。
    webhookUrl: text("webhook_url"),
    // サイネージ ON/OFF スケジュール（上記 TvSchedule）。既定は空オブジェクト。
    scheduleJson: jsonb("schedule_json").$type<TvSchedule>(),
    // 設定の monotonic バージョン。設定変更のたび +1。TV は版差分時のみ反映（ADR-022）。
    version: integer("version").notNull().default(1),
    // TV からの最終ポーリング時刻。死活信号（F16 / ADR-023）。NULL = 未だ一度もポーリングしていない。
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    // 最終ポーリング元 IP（x-forwarded-for 由来）。運用診断用。inet は drizzle に専用型が無いため
    // varchar で保持し、INET 制約は付けない（IPv4/IPv6/XFF 由来の表記ゆれを緩く受ける）。
    lastKnownIp: varchar("last_known_ip", { length: 64 }),
    // FCM 登録トークン（遠隔起動、F16 拡張）。TV アプリ（com.kimiterrace.tvbridge）が lp-config ポーリング時に
    // `&fcmToken=<token>` で報告する最新トークン。down 検知時の遠隔起動（FCM data メッセージ action=wake）と
    // 管理画面「起こす」操作の宛先になる。NULL = 未報告（旧 APK / 報告前）で送信対象外。FCM トークンは端末固有の
    // 不透明文字列で、それ自体は PII（生徒・保護者情報）でない（ルール4）。device_id と同様に推測不能なので
    // UI ではフル値を出さず保有有無のみを示す。長さ可変ゆえ text で保持する。
    fcmToken: text("fcm_token"),
    // --- F16（死活監視、ADR-023）の土台フィールド ---
    // TV からの起動報告（任意・精度向上、F16 §3）。reboot 判定に使う。本スライスでは列のみ用意。
    lastBootAt: timestamp("last_boot_at", { withTimezone: true, mode: "date" }),
    // 起動報告で受領するアプリ版（F16 §3）。
    appVersion: varchar("app_version", { length: 64 }),
    // TV 個別に死活監視 ON/OFF（メンテ中の誤報抑制、F16 §1）。既定 true。
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    // 現在のアラート状態（重複通知抑止、F16 §1）。既定 ok。定期チェッカ（別スライス）が遷移させる。
    alertState: tvAlertState("alert_state").notNull().default("ok"),
    notes: text("notes"),
    // ソフトデリート（F15 §4.2）。NULL = 稼働中。削除後も復活可能・過去データ解決のため行は残す。
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    ...auditColumns,
  },
  (t) => ({
    // ポーリング解決の一意性（テナント越境配信防止）。グローバル一意。
    uxDeviceId: uniqueIndex("ux_tv_devices_device_id").on(t.deviceId),
    // school 別のデバイス一覧（管理 UI / F08 ヘルス統合）。
    ixSchool: index("ix_tv_devices_school").on(t.schoolId),
  }),
);
