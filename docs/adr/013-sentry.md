# ADR-013: エラー追跡は Sentry を採用

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-014 (観測)](014-observability.md), [ADR-002 (Cloud Run)](002-cloud-run-vs-functions.md), [NFR03 セキュリティ](../requirements/non-functional/NFR03-security.md), [CLAUDE.md ルール4 (PII マスキング)](../../CLAUDE.md)

## 文脈

本番障害の早期検知・原因特定のため、例外を集約・グルーピング・通知する仕組みが要る（[docs/runbooks/incident-response.md](../runbooks/incident-response.md) と連動）。Cloud Run（[ADR-002](002-cloud-run-vs-functions.md)）上の Next.js（フロント + サーバ）両方の例外を扱いたい。

公立校データを扱うため重要な制約:

- **PII を追跡サービスに送らない**: スタックトレース・リクエストコンテキストに生徒名等が混入しないよう、送信前にスクラブする（[CLAUDE.md ルール4](../../CLAUDE.md) の思想を例外追跡にも適用）。
- リリース追跡・ソースマップ・アラート連携。

選択肢:

- **Sentry**
- Google Cloud Error Reporting
- 自前（ログ集約のみ + 手動運用）

## 決定

**Sentry を採用**する。

- フロント / サーバ両方の例外を集約し、グルーピング・リリース追跡・ソースマップ・アラートを得る。
- **PII スクラブ必須**: `beforeSend` 等で例外メッセージ・コンテキストから PII を除去してから送信（[ルール4](../../CLAUDE.md)）。観測経路で `Error.message` 等に PII が乗りうる点は [ADR-014](014-observability.md) と共通の注意（PR #109 で警告文書化）。
- DSN 等の設定は Secret Manager（[ルール5](../../CLAUDE.md)）。
- 観測の全体像（ログ・トレース）は [ADR-014](014-observability.md) が担い、Sentry は**例外追跡に責務を限定**して二重計上を避ける。

## 検討した代替案

### 代替 A: Google Cloud Error Reporting
- 却下理由: GCP ネイティブで Cloud Logging と統合される利点はあるが、例外のグルーピング・リリース追跡・ソースマップ・アラートの DX が Sentry に劣る。
- 補足: ログ/トレースの主軸は Cloud Logging + Cloud Trace（[ADR-014](014-observability.md)）。Error Reporting と Sentry の役割が重なる部分は Sentry に寄せ、観測は OTel 経由で Cloud に流す。

### 代替 B: 自前（ログ集約のみ + 手動運用）
- 却下理由: 例外のグルーピング・通知・トレンドを自前で作るのは運用負荷が高く、障害検知が遅れる。

## 結果（Consequences）

### 良い影響
- 例外の集約・グルーピング・アラートで障害検知が速くなる（incident-response runbook と連動）。
- リリース追跡・ソースマップで原因特定が容易。

### 悪い影響 / リスク
- **PII 送信リスク**: スクラブ漏れが外部サービスへの PII 流出に直結 → `beforeSend` スクラブのテスト必須、`Error.message` への PII 混入経路に注意（[ADR-014](014-observability.md) / PR #109）。
- **外部依存・コスト**: 外部 SaaS への依存とイベント量課金 → サンプリング・環境別 DSN で制御。
- **二重計上**: Error Reporting と併用すると重複 → 例外は Sentry に一本化。

### トレードオフ
- 「GCP ネイティブ統合（Error Reporting）vs Sentry の DX」のうち、障害対応の実効性を優先して **Sentry の DX**に振った。
- 外部送信のリスクは **PII スクラブ必須化**で受容する判断（[ルール4](../../CLAUDE.md)）。
