# NFR07: コンプライアンス

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §5 から分割）
- 関連 ADR: ADR-005 (Vertex AI, データ越境回避), ADR-002 (Cloud Run リージョン固定)
- 関連 issue: [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13)
- 関連 compliance: [docs/compliance/](../../compliance/)

## 概要

公立校データを扱う SaaS としての法令・ガイドライン遵守。

## 受け入れ条件

### 法的根拠

- [ ] **個人情報保護法**: 公立校生徒データの 10 年保管要件 → [NFR04](NFR04-audit-log.md) で実現
- [ ] **文部科学省「教育情報セキュリティポリシーに関するガイドライン」**準拠
- [ ] **ISMAP 相当の管理策**: クラウド事業者 (GCP) は Google が ISMAP 取得済、自社運用部分の管理策を文書化（[docs/compliance/](../../compliance/)）
- [ ] **GDPR / CCPA は対象外**（国内サービス、EU/US 居住者データは扱わない方針）

### データ越境回避

- [ ] 全 GCP リソースは **asia-northeast1（東京）** リージョン固定
- [ ] Vertex AI も asia-northeast1
- [ ] 「Google US 経由学習」を回避するため Vertex AI の data usage opt-out 設定（[ADR-005](../../adr/005-vertex-ai.md)）

### 委託先管理

- [ ] GCP DPA (Data Processing Addendum) 確認・締結
- [ ] 委託先管理表を [docs/compliance/](../../compliance/) に維持
- [ ] サブプロセッサ変更時は通知フローを定義

### 規程・契約

- [ ] 個人情報取扱規程・プライバシーポリシー（Phase 導入で人間が確定）
- [ ] SaaS 利用契約テンプレート（Phase 導入）
- [ ] サイバー保険加入（Phase 導入）

### 監査受入

- [ ] 学校設置者（教育委員会）の監査要求に応じ、audit_log / 設計書を提供可能な状態
- [ ] 「誰がどのデータにアクセスしたか」を school_id × user_id × 期間で抽出可能

## 関連

- 監査: [NFR04](NFR04-audit-log.md)
- セキュリティ: [NFR03](NFR03-security.md)
- 文書: [docs/compliance/](../../compliance/)
- 導入: [docs/runbooks/cutover.md](../../runbooks/cutover.md), [ROADMAP.md "Phase 導入"](../../ROADMAP.md)
