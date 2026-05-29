# NFR06: コスト方針

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §5 から分割）
- 関連 ADR: ADR-005 (Vertex AI), ADR-002 (Cloud Run)
- 関連 issue: [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13)

## 概要

**コスト天井は意図的に設けない**（[STATUS.md "コスト天井は当面気にしない方針"](../../STATUS.md)、2026-05-28 ユーザー判断）。
ただし**不正抑止としての rate limit はセキュリティ要件として必須**。

## 受け入れ条件

### 不正抑止 rate limit

- [ ] [F03 (AI 構造化)](../functional/F03-ai-structuring.md): school_id あたり 1 分 60 リクエスト
- [ ] [F06 (生徒対話)](../functional/F06-student-qa.md): magic_link あたり 1 分 10 質問、1 cookie あたり 1 分 10 質問
- [ ] Cloud Armor で IP ベース rate limit（DDoS 対策、1 分 1000 req/IP）
- [ ] rate limit 超過は 429 Too Many Requests + Retry-After ヘッダ

### コスト可視化

- [ ] GCP Billing Export → BigQuery で日次コストモニタリング
- [ ] 月次コストレポートを system_admin に送付（[F09](../functional/F09-monthly-report.md) と統合可）
- [ ] Vertex AI 利用は school_id 別に集計（広告主課金や原価計算に流用）

### Gemini モデル選択

- [ ] MVP は Gemini Pro 固定（精度優先）
- [ ] 将来 Flash/Pro 自動切替は Phase 2 送り（[v2-mvp.md §10](../v2-mvp.md)）

## 関連

- セキュリティ: [NFR03](NFR03-security.md)（rate limit は不正抑止セキュリティ目的）
- 観測: [ADR-014 (Observability)](../../adr/014-observability.md)
- テスト: `__tests__/api/rate-limit/`
