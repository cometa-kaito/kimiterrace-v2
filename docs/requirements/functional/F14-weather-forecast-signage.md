# F14: サイネージ天気予報表示（気象庁データ）

- 状態: バックエンド＋表示 実装済 / Phase 2 想定だった一部は後回し — DB キャッシュ（weather_forecasts + RLS）・JMA 取得ロジック・取得 Cloud Run Job + Scheduler + egress・サイネージ天気ウィジェット表示は DONE（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)/[#490](https://github.com/cometa-kaito/kimiterrace-v2/pull/490)/[#493](https://github.com/cometa-kaito/kimiterrace-v2/pull/493)/[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)）。残: 指数バックオフ retry・audit_log への取得記録・system_service ロール・市区単位の地域上書き・天気 e2e（いずれも Phase 2 後回し 2026-06-01）
- 関連 ADR: [ADR-021 (天気データソース = 気象庁 JMA)](../../adr/021-weather-data-source-jma.md), [ADR-019 (RLS 二層)](../../adr/019-rls-two-layer-tenant-isolation.md)。ADR-002 (Cloud Run) / ADR-001 (PostgreSQL) / ADR-009 (Terraform) は未作成（[#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)）
- 関連要件: [F12 (V1 機能移植 / サイネージ)](F12-v1-port.md), [NFR01 (性能)](../non-functional/NFR01-performance.md), [NFR03 (セキュリティ)](../non-functional/NFR03-security.md), [NFR04 (監査ログ)](../non-functional/NFR04-audit-log.md), [NFR05 (アクセシビリティ)](../non-functional/NFR05-accessibility.md), [NFR06 (コスト)](../non-functional/NFR06-cost-policy.md)
- 関連 issue: [#128](https://github.com/cometa-kaito/kimiterrace-v2/issues/128)
- 優先度: **Phase 2（サイネージ）。低コスト・高視認性のため PoC 前倒し候補**（[v2-mvp.md §1.2](../v2-mvp.md)）

## 概要

サイネージ画面に **その学校の地域の天気予報**（本日 + 週間の一部）を表示する。気象庁（JMA）の無料 JSON 予報データを取得して表示する。

**閉域原則との両立（最重要、[[closed-system-security]]）**: サイネージ端末（1 校あたり最大 50 台）は **外部 API を直接叩かない**。バックエンドの **Cloud Run Job（`apps/jobs`）が地域コード単位で JMA を定期取得し、Cloud SQL の `weather_forecasts` にキャッシュ**する。サイネージ Server Component（[F12](F12-v1-port.md) / #48-E）は schedules/notices/ads と同様に **自校 DB から天気を SELECT するだけ**。

これにより:
- 外部への egress は「バックエンド Job → JMA」の 1 経路のみ。端末は閉域（自社 Cloud Run のみと通信）を維持
- 外部に送る情報は **公開の地域コード（例: 岐阜県 = `210000`）のみ**。生徒・学校を識別する情報・PII は一切送信しない（[ADR-021](../../adr/021-weather-data-source-jma.md) §文脈）
- 同一地域の複数校は同一キャッシュ行を共有 → JMA への呼び出しを地域単位で dedup、Cloud SQL コネクションも端末 polling に依存しない（[v1-v2-mapping.md](../../architecture/v1-v2-mapping.md) の onSnapshot 圧迫懸念を回避）

## ユーザーストーリー

- **生徒として**、登校直後にサイネージで今日の天気・最高/最低気温・降水確率を一目で知り、傘や上着の判断をしたい。
- **教員として**、その日の天気を別途調べなくても、連絡コンテンツと並べてサイネージに自動表示されていてほしい（運用負荷ゼロ）。
- **校務管理者として**、天気表示の地域（市/府県）を自校の所在に合わせて設定したい。
- **システム管理者として**、外部 API 障害時にサイネージが壊れず、「○時時点の予報」として直近取得値（last-known-good）を表示し続けてほしい。

## 受け入れ条件

### 1. データモデル

- [x] 新規テーブル `weather_forecasts`（**地域単位のキャッシュ。school_id を持たない cross-tenant 参照テーブル**、auditColumns 必須、RLS 有効）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`packages/db/src/schema/weather-forecasts.ts`：area_code/area_name/source/fetched_at/forecast_date/weather_code/weather_text/temp_min/temp_max/pop/raw + auditColumns、`(area_code, source, forecast_date)` uniqueIndex。RLS は `migrations/0017_weather_forecasts_rls.sql`）
  - `id`, `area_code`（JMA 地域コード）, `area_name`, `source`（enum `weather_source`: `jma`）, `fetched_at`, `forecast_date`（対象日）, `weather_code`（JMA 天気コード）, `weather_text`, `temp_min`, `temp_max`, `pop`（降水確率 %）, `raw (jsonb)`（原文保全）, 監査カラム
  - 一意制約: `(area_code, source, forecast_date)`（同日 1 行、再取得は upsert）
- [~] **RLS（school_id 非保持の公開参照マスタの特例）**: policy 名 `weather_read_all`（`FOR SELECT`、`USING (true)`）+ `weather_write_system`（`FOR INSERT/UPDATE/DELETE`、`system_admin` / サービスロール `system_service` のみ）。**両名は [ADR-019 §Policy 命名規約](../../adr/019-rls-two-layer-tenant-isolation.md) に登録済 + 適用ルール 6（公開参照マスタ特例）で「school_id 非保持 かつ 公開・非 PII の両方を満たすテーブルにのみ適用」と規定済**（名前の発明ではない）— 部分実装（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`migrations/0017_weather_forecasts_rls.sql`：`weather_read_all`（USING true）+ `weather_write_system_insert/update/delete`、書込みは `system_admin` のみ）残: 書込みロールは仕様の `system_service` でなく既存 `system_admin`（TenantRole union 変更を伴う client.ts は他レーン chokepoint のため非接触、system_service 追加は follow-up）
  - SELECT 全開放の根拠: 天気は学校横断の公開・非 PII データで、漏れても無害。書き込みは system に閉じる。CRM (`system_admin_only`、読み書きとも system 限定) とは保護要件が異なる別枠
  - **サイネージ匿名セッション（[ADR-016](../../adr/016-class-magic-link-anonymous-access.md)）が確実に読めること**を RLS テストで固定（§5 参照、#128 受け入れ条件に明記）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`packages/db/__tests__/rls/weather-forecasts.test.ts`：匿名コンテキスト SELECT 可を固定）
- [~] 地域コードの解決: 各校の所在から JMA 地域コードを導出 — 部分実装（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`packages/db/src/_shared/jma-area-map.ts`：`resolveJmaAreaCode`）
  - [x] 既定: `schools.prefecture` → JMA 府県予報区コードの静的マップ（`packages/` 内のテーブル）— 実装済（`PREFECTURE_TO_JMA_AREA_CODE` 定数、Reviewer M2 でコード定数を既定と承認）
  - [ ] 上書き: より細かい市区単位を使いたい場合は `school_configs`（[#48-A](https://github.com/cometa-kaito/kimiterrace-v2/issues/112)）に `weather` 設定枠を追加（`config_kind` 拡張 or 専用列、設計時に決定）— Phase 2 後回し（2026-06-01 確定、市区粒度は着手時に確定）
- [x] migrations は drizzle-kit 生成。手書き SQL 禁止（[CLAUDE.md ルール 3](../../../CLAUDE.md)）。RLS policy は `migrations/` 配下に追加し `global-setup.ts` loader にも配線（[[migration-loader-pattern]]）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、テーブル DDL は `drizzle/20260602033423_f14_weather_forecasts.sql`、RLS/監査 FK は `migrations/0017_weather_forecasts_rls.sql`、auto-discovery loader に乗る）

### 2. 取得バッチ（Cloud Run Job `apps/jobs/weather-fetch`）

- [x] スケジュール: Cloud Scheduler から 30〜60 分間隔で起動（JMA の更新頻度に合わせる。過剰取得しない）— 実装済（[#490](https://github.com/cometa-kaito/kimiterrace-v2/pull/490)、`infrastructure/terraform/modules/cloud_run_job_weather/main.tf`：Cloud Scheduler が Job を定期起動、専用 SA は run.invoker のみ）
- [x] 取得対象: `schools` に存在する地域コードを **dedup** して、地域ごとに 1 回 JMA を取得 — 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`apps/jobs/src/weather/run.ts`：`collectAreaCodes` が府県→地域コードを dedup、`listSchools` から導出）
- [~] エンドポイント: `https://www.jma.go.jp/bosai/forecast/data/forecast/{areaCode}.json`（必要に応じ `overview_forecast/{areaCode}.json` の文章も）— 部分実装（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`apps/jobs/src/weather/run.ts`：`jmaForecastUrl` で forecast JSON を取得）残: `overview_forecast`（文章）は未取得
- [~] HTTP マナー: 明示的な `User-Agent`、タイムアウト、指数バックオフ retry。並列度を抑え JMA に負荷をかけない — 部分実装（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`apps/jobs/src/weather/run.ts`：連絡先付き明示 `User-Agent` + `AbortSignal` タイムアウト（既定 10s）、逐次取得で並列度抑制）残: 指数バックオフ retry 未実装（失敗地域は当サイクル skip し last-known-good 維持・次サイクルで回収）
- [x] 保存: `weather_forecasts` に upsert（`(area_code, source, forecast_date)` 競合で UPDATE）。`raw` に原文 JSON を保全 — 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`packages/db/src/queries/weather-forecasts.ts` `upsertWeatherForecast`：競合キー UPDATE + raw 保全。実 PG で RLS テスト固定）
- [~] 失敗時: 既存キャッシュは消さない（last-known-good 維持）。失敗は Sentry `warning`（ADR-013 Sentry、未作成 #94）+ audit_log に記録 — 部分実装（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`apps/jobs/src/weather/run.ts`：失敗地域は skip し既存行を残す last-known-good、partial は WARN ログ・全断は非ゼロ終了）残: Sentry 連携（ADR-013 未作成 #94）・audit_log への記録は未実装（fetched_at 行自体が取得台帳）
- [~] 監査: 書き込みの `created_by`/`updated_by` はサービスアカウント `system://weather-fetch`。RLS は `app.current_user_role='system_service'` を SET LOCAL — 部分実装（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`apps/jobs/src/weather/run.ts`：`withTenantContext` の system context で書込み、created_by/updated_by は null = システム）残: RLS role は仕様の `system_service` でなく既存 `system_admin`（client.ts chokepoint 回避）
- [x] egress: Job からの外向き通信は Terraform で許可範囲を明示（ADR-009 Terraform 未作成 #94 / [NFR03](../non-functional/NFR03-security.md)）— 実装済（[#493](https://github.com/cometa-kaito/kimiterrace-v2/pull/493)、VPC connector + Cloud Router + Cloud NAT を `infrastructure/terraform/modules/network` で管理、enable-time NAT precondition、ADR-009 準拠で ADR-021 閉域 egress を成立）

### 3. サイネージ表示（[F12](F12-v1-port.md) / #48-E への追記要件）

- [x] サイネージ Server Component が `weather_forecasts` を **自校の地域コードで SELECT**（外部直叩きなし）。本日 + 翌日（or 週間先頭数日）を小ウィジェットで表示 — 実装済（[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、`apps/web/lib/signage/weather.ts` `getSignageWeather`（自校 prefecture→地域コードで SELECT）+ `signage-display.ts` で `data.weather` に同梱 + `SignageClient.tsx` `WeatherWidget` が先頭数日を表示。閉域維持で外部直叩きなし）
- [x] 表示要素: 天気アイコン（JMA 天気コード → アイコンのマッピング）+ 天気テキスト + 最高/最低気温 + 降水確率 + 「○時時点」取得時刻 — 実装済（[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、`weather.ts` `weatherIconFor`（百の位で晴/曇/雨/雪・450=雷）+ `SignageClient.tsx` `WeatherDayCard`：アイコン/テキスト/気温/降水/取得時刻を描画）
- [x] 更新: 端末は他コンテンツと同じ 5〜10 秒ポーリングで DB を読む。実データ更新は Job のサイクルに従う（端末は外部に出ない）— 実装済（[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、weather は既存 signage の Server Component 経由でポーリング読取、外部 egress は Job のみ）
- [x] **鮮度（staleness）表示**: `fetched_at` が一定時間より古い（例: 6h 超）場合、「最新の取得に失敗 / ○時時点」と明示。空表示や黙った古値表示を禁止 — 実装済（[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、`weather.ts` `isForecastStale`（既定 6h・null は stale 扱い）+ `SignageClient.tsx`：isStale 時「最新の取得に失敗（古い予報を表示中）」をテキスト明示、days 空でも黙らず注記）
- [~] レイアウト: 静粛時間（quiet_hours）・広告ローテーションと干渉しない常時 or ローテ枠（#48-E のレイアウト方針に従う）— 部分実装（[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、`SignageClient.tsx` 既存レイアウト内に常時枠で組込み、weather=null は枠ごと非表示）残: quiet_hours / 広告ローテとの専用ローテ枠調整は #48-E 側に委譲（本機能では常時枠）
- [x] [NFR05](../non-functional/NFR05-accessibility.md): **色だけに依存しない**（アイコン + テキスト併記）、十分なコントラスト、遠距離視認性（大きめフォント）— 実装済（[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、`weatherIconFor` が必ず name/label を返し weatherText/iconLabel をテキスト併記、aria-label 付き、欠損値は空白でなく「—」で埋める）

### 4. セキュリティ・コスト・運用

- [x] **PII 非送信**: JMA へ送るのは地域コードのみ。リクエストに学校名・生徒・端末識別子を含めない（[ADR-021](../../adr/021-weather-data-source-jma.md)）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`apps/jobs/src/weather/run.ts`：fetch は地域コード URL + User-Agent のみ、学校/生徒/端末識別子を送らない。schema コメントにも非送信を明記）
- [x] **API キー不要**: JMA 無料 API は鍵不要。将来商用 API をフォールバック採用する場合のみ、その鍵は Secret Manager（[CLAUDE.md ルール 5](../../../CLAUDE.md)）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、JMA bosai API を鍵なしで取得。`DATABASE_URL` のみ Secret Manager 経由でハードコードなし）
- [x] コスト: JMA 無料 + 地域 dedup + 低頻度取得で実質ゼロ（[NFR06](../non-functional/NFR06-cost-policy.md) / 学校無料のビジネスモデルと整合）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)/[#490](https://github.com/cometa-kaito/kimiterrace-v2/pull/490)、無料 API + `collectAreaCodes` 地域 dedup + Scheduler 低頻度起動で実質ゼロ）
- [x] 障害耐性: JMA 障害でもサイネージは last-known-good を鮮度注記付きで表示し続け、画面全体は壊れない（[NFR02](../non-functional/NFR02-availability.md)）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)/[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、Job は失敗地域の既存行を残し、サイネージは isStale 注記付きで表示継続、weather=null は枠のみ非表示で本体は壊れない）
- [ ] 監査: weather 書き込みは audit_log 対象（[NFR04](../non-functional/NFR04-audit-log.md)）。非 PII だが全テーブル監査の原則（[CLAUDE.md ルール 1](../../../CLAUDE.md)）に従う — 未実装（取得 Job は audit_log への二重記録を follow-up に分離。weather は非 PII の共有キャッシュで fetched_at 行自体が取得台帳。auditColumns 自体は付与済）

### 5. テスト

- [x] `apps/jobs/weather-fetch` のユニット: JMA レスポンスを fixture でモックし、upsert / 失敗時の last-known-good 維持 / dedup を検証（外部ネットワークに依存しない）— 実装済（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`apps/jobs/src/weather/__tests__/run.test.ts`：dedup / 取得 fail-soft / upsert 失敗 skip / fixture モックで fetch を DI、`jma.test.ts` でパース）
- [~] `__tests__/rls/weather-forecasts.test.ts`（[CLAUDE.md ルール 2](../../../CLAUDE.md)）: 全ロール SELECT 可 / 非 system は INSERT 不可 / system_service は書き込み可 / 一意制約 upsert — 部分実装（[#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488)、`packages/db/__tests__/rls/weather-forecasts.test.ts`：全ロール + 匿名 SELECT 可 / 非 system は INSERT/UPDATE/DELETE 不可 / 競合キー upsert）残: 書込み許可ロールは `system_admin` で固定（仕様の `system_service` は未導入のため未検証）
- [x] サイネージ表示: 鮮度注記（fetched_at 古値）の分岐、天気コード→アイコンのマッピング、a11y（色非依存）— 実装済（[#495](https://github.com/cometa-kaito/kimiterrace-v2/pull/495)、`apps/web/__tests__/signage/weather.test.ts`（icon マップ / isStale 分岐 / toSignageWeather）+ `SignageWeatherWidget.test.tsx`（描画・stale テキスト明示・欠損は「—」・色非依存フォールバック））
- [ ] e2e（Playwright, [ADR-012](../../adr/012-testing-stack.md)）: Job 模擬投入 → サイネージに本日天気が反映される golden path（#48-O に同梱可）— 未実装（既存 `apps/web/e2e/signage.spec.ts` に天気貫通シナリオなし。表示は SignageWeatherWidget の component テストで検証）

## 関連

- 前段: [F12 (V1 機能移植 / サイネージ表示)](F12-v1-port.md)、#48-E（サイネージ Server Component）、#48-A（DB スキーマ基盤）
- データソース判断: [ADR-021](../../adr/021-weather-data-source-jma.md)
- セキュリティ / 閉域: [NFR03](../non-functional/NFR03-security.md)、[[closed-system-security]]（外部連携は原則後送り → 本機能は outbound・非 PII・端末非経由で例外的に許容）
- 監査 / 観測: [NFR04](../non-functional/NFR04-audit-log.md)、ADR-013 (Sentry) / ADR-014 (Observability)（いずれも未作成 [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)）
- テスト: `apps/jobs/weather-fetch/__tests__/`, `__tests__/rls/weather-forecasts.test.ts`

## 確定事項（2026-06-03 ユーザー確定）

> **2026-06-01 ユーザー判断で F14 は当初 Phase 2 後回し**だったが、その後 天気ウィジェット表示配線が実装・merge 済（第1スライス キャッシュ + JMA 取得 [#488](https://github.com/cometa-kaito/kimiterrace-v2/pull/488) / 取得 Job [#490](https://github.com/cometa-kaito/kimiterrace-v2/pull/490) / 表示配線 `6818551`）。2026-06-03 に表示仕様を以下で確定。

- **表示範囲: 本日 + 翌日**（情報量とサイネージ遠方視認性のバランス。週間＝文字が小さく視認性劣化、本日のみ＝翌日予報なしで不足、の中間を採用）
- **地域粒度: 府県予報区**（JMA 府県予報区コードで十分。市区単位は地域コード階層が複雑化し岐南工業以外への展開時のマップ保守が増えるため不採用）
- **府県 → JMA 地域コードの静的マップの置き場所: コード定数（`packages/` 内）**（固定的・小規模ゆえ DB マスタ化せずコード定数。将来 全国展開で大規模化すれば DB 化を再検討、その際は Drizzle スキーマで型単一ソース化＝[CLAUDE.md ルール 3](../../../CLAUDE.md)）
- **PoC への適用**: 既に表示配線済のため岐南工業 PoC（2026/6〜9）で表示可。上記表示範囲/粒度で運用
