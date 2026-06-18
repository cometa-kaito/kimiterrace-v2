// パッケージ公開エントリ。schema を再エクスポート。
export * from "./schema/index.js";
// RLS テナントコンテキスト ヘルパ (#48-B core: SET LOCAL primitive)
export * from "./client.js";
// クエリ層 (#48-F: 広告階層マージ)
export * from "./queries/effective-ads.js";
// F04: 即公開フロー + 安全網 (publish / update / unpublish / rollback ドメインサービス)
export * from "./queries/contents-publish.js";
// F05: クラス magic link (発行 / 失効 / 一覧 + 生徒匿名解決 resolve_magic_link)
export * from "./queries/magic-links.js";
// F04: content 読み取りクエリ層 (一覧 / 詳細 + バージョン履歴 + 公開状態、エディタ UI 用)
export * from "./queries/content-detail.js";
// F02: 教員音声 / チャット入力 (作成 / 一覧 / 詳細 / transcript 編集 / 下書き / submit / 削除 / 添付メタ)
export * from "./queries/teacher-inputs.js";
// #48-J: クラススコープ広告の読み取りクエリ層 (自クラス広告一覧 / 可視クラス確認 / 単件取得)
export * from "./queries/ads.js";
// #48-J-2: 学校設定 (school_configs) の読み取り / upsert クエリ層 (quiet_hours 等)
export * from "./queries/school-configs.js";
// #48-L (#123): システム管理者向け 学校 (テナント) マスタ一覧
export * from "./queries/schools.js";
// 運営整理 Phase6 / Partner K4: portal 学校台帳向け「学校→設置場所→モニタ」階層 pull
export * from "./queries/school-hierarchy.js";
// F12 (#48-M): フィードバック (匿名投稿 submit_feedback / system_admin 一覧)
export * from "./queries/feedback.js";
// F03 (#154): AI 構造化抽出結果の ai_extractions 永続化層 (RLS context 内 INSERT)
export * from "./queries/ai-extractions.js";
// F08 (#44): 効果ダッシュボードの行動ログ集計読み取り層 (view/tap totals + content ランキング)
export * from "./queries/event-stats.js";
// F13 (ADR-020): パターン2 サイネージ「人感センサカウンタ」用、クラス別・本日(JST)の presence 件数
export * from "./queries/presence-today.js";
// パターン2 サイネージ「来校者一覧」: クラス×日別の来校者 read（RLS テナント分離）
export * from "./queries/class-visitors.js";
// パターン2 サイネージ「生徒呼び出し」: クラス×日別の呼び出し read（実名表示・ADR-034・RLS テナント分離）
export * from "./queries/student-callouts.js";
// パターン2 サイネージ「鉄道」: 鉄道事業者の運行情報キャッシュ read/upsert（公開・非PII・ADR-035・read_all RLS）
export * from "./queries/railway-status.js";
// F09 (#45): 月次レポートの学校別サマリー集計読み取り層 (JST 暦月の totals/ranking/稼働日数)
export * from "./queries/monthly-report.js";
// F09 (#45, #430): 月次レポート生成履歴 (monthly_reports) の書き込み層 (RLS context 内 upsert)
export * from "./queries/monthly-reports-write.js";
// F09 (#45, #430): 月次レポート生成履歴の読み取り層 (一覧 / 単件、system_admin DL 導線供給)
export * from "./queries/monthly-reports-read.js";
// F03 (#289): 職員氏名 roster (Vertex 送信前 PII マスキング供給用、ルール4)
export * from "./queries/users.js";
// F07/F09 (#322): 広告到達数 (advertiser reach) の minute-dedup 集計読み取り層 (ADR-025)
export * from "./queries/ad-reach.js";
// F09 (#45): 広告主アカウント単位の月次レポート集計読み取り層 (advertisers⋈contracts⋈contents⋈events, system_admin)
export * from "./queries/advertiser-report.js";
// Partner API K1 (partner-api-contract §2): 単一広告主×指定月の効果メトリクス + presence(接触機会) 読み取り層 (system_admin)
export * from "./queries/advertiser-metrics.js";
// Partner API K3 (partner-api-contract §3): 配信 push 受け口の冪等 upsert 層 (advertisers/contracts/ads, system_admin)
export * from "./queries/partner-delivery.js";
// F03 (#348, ADR-027): 分散レート制限の Cloud SQL store (DistributedRateLimiter 用)
export * from "./queries/ai-rate-limit.js";
// F06 (#364, ADR-028): 生徒 Q&A の RAG 検索 (公開中 content_versions を pgvector で top-k、RLS 委譲)
export * from "./queries/rag-search.js";
// F13 (#408, ADR-020): SwitchBot Webhook の presence イベント書込み (cross-tenant 解決 + scoped insert)
export * from "./queries/sensor-presence.js";
// F15/F16 (ADR-022/ADR-023): TV デバイスのポーリング設定取得 + last_seen 心拍更新 / 管理一覧読み取り
export * from "./queries/tv-devices.js";
// F15 (ADR-022): TV リモートコマンドキュー (enqueue + ポーリング配信 pollPending + 冪等 ack + 履歴)
export * from "./queries/tv-device-commands.js";
// C方式 TV プロビジョニング: ジョブの作成(+監査) / claim(FOR UPDATE SKIP LOCKED) / 状態報告 / 一覧・単件
export * from "./queries/tv-provisioning-jobs.js";
// C方式 TV プロビジョニング / サイネージ: magic link トークン純ロジック（seed CLI と web Server Action で共有・ルール5 hash 保存）
export {
  DEFAULT_SIGNAGE_BASE_URL,
  DEFAULT_SIGNAGE_TTL_DAYS,
  buildSignageUrl,
  generateToken,
  hashToken,
  isV2SignageUrl,
  resolveSignageBaseUrl,
  resolveSignageTtlDays,
} from "./seed-ginan-signage.js";
// F16 (ADR-023): TV 死活ギャップチェッカの純粋判定ロジック (last_seen ギャップ → down/recover 遷移)
export * from "./queries/tv-liveness.js";
// F16 (ADR-023): TV 死活チェックの DB 反映層 (alert_state 反転 + tv_device_downtime 記録、RLS 委譲)
export * from "./queries/tv-liveness-checker.js";
// F16 (ADR-023): TV ダウンタイム履歴 / 稼働サマリの読み取り層 (管理 UI §5、決定的順序 + DB 側 now() 集計、RLS 委譲)
export * from "./queries/tv-downtime.js";
// F06 (#398, ADR-007): embedding 生成バッチの RLS クエリ層 (公開中・未生成抽出 + embedding 保存)
export * from "./queries/embedding-batch.js";
// F13 (#391, ADR-020): 来場検知センサーの管理/状態一覧 読み取り層 (登録センサー + 直近検知 + ヘルス、RLS 委譲)
export * from "./queries/sensor-devices-status.js";
// F13 (#391, ADR-020): 1 センサーの来場検知(presence)履歴 読み取り層 (生検知 + JST日別集計 + 総数、RLS 委譲)
export * from "./queries/presence-history.js";
// ADR-032: 教員「学校共通パスワード」ログインの DB 層 (有効校列挙 + 共通教員 users 行 provisioning、RLS 委譲)
export * from "./queries/teacher-login.js";
// #243 (②UI-UX): サイネージ識別用のクラス文脈 (学科名/学年名/クラス名) 読み取り層、RLS 委譲
export * from "./queries/signage-class-context.js";
// #48-K3: 学校管理ハブ「本日の掲示状態」用、サイネージ実表示に整合した daily_data 遡及窓 read (RLS 委譲)
export * from "./queries/daily-window.js";
// F14 (#128, ADR-021): サイネージ天気予報キャッシュの upsert (取得 Job) / 読み取り (匿名サイネージ) 層
export * from "./queries/weather-forecasts.js";
// ADR-043: サイネージ「工学ニュース」見出しキャッシュの upsert (取得 Job) / 読み取り (匿名サイネージ) 層
export * from "./queries/news-items.js";
// ADR-044: サイネージ気象警報・注意報キャッシュの upsert (取得 Job 相乗り) / 読み取り (匿名サイネージ) 層
export * from "./queries/weather-warnings.js";
// ADR-044: サイネージ熱中症警戒アラート / WBGT キャッシュの upsert (取得 Job 相乗り) / 読み取り (匿名サイネージ) 層
export * from "./queries/heat-alerts.js";
// サイネージ静的コンテンツ (名言/四字熟語/英単語/今日は何の日) の日付決定論ローテ選択 (純関数) + 読み取り (匿名サイネージ) 層
export * from "./queries/signage-snippets.js";
// F14 (#128, ADR-021): 都道府県 → JMA 府県予報区コードの静的マップ (取得 Job + サイネージ読取で共有)
export * from "./_shared/jma-area-map.js";
