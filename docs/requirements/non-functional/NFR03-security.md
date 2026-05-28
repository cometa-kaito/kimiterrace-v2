# NFR03: セキュリティ

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §5, §7, §9 から分割）
- 関連 ADR: ADR-019 (RLS 二層, 起票予定), ADR-005 (Vertex AI)
- 関連 issue: [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13)

## 概要

公立校生徒データを 10 年保管前提で扱う。漏洩したらサービス終了レベルの責任。**「便利だが少しリスク」 vs 「やや不便だが安全」 → 安全側を選ぶ** ([CLAUDE.md](../../../CLAUDE.md))。

## 受け入れ条件

### アクセス制御

- [ ] 全 school_id 持ちテーブルに **RLS 必須**（[CLAUDE.md ルール 2](../../../CLAUDE.md)）
- [ ] BYPASSRLS は migration ロールのみ。アプリ・system_admin ロールには付与しない
- [ ] RLS テストを `__tests__/rls/` に必須化（許可 + 拒否ケース両方）
- [ ] アプリ層の `WHERE school_id = ?` には依存しない。DB レベルで強制

### 認証

- [ ] Identity Platform で全ユーザー認証
- [ ] teacher 以上は MFA 強制（[F11](../functional/F11-role-management.md)）
- [ ] custom claims 更新は特権ロール経由のみ
- [ ] JWT 検証は Next.js middleware で行い、PostgreSQL 接続時に context をセット

### 通信

- [ ] HTTPS 強制、HSTS 有効
- [ ] Cloud Armor で WAF + IP rate limit
- [ ] アプリ層 rate limit: [F03](../functional/F03-ai-structuring.md)（school_id 1分60req）、[F06](../functional/F06-student-qa.md)（magic_link 1分10req）

### PII 取扱い（Vertex AI 送信時）

- [ ] PII マスキングは Vertex AI 送信前必須（[CLAUDE.md ルール 4](../../../CLAUDE.md), [v2-mvp.md §9](../v2-mvp.md)）
- [ ] embedding はマスキング後テキストで生成（pgvector に PII を残さない）
- [ ] マスキング対応表は session 単位で破棄

### シークレット

- [ ] シークレットは Secret Manager のみ（[CLAUDE.md ルール 5](../../../CLAUDE.md)）
- [ ] `.env*` はコミット禁止、`.env.example` のみ
- [ ] gitleaks を pre-commit + CI に
- [ ] service account JSON キーファイル禁止（Workload Identity Federation 使用）

### magic_link

- [ ] 短縮 URL の token は予測困難（cryptographically random）
- [ ] 漏洩検知時の即時失効フローを runbook 化

## 関連

- 全機能（特に [F03](../functional/F03-ai-structuring.md), [F05](../functional/F05-class-magic-link.md), [F06](../functional/F06-student-qa.md)）
- 監査: [NFR04](NFR04-audit-log.md)
- コンプライアンス: [NFR07](NFR07-compliance.md)
- 脅威モデル: [docs/architecture/threat-model.md](../../architecture/) (STRIDE, 起票予定)
- テスト: `__tests__/rls/`, `__tests__/security/`
