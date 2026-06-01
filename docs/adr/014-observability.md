# ADR-014: 観測は Cloud Logging + Cloud Trace + OpenTelemetry

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-002 (Cloud Run)](002-cloud-run-vs-functions.md), [ADR-013 (Sentry)](013-sentry.md), [NFR03 セキュリティ](../requirements/non-functional/NFR03-security.md), [NFR04 監査ログ](../requirements/non-functional/NFR04-audit-log.md), [CLAUDE.md ルール4 (PII マスキング)](../../CLAUDE.md)

## 文脈

Cloud Run（[ADR-002](002-cloud-run-vs-functions.md)）上のアプリの**構造化ログ・分散トレース・メトリクス**を整備する。障害対応（[ADR-013 Sentry](013-sentry.md) は例外追跡）とは別に、リクエストの流れ・レイテンシ・依存（Cloud SQL / Vertex AI）の可視化が要る。

公立校データのため重要な制約:

- **ログ・トレースに PII を残さない**: ログ出力・span 属性・`Error.message` 経由で生徒名等が混入しないようマスキング（[CLAUDE.md ルール4](../../CLAUDE.md)）。
- **監査ログ（[NFR04](../requirements/non-functional/NFR04-audit-log.md)）とは別物**: 観測ログは運用可視化、`audit_log` は改竄検知付きの法定記録。混同しない。

選択肢:

- **Cloud Logging + Cloud Trace + OpenTelemetry（OTel）SDK**
- 外部 APM（Datadog / New Relic 等）
- ログのみ（トレースなし）

## 決定

**Cloud Logging + Cloud Trace + OpenTelemetry を採用**する。

- **構造化ログ**: pino 等で JSON 構造化し Cloud Logging へ。ログレベル（`trace`/`debug`/`info`/`warn`/`error`/`fatal`）を OTel/Cloud severity にマップ（PR #91 / #109 で logger 実装）。
- **分散トレース**: OpenTelemetry SDK（`@opentelemetry/sdk-node`）で span を生成し Cloud Trace へエクスポート。`withSpan` ヘルパで成功/失敗/finally を計測（PR #91 / #109 で tracer 実装、tracer.test.ts あり）。
- **ベンダー非依存**: OTel を計装の標準にすることで、将来エクスポート先を切り替え可能に。
- **PII マスキング**: ログ・span 属性・`recordException` 経由の `Error.message` に PII を載せない（[ルール4](../../CLAUDE.md)、PR #109 で警告文書化）。
- 例外追跡は [ADR-013 Sentry](013-sentry.md) に分離、観測（ログ/トレース/メトリクス）は本 ADR が担う。

## 検討した代替案

### 代替 A: 外部 APM（Datadog / New Relic 等）
- 却下理由: 高機能だが、ログ・トレースの外部送信に伴う**データ越境・egress コスト・PII 流出面**が増える。GCP ネイティブの Cloud Logging / Trace で要件を満たせる。
- 副次理由: 学校無料モデルに対し APM のシート/イベント課金が過大。

### 代替 B: ログのみ（トレースなし）
- 却下理由: Cloud SQL / Vertex AI への依存呼び出しのレイテンシ・失敗の相関をログだけで追うのは困難。分散トレースが障害解析に効く。

## 結果（Consequences）

### 良い影響
- GCP ネイティブ統合で、ログ・トレースが Cloud Run / Cloud SQL / Vertex AI と一気通貫に可視化。
- OTel 標準計装でベンダーロックインを回避し、将来のエクスポート先変更に対応。
- 例外（[ADR-013](013-sentry.md)）と観測（本 ADR）の責務分離で二重計上を防止。

### 悪い影響 / リスク
- **PII 混入リスク**: ログ・span 属性・`Error.message` 経由の PII 流出 → マスキング徹底 + 警告文書化（[ルール4](../../CLAUDE.md) / PR #109）。
- **計装コスト**: 全経路への span / 構造化ログの作り込みが要る → `withSpan` 等のヘルパで定型化。
- **コスト**: ログ/トレース量に応じた課金 → サンプリング・ログレベル運用で制御。
- **監査ログとの混同回避**: 観測ログを `audit_log`（[NFR04](../requirements/non-functional/NFR04-audit-log.md)）の代替にしない（改竄検知・法定保存は audit_log の責務）。

### トレードオフ
- 「外部 APM の高機能 vs GCP ネイティブのデータ所在・コスト」のうち、データ所在・コストを優先して **GCP ネイティブ**に振った。
- 「専用 SaaS のロックイン vs OTel 標準のベンダー非依存」のうち **OTel 標準**に振った。
