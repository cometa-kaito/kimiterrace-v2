import { pgEnum } from "drizzle-orm/pg-core";

// 役割: テナント内ユーザーのロール（system_admin はテナント外、system_admins テーブルで管理）
export const userRole = pgEnum("user_role", ["school_admin", "teacher", "student", "guardian"]);

// コンテンツ発行スコープ（F01-F04）
export const publishScope = pgEnum("publish_scope", ["school", "class", "homeroom", "private"]);

/**
 * 発行スコープの型（単一ソース）。アプリ層 (apps/web) は `import type` でこれを引き込み、
 * `satisfies readonly PublishScope[]` で許可値配列が enum とズレないことをコンパイル時に強制する
 * (`client.ts` の `TenantRole` と同方針)。型のみなので Next バンドルに enum のランタイム値を引き込まない。
 */
export type PublishScope = (typeof publishScope.enumValues)[number];

// コンテンツ状態
export const contentStatus = pgEnum("content_status", ["draft", "published", "archived"]);

// 行動イベント種別（F07）。
// `presence` は F13（来場検知 SwitchBot Webhook、ADR-020）で追加。PIR センサーの
// 「動きの瞬間検知」を表す。`dwell`（滞在秒数。LiDAR/カメラ等の継続滞在計測用途）とは
// 区別する — PIR は滞在時間を測れないため presence は別値にする（F13 §「presence と dwell の区別」）。
// 既存 view/tap/dwell/ask は変更しない（末尾追加 = ALTER TYPE ADD VALUE、非破壊）。
export const eventType = pgEnum("event_type", ["view", "tap", "dwell", "ask", "presence"]);

// F13: 来場検知センサーのベンダー（ADR-020）。現状 SwitchBot のみ。将来ベンダー追加時は
// 末尾に値を足す（ADD VALUE）。`sensor_devices.vendor` の値域を DB レベルで固定する（ルール3）。
export const sensorVendor = pgEnum("sensor_vendor", ["switchbot"]);

// F13: 来場検知センサーの方式（ADR-020）。`presence_pir` = PIR 方式の人感センサー
// （カメラ非搭載・個人識別なし、ADR-020 透明性要件）。滞在秒数は計測しない。
export const sensorKind = pgEnum("sensor_kind", ["presence_pir"]);

// F16 (ADR-023): TV デバイスの死活アラート状態。`tv_devices.alert_state` の値域を DB で固定する
// （ルール3）。`ok` = 正常 / `down` = ポーリング途絶でダウン判定中。重複通知抑止のため定期チェッカ
// （F16 §2、別スライス）が遷移時のみ通知し、`down`→`down` の連投を避ける状態フラグ。既定 `ok`。
// 将来 `degraded` 等を足すなら末尾追加（ADD VALUE、非破壊）。
export const tvAlertState = pgEnum("tv_alert_state", ["ok", "down"]);

// F15 (ADR-022): TV へ配信するリモートコマンドの種別。`tv_device_commands.command` の値域を DB で
// 固定する（ルール3）。F15 §1 の確定値:
//   signage_reload  … サイネージ WebView をリロード（最頻・「変更を今すぐ反映」）
//   signage_open    … サイネージアプリを強制起動（前面化）
//   signage_exit    … サイネージアプリを強制終了
//   service_restart … TV 常駐サービス（com.kimiterrace.tvbridge）を再起動
// ポーリング応答で pending を配信し、TV は version 増分時のみ実行（再実行抑制、ADR-022 §設計詳細）。
// 将来 reboot 等を足すなら末尾追加（ADD VALUE、非破壊）。
export const tvCommandType = pgEnum("tv_command_type", [
  "signage_reload",
  "signage_open",
  "signage_exit",
  "service_restart",
]);

/**
 * TV リモートコマンド種別の型（単一ソース）。アプリ層 (apps/web) は client-safe な `@kimiterrace/db/schema`
 * から `import type` でこれを引き込み、発行ボタンの許可値・ラベルが enum とズレないことを
 * `satisfies Record<TvCommandType, ...>` でコンパイル時に強制する（`PublishScope` と同方針）。型のみなので
 * Next バンドルに enum のランタイム値（= postgres を引き込む barrel）を持ち込まない。
 */
export type TvCommandType = (typeof tvCommandType.enumValues)[number];

// F15 (ADR-022): TV リモートコマンドのライフサイクル状態。`tv_device_commands.status` の値域を DB で
// 固定する（ルール3）。send-once セマンティクス（F15 §1）:
//   pending   … 発行直後・未配信。次のポーリングで配信対象。
//   delivered … TV がポーリングで受領（acknowledged_at をセット）。再配信しない（冪等 ack）。
//   failed    … 配信後 TV 側で実行失敗を報告（将来の失敗 ack 用に予約）。
//   expired   … expires_at 超過で配信されないまま無効化（掃除ジョブが遷移、本スライスは列のみ）。
// 将来値を足すなら末尾追加（ADD VALUE、非破壊）。
export const tvCommandStatus = pgEnum("tv_command_status", [
  "pending",
  "delivered",
  "failed",
  "expired",
]);

// F16 (ADR-023): TV ダウンタイムの原因の機械推定。`tv_device_downtime.cause_hint` の値域を DB で
// 固定する（ルール3）。`unknown` = 区別不能（電源OFF/ネット断/アプリ停止はすべてポーリング途絶に
// 見える、ADR-023 §悪い影響）/ `reboot` = 復帰時に last_boot_at の進行を検出（再起動と推定）/
// `network` = 将来の通信断シグナルで区別する余地（現状は未使用、末尾追加で予約）。NULL = 未判定。
// 将来値を足すなら末尾追加（ADD VALUE、非破壊）。
export const tvDowntimeCause = pgEnum("tv_downtime_cause", ["unknown", "reboot", "network"]);

// C方式 TV プロビジョニング（v2 クラウド UI でジョブ作成 → 現地ローカルエージェントが claim → adb 実行）の
// ジョブ状態機械。`tv_provisioning_jobs.status` の値域を DB で固定する（ルール3）。段階ワークフロー
// （読取 → 物理作業依頼 → 設定実行。破壊的操作の前に必ずキャプチャ）を表す:
//   pending           … 作成直後・未 claim。ローカルエージェントの claim 対象。
//   claimed           … エージェントが claim 済み（実行開始）。
//   preflight         … adb 接続・機種判定・県Wi-Fi設定キャプチャ中（破壊的操作前の読取）。
//   awaiting_physical … 人手の物理作業（工場リセット → 県Wi-Fi 再設定）を依頼し待機中。
//   provisioning      … install / Device Owner / オフタイマー無効 / prefs 注入 / 起動 を自動実行中。
//   succeeded         … 表示確認まで完了。
//   failed            … 途中失敗（error / steps_json に詳細）。
//   canceled          … 運用者が中止。
// 将来値を足すなら末尾追加（ALTER TYPE ADD VALUE、非破壊）。
export const tvProvisioningStatus = pgEnum("tv_provisioning_status", [
  "pending",
  "claimed",
  "preflight",
  "awaiting_physical",
  "provisioning",
  "succeeded",
  "failed",
  "canceled",
]);

/**
 * TV プロビジョニングジョブ状態の型（単一ソース）。アプリ層 (apps/web) は client-safe な
 * `@kimiterrace/db/schema` から `import type` で引き込み、UI のステップ表示・許可遷移が enum と
 * ズレないことを `satisfies` でコンパイル時に強制する（`TvCommandType` と同方針）。型のみなので
 * Next バンドルに enum のランタイム値を持ち込まない。
 */
export type TvProvisioningStatus = (typeof tvProvisioningStatus.enumValues)[number];

// F14 (ADR-021): サイネージ天気予報のデータソース。現状 気象庁 (JMA) 無料 API のみ。
// `weather_forecasts.source` の値域を DB レベルで固定する（ルール3: 値域の単一ソース化）。
// 将来 JMA 障害時の商用 API フォールバックを採る場合は末尾に値を足す（ADD VALUE、非破壊）。
// 気象警報・注意報 (ADR-044) も同じ取得元 (JMA bosai) なので `weather_warnings.source` で本 enum を再利用する。
export const weatherSource = pgEnum("weather_source", ["jma"]);

// ADR-043: サイネージ「工学ニュース」のデータソース。`news_items.source` の値域を DB レベルで固定する
// （ルール3: 値域の単一ソース化）。本文は転載せず見出し+出典+リンクのみ表示する（著作権回避）。
//   jst  … JST サイエンスポータル（本命・工学/科学技術ニュース・日本語・日次）
//   mext … 文部科学省 新着情報（政府標準利用規約 = CC BY 互換）
//   meti … 経済産業省 ニュースリリース（政府標準利用規約 = CC BY 互換）
// 将来 jaxa 等を足すなら末尾追加（ALTER TYPE ADD VALUE、非破壊。generate が DROP TYPE を吐かないこと）。
export const newsSource = pgEnum("news_source", ["jst", "mext", "meti"]);

/**
 * ニュースソースの型（単一ソース）。アプリ層 (apps/web) は client-safe な `@kimiterrace/db/schema`
 * から `import type` でこれを引き込み、許可値・発表元ラベルが enum とズレないことを `satisfies` で
 * コンパイル時に強制する（`PublishScope` / `TvCommandType` と同方針）。型のみなので Next バンドルに
 * enum のランタイム値（= postgres を引き込む barrel）を持ち込まない。
 */
export type NewsSource = (typeof newsSource.enumValues)[number];

// ADR-044 (気象警報・注意報): その地域で出ている最大の警戒段階の派生値。`weather_warnings.max_level` の
// 値域を DB レベルで固定する（ルール3: 値域の単一ソース化）。盤面の存在判定・強調表示を、jsonb の中身を
// 端末側で再集計させずに済ませる（取得 Job のパーサで一元導出する単一ソース）。順序（弱→強）:
//   none      … 警報・注意報なし（解除済を含む）
//   advisory  … 注意報（JMA の注意報レベル）
//   warning   … 警報
//   emergency … 特別警報（最上位）
// 将来値（例: より細かい段階）を足すなら末尾追加（ALTER TYPE ADD VALUE、非破壊）。
export const warningLevel = pgEnum("warning_level", ["none", "advisory", "warning", "emergency"]);

/**
 * 気象警報レベルの型（単一ソース）。アプリ層 (apps/web) は client-safe な `@kimiterrace/db/schema`
 * から `import type` でこれを引き込み、盤面の段階表示・強調が enum とズレないことを `satisfies` で
 * コンパイル時に強制する（`TvCommandType` / `PublishScope` と同方針）。型のみなので Next バンドルに
 * enum のランタイム値（= postgres を引き込む barrel）を持ち込まない。
 */
export type WarningLevel = (typeof warningLevel.enumValues)[number];

// ADR-044 (熱中症警戒アラート): 暑さ指数・熱中症アラートのデータソース。環境省「熱中症予防情報サイト」
// (https://www.wbgt.env.go.jp/) の無料・keyless な電子情報提供サービスのみ。`heat_alerts.source` の値域を
// DB レベルで固定する（ルール3: 値域の単一ソース化）。気象警報 (ADR-044, weather_warnings) は JMA 由来で
// `weather_source` を使うが、熱中症アラートは **取得元が環境省（JMA ではない）** なので別 enum にする
// （`weather_source` の 'jma' 専用色を熱中症に流用しない）。将来別ソースを足すなら末尾追加（ADD VALUE、非破壊）。
//   env_moe … 環境省（Ministry of the Environment）熱中症予防情報サイトの電子情報提供サービス。
export const heatSource = pgEnum("heat_source", ["env_moe"]);

/**
 * 熱中症アラートのデータソースの型（単一ソース）。アプリ層 (apps/web) は client-safe な
 * `@kimiterrace/db/schema` から `import type` で引き込み、許可値・出典ラベルが enum とズレないことを
 * `satisfies` でコンパイル時に強制する（`WarningLevel` / `NewsSource` と同方針）。型のみなので
 * Next バンドルに enum のランタイム値（= postgres を引き込む barrel）を持ち込まない。
 */
export type HeatSource = (typeof heatSource.enumValues)[number];

// ADR-044 (熱中症警戒アラート): 都道府県単位・日次の熱中症（特別）警戒アラートの段階。`heat_alerts.alert_level`
// の値域を DB レベルで固定する（ルール3: 値域の単一ソース化）。環境省の電子情報提供サービス（alert CSV の
// FlagExplanation）は 0=発表無し / 1=熱中症警戒情報発表 / 2=熱中症特別警戒情報判定 / 3=熱中症特別警戒情報発表 /
// 9=発表時間外。表示は「発表されたアラート」の 3 段階に正規化する（取得 Job のパーサで一元導出する単一ソース）:
//   none      … アラートなし（CSV フラグ 0 / 2(判定のみで未発表) / 9(時間外) / 欠落、fail-soft）
//   warning   … 熱中症警戒アラート（CSV フラグ 1）
//   emergency … 熱中症特別警戒アラート（CSV フラグ 3、最上位）
// 気象警報の `warning_level` とは段階体系が異なる（注意報相当が無い）ため別 enum にする（流用しない）。
// 将来値を足すなら末尾追加（ALTER TYPE ADD VALUE、非破壊）。
export const heatAlertLevel = pgEnum("heat_alert_level", ["none", "warning", "emergency"]);

/**
 * 熱中症アラート段階の型（単一ソース）。アプリ層 (apps/web) は client-safe な `@kimiterrace/db/schema`
 * から `import type` で引き込み、盤面の段階表示・強調が enum とズレないことを `satisfies` でコンパイル時に
 * 強制する（`WarningLevel` と同方針）。型のみなので Next バンドルに enum のランタイム値を持ち込まない。
 */
export type HeatAlertLevel = (typeof heatAlertLevel.enumValues)[number];

// ADR-044 (熱中症警戒アラート): その日のピーク暑さ指数 WBGT の区分。`heat_alerts.wbgt_band` の値域を DB
// レベルで固定する（ルール3）。日本生気象学会 / 環境省「日常生活に関する指針」の 5 区分（℃）に対応する:
//   almost_safe … ほぼ安全（WBGT < 21）
//   caution     … 注意（21 <= WBGT < 25）
//   warning     … 警戒（25 <= WBGT < 28）
//   severe      … 厳重警戒（28 <= WBGT < 31）
//   danger      … 危険（31 <= WBGT）
// WBGT が取得できない日は NULL（fail-soft、列は nullable）。`heat_alert_level` の 'warning' とは別概念
// （アラート段階 vs 暑さ指数区分）なので英字値で衝突させない。将来値を足すなら末尾追加（ADD VALUE、非破壊）。
export const wbgtBand = pgEnum("wbgt_band", [
  "almost_safe",
  "caution",
  "warning",
  "severe",
  "danger",
]);

/**
 * WBGT 区分の型（単一ソース）。アプリ層 (apps/web) は client-safe な `@kimiterrace/db/schema` から
 * `import type` で引き込み、盤面の区分表示・色分けが enum とズレないことを `satisfies` でコンパイル時に
 * 強制する（`HeatAlertLevel` と同方針）。型のみなので Next バンドルに enum のランタイム値を持ち込まない。
 */
export type WbgtBand = (typeof wbgtBand.enumValues)[number];

// AI 抽出種別（F03）
export const aiExtractionKind = pgEnum("ai_extraction_kind", [
  "schedule",
  "announcement",
  "summary",
  "tag",
]);

// AI 抽出の実行結果ステータス（F03）。varchar から enum 化し、想定外文字列の混入を DB で弾く
// （ルール3: 値域の単一ソース化。PR #71 Reviewer M-1）。
//   success … 抽出成功
//   retry   … 一時失敗でリトライ対象
//   failed  … 恒久失敗
export const aiExtractionStatus = pgEnum("ai_extraction_status", ["success", "retry", "failed"]);

// F01/F02: 教員入力の種別（音声 / チャット / ファイル）
//   voice … 音声入力（端末ローカル Web Speech でテキスト化、F02）
//   chat  … チャットテキスト入力（F02）
//   file  … ファイルアップロード入力（PDF/DOCX/XLSX/PNG/JPEG を抽出器でテキスト化して transcript に格納、F01 #509）。
//           末尾追加 = ALTER TYPE ADD VALUE（非破壊。既存 voice/chat は不変で、generate が DROP TYPE を吐かないこと）。
export const teacherInputType = pgEnum("teacher_input_type", ["voice", "chat", "file"]);

// F02: 教員入力のライフサイクル状態
//   draft        … 下書き保存（FR-06）
//   transcribing … 音声文字起こし待ち / 処理中（F02 スコープ外ジョブが更新、TODO）
//   ready        … 文字起こし完了・確認/編集可能（FR-04）
//   submitted    … F03 へ送信済み（FR-07: submitted_at をセット）
export const teacherInputStatus = pgEnum("teacher_input_status", [
  "draft",
  "transcribing",
  "ready",
  "submitted",
]);

// 監査ログ操作種別
export const auditOp = pgEnum("audit_op", ["insert", "update", "delete"]);

// CRM 系
// F10 (#46, PR #534): 広告主 (advertisers) の営業ステータス。is_active boolean (論理削除) の上位概念で、
// 仕様 (F10 受け入れ条件) の 3 状態を DB レベルで固定する (ルール3: 値域の単一ソース化)。
//   prospect … 見込み (提案・商談中。未契約)
//   active   … 契約中 (稼働中の出稿あり)
//   paused   … 休止 (一時停止・解約済み等で配信対象外。is_active=false と等価)
// **不変条件**: status='paused' ⟺ is_active=false / status∈{prospect,active} ⟺ is_active=true。
// is_active は当面残し (toggle / 並び / 既存テストの blast radius を抑えるため)、両者を整合させる
// (drop は別フォローアップ)。将来値を足すなら末尾追加 (ALTER TYPE ADD VALUE、非破壊)。
export const advertiserStatus = pgEnum("advertiser_status", ["prospect", "active", "paused"]);

/**
 * 広告主ステータスの型 (単一ソース)。アプリ層 (apps/web) は client-safe な `@kimiterrace/db/schema`
 * から `import type` でこれを引き込み、許可値配列・ラベルが enum とズレないことを
 * `satisfies` でコンパイル時に強制する (`PublishScope` / `TvCommandType` と同方針)。型のみなので
 * Next バンドルに enum のランタイム値 (= postgres を引き込む barrel) を持ち込まない。
 */
export type AdvertiserStatus = (typeof advertiserStatus.enumValues)[number];

export const contractStatus = pgEnum("contract_status", [
  "draft",
  "active",
  "paused",
  "terminated",
]);
export const communicationChannel = pgEnum("communication_channel", [
  "email",
  "phone",
  "meeting",
  "other",
]);

// F0 (V1 移植): 学校 → 学年 → クラス（→ 学科）階層スコープ。
// ads / daily_data / school_configs が「どの階層に紐づくか」を判別する discriminator。
export const hierarchyScope = pgEnum("hierarchy_scope", ["school", "grade", "class", "department"]);

// 学校設定の種別（V1 config sub-collection: display_settings / quiet_hours / schedule_templates）
export const configKind = pgEnum("config_kind", [
  "display_settings",
  "quiet_hours",
  "schedule_templates",
]);

// サイネージ広告のメディア種別（V1 Ad.type）
export const adMediaType = pgEnum("ad_media_type", ["image", "video"]);

// 学校の階層モード（V1 schools.hierarchyMode）。
//   class      … 学年 > クラス（普通科高校の標準）
//   department … 学年 > 学科 > クラス（学科制の高校）
// V1 setSchoolHierarchyMode 相当の切替対象（#48-L / #123）。
export const schoolHierarchyMode = pgEnum("school_hierarchy_mode", ["class", "department"]);

/**
 * 学校の階層モードの型（単一ソース）。アプリ層 (apps/web) は `import type` でこれを引き込み、
 * `satisfies readonly SchoolHierarchyMode[]` で許可値配列が enum とズレないことをコンパイル時に
 * 強制する (`client.ts` の `TenantRole` / `PublishScope` と同方針)。型のみなので Next バンドルに
 * enum のランタイム値を引き込まない。
 */
export type SchoolHierarchyMode = (typeof schoolHierarchyMode.enumValues)[number];
