# ADR-021: サイネージ天気予報のデータソースは気象庁 (JMA) 無料 API + バックエンドキャッシュ

- 状態: Proposed
- 日付: 2026-05-30
- 関連: [F14 (サイネージ天気予報)](../requirements/functional/F14-weather-forecast-signage.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [NFR03 (セキュリティ)](../requirements/non-functional/NFR03-security.md), [NFR06 (コスト)](../requirements/non-functional/NFR06-cost-policy.md), memory [[closed-system-security]]。ADR-002 (Cloud Run) / ADR-001 (PostgreSQL) / ADR-009 (Terraform) は未作成（[#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)）

## 文脈

サイネージに天気予報を表示したい（[F14](../requirements/functional/F14-weather-forecast-signage.md)）。天気は外部から取得するしかない情報であり、本プロジェクトの規律 [[closed-system-security]]（「外部連携より自校内完結を優先、外部システム連携はデフォルト後送り」）と緊張関係にある。

ただし天気予報には、他の外部連携（Google Calendar / Classi 等の自動取込み）と決定的に異なる性質がある:

1. **outbound のみ・公開データ**: 取得するのは誰でもアクセスできる気象情報であり、こちらから送るのは公開の地域コードのみ。生徒・学校の PII は一切出ない。
2. **端末を外部に晒さない設計が可能**: バックエンドが取得して自社 DB にキャッシュすれば、サイネージ端末（最大 50 台/校）は外部と一切通信しない（閉域維持）。
3. **書き込み先が外部に発生しない**: 双方向同期ではなく一方向の読み取りなので、データ汚染・権限委譲のリスクがない。

この性質を踏まえ、「閉域原則の例外として許容するが、端末は外部に出さない」アーキテクチャを前提に、**データソースをどこにするか**を決める。

日本の公立高校が対象（PoC は岐阜県・岐南工業）で、ビジネスモデル上「学校は無料」（[memory: ビジネスモデル]）のためランニングコストは極小に抑えたい。

## 決定

天気データソースは **気象庁（JMA）の無料 JSON 予報 API**（`https://www.jma.go.jp/bosai/forecast/data/forecast/{areaCode}.json` 等）を採用する。

取得は **Cloud Run Job（`apps/jobs/weather-fetch`）が地域コード単位で定期取得し、Cloud SQL の `weather_forecasts` テーブルにキャッシュ**する。サイネージ端末・Server Component は **自社 DB から読むだけ**で、外部 API を直接叩かない。同一地域の複数校はキャッシュ行を共有する。

JMA へ送る情報は **公開の地域コードのみ**（例: 岐阜県 = `210000`）。学校・生徒・端末を識別する情報は送らない。

## 検討した代替案

- **商用天気 API（OpenWeatherMap / WeatherNews / Yahoo!天気 等）**: ドキュメント・SLA は整うが、(a) API キー管理（Secret Manager 運用増）、(b) スケール時の従量課金（学校無料モデルに逆行）、(c) 日本の公的予報としての権威性で JMA に劣る、ため却下。**ただし JMA 障害時のフォールバック候補としては将来再検討余地あり**（その場合キーは Secret Manager、[CLAUDE.md ルール 5](../../CLAUDE.md)）。
- **端末から直接 API を叩く**: 実装は単純だが、(a) 端末 50 台 × 各校が外部通信 = 閉域原則違反、(b) API レート/コスト増、(c) 端末ごとにネットワーク障害点が増える、ため却下。バックエンドキャッシュ方式を採る。
- **HTML スクレイピング（天気サイト）**: 無料だが (a) 構造変更で容易に壊れる、(b) 多くのサイトの ToS に抵触しうる、(c) 法定 10 年保管データの根拠として不適切、ため却下。
- **外部連携自体を見送る（天気を出さない）**: [[closed-system-security]] の最も保守的な選択。だが上記のとおり天気は outbound・非 PII・端末非経由で実装でき、生徒の実用価値（傘・服装判断）と PoC の見栄えが高いため、**例外として許容**する判断とした。

## 結果（Consequences）

**良い影響**:
- ランニングコスト実質ゼロ（無料 API + 地域 dedup + 低頻度取得）。学校無料モデルと整合。
- API キー不要 → シークレット管理の対象が増えない。
- バックエンドキャッシュにより端末は閉域維持。JMA 障害時も last-known-good を鮮度注記付きで表示でき、サイネージが壊れない（[NFR02](../requirements/non-functional/NFR02-availability.md)）。
- 公的・権威ある予報を表示できる。

**悪い影響 / トレードオフ**:
- JMA の bosai JSON API は**非公式・無保証**（ドキュメント化されておらず、フォーマットや URL が予告なく変わりうる）。→ `raw` 原文保全 + スキーマ検証 + 失敗時 last-known-good + Sentry 監視で緩和。変更時は商用 API フォールバックに切替可能な抽象化を持たせる。
- `weather_forecasts` は school_id を持たない cross-tenant 参照テーブルになり、RLS が「全ロール SELECT 可・書き込みは system のみ」という**テナント分離テーブルとは別パターン**になる（[ADR-019](019-rls-two-layer-tenant-isolation.md) の例外）。Reviewer はこの SELECT 全開放が公開・非 PII データに限った妥当な例外であることを確認する必要がある。
- 閉域原則に「外部 egress を 1 経路」開ける判断であり、その経路（Job → JMA）は Terraform で明示管理する必要がある（ADR-009 Terraform、未作成 [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)）。
- 地域コードの導出（府県 → JMA コード）の静的マップ保守が必要。市区単位まで対応する場合は粒度設計が増える。
