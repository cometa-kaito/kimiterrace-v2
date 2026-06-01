import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { sensorKind, sensorVendor } from "../_shared/enums.js";
import { classes } from "./classes.js";
import { schools } from "./schools.js";

/**
 * F13 (#391, ADR-020): 来場検知センサーのデバイス登録（SwitchBot 人感センサー）。
 *
 * ## 役割
 * SwitchBot Webhook（ADR-020 §2）は school_id を載せて来ない。受信ハンドラ（S2）は
 * payload の `device_mac` から本テーブルを引いて **`device_mac → school_id` を解決**し、
 * 既存 `events` テーブルへ `type='presence'` で正規化して書き込む（F13 §解決 / §events 拡張）。
 * 未登録 device は events に書かず失敗テーブルへ退避する（S2 スコープ）。
 *
 * ## ★ なぜ device_mac は「グローバル一意」か（セキュリティ上の要）
 * F13 §28 は「school_id × device_mac でユニーク」と表現するが、本実装は **device_mac を
 * グローバル UNIQUE** にする（複合より強い制約）。理由: webhook 解決は `device_mac → school_id`
 * の一意写像でなければならない。複合 UNIQUE(school_id, device_mac) だと同一 MAC を 2 校が
 * 登録でき、解決が曖昧になり **A 校のセンサーデータを B 校へ誤ルーティング**しうる（テナント
 * 越境汚染。生徒近傍データで許容不可）。グローバル一意なら一行に解決され構造的に防げる。
 * MAC は物理的にも世界一意なので現実とも整合する。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は migrations/0014_sensor_devices_rls.sql で
 * tenant_isolation（school_id 一致）+ system_admin_full_access を付与する。
 *
 * ## ★ PII 非格納（ルール4 / ADR-020 透明性要件）
 * 本テーブルおよび presence イベントには **個人を識別する情報を入れない**。`location_label`
 * は「教室名」等の設置場所ラベル（自由文字列）で、生徒名・保護者名等の PII を入れてはならない。
 * PIR はカメラ非搭載・個人識別なし（ADR-020 §6）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため
 * migrations/0014 で後付けする（_shared/audit.ts と 0004/0006 と同じパターン）。
 *
 * 関連: ADR-020, F13（来場検知 Webhook）, ADR-019（RLS 二層）, Issue #391。
 * 非スコープ（S2 以降）: webhook 受信エンドポイント / 署名・共有シークレット検証 /
 *   SWITCHBOT_WEBHOOK_SECRET（cutover で rotate）/ 失敗退避テーブル / F08 ヒートマップ。
 */
export const sensorDevices = pgTable(
  "sensor_devices",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // テナント分離キー。学校削除時は restrict（デバイス行を残したまま親を消させない）。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 物理 MAC アドレス。webhook 解決キー。グローバル一意（上記コメント参照）。
    deviceMac: varchar("device_mac", { length: 64 }).notNull(),
    // SwitchBot クラウド上の外部デバイス ID（任意。payload に含まれる場合の照合用）。
    deviceIdExternal: varchar("device_id_external", { length: 128 }),
    vendor: sensorVendor("vendor").notNull().default("switchbot"),
    kind: sensorKind("kind").notNull().default("presence_pir"),
    // 設置場所ラベル（例: "1-A 教室前"）。自由文字列。★ PII を入れない。
    locationLabel: varchar("location_label", { length: 120 }),
    // 任意でクラスに紐づける（F08 ヒートマップのクラス別集計用）。クラス削除で SET NULL。
    classId: uuid("class_id").references(() => classes.id, { onDelete: "set null" }),
    installedAt: timestamp("installed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // 撤去時刻。NULL = 稼働中。撤去後も監査・過去データ解決のため行は残す。
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true, mode: "date" }),
    ...auditColumns,
  },
  (t) => ({
    // webhook 解決の一意性（テナント越境ルーティング防止）。グローバル一意。
    uxDeviceMac: uniqueIndex("ux_sensor_devices_device_mac").on(t.deviceMac),
    // school 別のデバイス一覧（管理画面 / F08 集計）。
    ixSchool: index("ix_sensor_devices_school").on(t.schoolId),
  }),
);
