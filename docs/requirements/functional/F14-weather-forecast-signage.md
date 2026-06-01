# F14: サイネージ天気予報表示（気象庁データ）

- 状態: Draft（Phase 2 後回し確定 2026-06-01、MVP=F06–F11 優先）
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

- [ ] 新規テーブル `weather_forecasts`（**地域単位のキャッシュ。school_id を持たない cross-tenant 参照テーブル**、auditColumns 必須、RLS 有効）
  - `id`, `area_code`（JMA 地域コード）, `area_name`, `source`（enum `weather_source`: `jma`）, `fetched_at`, `forecast_date`（対象日）, `weather_code`（JMA 天気コード）, `weather_text`, `temp_min`, `temp_max`, `pop`（降水確率 %）, `raw (jsonb)`（原文保全）, 監査カラム
  - 一意制約: `(area_code, source, forecast_date)`（同日 1 行、再取得は upsert）
- [ ] **RLS（school_id 非保持の公開参照マスタの特例）**: policy 名 `weather_read_all`（`FOR SELECT`、`USING (true)`）+ `weather_write_system`（`FOR INSERT/UPDATE/DELETE`、`system_admin` / サービスロール `system_service` のみ）。**両名は [ADR-019 §Policy 命名規約](../../adr/019-rls-two-layer-tenant-isolation.md) に登録済 + 適用ルール 6（公開参照マスタ特例）で「school_id 非保持 かつ 公開・非 PII の両方を満たすテーブルにのみ適用」と規定済**（名前の発明ではない）
  - SELECT 全開放の根拠: 天気は学校横断の公開・非 PII データで、漏れても無害。書き込みは system に閉じる。CRM (`system_admin_only`、読み書きとも system 限定) とは保護要件が異なる別枠
  - **サイネージ匿名セッション（[ADR-016](../../adr/016-class-magic-link-anonymous-access.md)）が確実に読めること**を RLS テストで固定（§5 参照、#128 受け入れ条件に明記）
- [ ] 地域コードの解決: 各校の所在から JMA 地域コードを導出
  - 既定: `schools.prefecture` → JMA 府県予報区コードの静的マップ（`packages/` 内のテーブル）
  - 上書き: より細かい市区単位を使いたい場合は `school_configs`（[#48-A](https://github.com/cometa-kaito/kimiterrace-v2/issues/112)）に `weather` 設定枠を追加（`config_kind` 拡張 or 専用列、設計時に決定）
- [ ] migrations は drizzle-kit 生成。手書き SQL 禁止（[CLAUDE.md ルール 3](../../../CLAUDE.md)）。RLS policy は `migrations/` 配下に追加し `global-setup.ts` loader にも配線（[[migration-loader-pattern]]）

### 2. 取得バッチ（Cloud Run Job `apps/jobs/weather-fetch`）

- [ ] スケジュール: Cloud Scheduler から 30〜60 分間隔で起動（JMA の更新頻度に合わせる。過剰取得しない）
- [ ] 取得対象: `schools` に存在する地域コードを **dedup** して、地域ごとに 1 回 JMA を取得
- [ ] エンドポイント: `https://www.jma.go.jp/bosai/forecast/data/forecast/{areaCode}.json`（必要に応じ `overview_forecast/{areaCode}.json` の文章も）
- [ ] HTTP マナー: 明示的な `User-Agent`、タイムアウト、指数バックオフ retry。並列度を抑え JMA に負荷をかけない
- [ ] 保存: `weather_forecasts` に upsert（`(area_code, source, forecast_date)` 競合で UPDATE）。`raw` に原文 JSON を保全
- [ ] 失敗時: 既存キャッシュは消さない（last-known-good 維持）。失敗は Sentry `warning`（ADR-013 Sentry、未作成 #94）+ audit_log に記録
- [ ] 監査: 書き込みの `created_by`/`updated_by` はサービスアカウント `system://weather-fetch`。RLS は `app.current_user_role='system_service'` を SET LOCAL
- [ ] egress: Job からの外向き通信は Terraform で許可範囲を明示（ADR-009 Terraform 未作成 #94 / [NFR03](../non-functional/NFR03-security.md)）

### 3. サイネージ表示（[F12](F12-v1-port.md) / #48-E への追記要件）

- [ ] サイネージ Server Component が `weather_forecasts` を **自校の地域コードで SELECT**（外部直叩きなし）。本日 + 翌日（or 週間先頭数日）を小ウィジェットで表示
- [ ] 表示要素: 天気アイコン（JMA 天気コード → アイコンのマッピング）+ 天気テキスト + 最高/最低気温 + 降水確率 + 「○時時点」取得時刻
- [ ] 更新: 端末は他コンテンツと同じ 5〜10 秒ポーリングで DB を読む。実データ更新は Job のサイクルに従う（端末は外部に出ない）
- [ ] **鮮度（staleness）表示**: `fetched_at` が一定時間より古い（例: 6h 超）場合、「最新の取得に失敗 / ○時時点」と明示。空表示や黙った古値表示を禁止
- [ ] レイアウト: 静粛時間（quiet_hours）・広告ローテーションと干渉しない常時 or ローテ枠（#48-E のレイアウト方針に従う）
- [ ] [NFR05](../non-functional/NFR05-accessibility.md): **色だけに依存しない**（アイコン + テキスト併記）、十分なコントラスト、遠距離視認性（大きめフォント）

### 4. セキュリティ・コスト・運用

- [ ] **PII 非送信**: JMA へ送るのは地域コードのみ。リクエストに学校名・生徒・端末識別子を含めない（[ADR-021](../../adr/021-weather-data-source-jma.md)）
- [ ] **API キー不要**: JMA 無料 API は鍵不要。将来商用 API をフォールバック採用する場合のみ、その鍵は Secret Manager（[CLAUDE.md ルール 5](../../../CLAUDE.md)）
- [ ] コスト: JMA 無料 + 地域 dedup + 低頻度取得で実質ゼロ（[NFR06](../non-functional/NFR06-cost-policy.md) / 学校無料のビジネスモデルと整合）
- [ ] 障害耐性: JMA 障害でもサイネージは last-known-good を鮮度注記付きで表示し続け、画面全体は壊れない（[NFR02](../non-functional/NFR02-availability.md)）
- [ ] 監査: weather 書き込みは audit_log 対象（[NFR04](../non-functional/NFR04-audit-log.md)）。非 PII だが全テーブル監査の原則（[CLAUDE.md ルール 1](../../../CLAUDE.md)）に従う

### 5. テスト

- [ ] `apps/jobs/weather-fetch` のユニット: JMA レスポンスを fixture でモックし、upsert / 失敗時の last-known-good 維持 / dedup を検証（外部ネットワークに依存しない）
- [ ] `__tests__/rls/weather-forecasts.test.ts`（[CLAUDE.md ルール 2](../../../CLAUDE.md)）: 全ロール SELECT 可 / 非 system は INSERT 不可 / system_service は書き込み可 / 一意制約 upsert
- [ ] サイネージ表示: 鮮度注記（fetched_at 古値）の分岐、天気コード→アイコンのマッピング、a11y（色非依存）
- [ ] e2e（Playwright, [ADR-012](../../adr/012-testing-stack.md)）: Job 模擬投入 → サイネージに本日天気が反映される golden path（#48-O に同梱可）

## 関連

- 前段: [F12 (V1 機能移植 / サイネージ表示)](F12-v1-port.md)、#48-E（サイネージ Server Component）、#48-A（DB スキーマ基盤）
- データソース判断: [ADR-021](../../adr/021-weather-data-source-jma.md)
- セキュリティ / 閉域: [NFR03](../non-functional/NFR03-security.md)、[[closed-system-security]]（外部連携は原則後送り → 本機能は outbound・非 PII・端末非経由で例外的に許容）
- 監査 / 観測: [NFR04](../non-functional/NFR04-audit-log.md)、ADR-013 (Sentry) / ADR-014 (Observability)（いずれも未作成 [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)）
- テスト: `apps/jobs/weather-fetch/__tests__/`, `__tests__/rls/weather-forecasts.test.ts`

## 要決定（Phase 2 着手時に確定）

> **2026-06-01 ユーザー判断: F14 は Phase 2 へ後回し**（MVP=F06–F11 完成を優先、PoC 前倒しは行わない）。表示範囲・地域粒度は着手時に確定する。地域コードマップは確定時 **コード定数**（`packages/` 内）を既定とする（Reviewer M2 / 固定的・小規模）。

- 表示範囲: 本日のみ / 本日 + 翌日 / 週間（情報量とサイネージの視認性のバランス）
- 地域粒度: 府県予報区（既定）で十分か、市区単位まで必要か（JMA の地域コード階層次第）
- **府県 → JMA 地域コードの静的マップの置き場所**: コード定数（`packages/` 内）か DB マスタテーブルか。DB 化する場合は Drizzle スキーマで型単一ソース化（[CLAUDE.md ルール 3](../../../CLAUDE.md)）。固定的・小規模ならコード定数で可（Reviewer M2）
- PoC 前倒しの可否: 低コストだが Phase 2 想定。岐南工業 PoC（2026/6〜9）で初日から出したいかはユーザー判断
