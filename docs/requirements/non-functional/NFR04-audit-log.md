# NFR04: 監査ログ (10 年保管)

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §5, §8.1 から分割）
- 関連 ADR: ADR-001 (PostgreSQL), ADR-014 (Observability)
- 関連 issue: [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13)

## 概要

漏洩・改竄・誤公開発生時に「誰がどこまで見たか・何をしたか」を 10 年間立証可能にする。**監査ログがなければ責任追跡できず、サービス終了リスク**。

## 受け入れ条件

### 監査カラム

- [ ] 全テーブルに監査カラム必須（[CLAUDE.md ルール 1](../../../CLAUDE.md)）
  ```typescript
  created_at: timestamp().notNull().defaultNow(),
  updated_at: timestamp().notNull().defaultNow(),
  created_by: uuid().references(() => users.id),
  updated_by: uuid().references(() => users.id),
  ```
- [ ] ログテーブルもマスタテーブルも例外なし

### audit_log テーブル

- [ ] who: user_id, ip_address, user_agent
- [ ] what: table_name, record_id, operation (insert/update/delete), diff (jsonb)
- [ ] when: timestamp
- [ ] append-only（UPDATE/DELETE 不可、DB ロールで強制）

### AI 利用記録

- [ ] AI 利用は別途 ai_extractions / ai_chat_messages テーブルで全件保管（[F03](../functional/F03-ai-structuring.md), [F06](../functional/F06-student-qa.md)）
- [ ] プロンプト・応答・トークン数・確信度・session_id を記録

### 保管期間

- [ ] ホットストレージ 1 年（PostgreSQL on Cloud SQL）
- [ ] コールド 9 年（Cloud Storage Archive クラス）
- [ ] 日次バッチで 1 年経過分を移送
- [ ] 移送後のアクセス遅延は許容（1 時間以内に取得可能）

### 改竄検知

- [ ] 日次 hash chain で audit_log の整合性検証
- [ ] 検知時は Sentry 通知 + system_admin にメール

## 関連

- セキュリティ: [NFR03](NFR03-security.md)
- コンプライアンス: [NFR07](NFR07-compliance.md)
- インシデント: [docs/runbooks/incident-response.md](../../runbooks/incident-response.md)
- テスト: `__tests__/audit/`, `__tests__/hash-chain/`
