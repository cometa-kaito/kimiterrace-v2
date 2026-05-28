# ADR-019: RLS 二層分離（school_id テナント + system_admin cross-tenant）

- 状態: Proposed
- 日付: 2026-05-28
- 関連: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13), [F11](../requirements/functional/F11-role-management.md), [NFR03](../requirements/non-functional/NFR03-security.md), [v2-mvp.md §7](../requirements/v2-mvp.md), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [CLAUDE.md ルール 2](../../CLAUDE.md)

## 文脈

マルチテナント分離方式を確定する必要がある。本システムは:

- 学校テナント（school_id）が互いに完全分離されるべき（漏洩したらサービス終了）
- ただし system_admin（奥村さんのみ）は全テナント横断のアクセスが必要（CRM, 月次レポート集計）
- CRM 系テーブル（advertisers / contracts / communications）はテナント横断（school_id を持たない）

選択肢:
- アプリ層フィルタ（クエリに `WHERE school_id = ?` を書く）
- PostgreSQL RLS 単層（school_id のみ）
- PostgreSQL RLS 二層（school_id テナント + system_admin cross-tenant policy）
- スキーマ分離（学校ごとに別 schema）
- 物理 DB 分離（学校ごとに別 DB インスタンス）

## 決定

**PostgreSQL RLS 二層分離**を採用する:

### レイヤー 1: テナント分離ポリシー（全 school_id 持ちテーブル）

```sql
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON schedules
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid);
```

### レイヤー 2: system_admin cross-tenant ポリシー

```sql
CREATE POLICY system_admin_full_access ON schedules
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin');
```

### コンテキスト設定

Next.js Route Handler 内でトランザクション開始時に:

```typescript
await db.execute(sql`
  SET LOCAL app.current_user_id = ${userId};
  SET LOCAL app.current_school_id = ${schoolId};
  SET LOCAL app.current_user_role = ${role};
`);
```

### CRM テーブル（school_id を持たない）

RLS 対象外。アプリケーション middleware で system_admin チェック（[ADR-018](018-custom-crm-design.md)）。

### BYPASSRLS

migration 専用ロール (`migrator`) のみ。app/admin ロールには付与しない。

### テスト

- 許可ケース（自 school_id データ可視）
- 拒否ケース（別 school_id データ不可視）
- system_admin（全 school_id 可視）
- 未設定（settings 未セット時はアクセス拒否）
- migration ロール（全件可視、管理用途のみ）

`__tests__/rls/` に Testcontainers で実 PostgreSQL を起動して検証（[ADR-012](012-testing-stack.md)）。

## 検討した代替案

### 代替 A: アプリ層フィルタのみ
- 却下理由: アプリのバグで `WHERE school_id = ?` が抜けた場合、全テナント漏洩する設計上のリスクが致命的
- 副次理由: [CLAUDE.md ルール 2](../../CLAUDE.md) に明示反対: 「DB レベルで強制する」
- 副次理由: 監査要件（[NFR07](../requirements/non-functional/NFR07-compliance.md)）に対して「アプリ防御のみ」では説明が苦しい

### 代替 B: RLS 単層（system_admin の cross-tenant は別経路）
- 却下理由: system_admin 用に別の管理 DB ロールを用意すると、認可ロジックがアプリ層と DB 層に二重化する
- 副次理由: system_admin 操作も audit_log で追跡したいが、別ロールだとセッション設定がねじれる

### 代替 C: スキーマ分離（学校ごとに別 schema）
- 却下理由: 学校数 100 校規模で schema 数が増加し、migration 運用が破綻
- 副次理由: cross-tenant クエリ（system_admin の月次集計）が UNION ALL の動的生成になり実装複雑化

### 代替 D: 物理 DB 分離（学校ごとに別 Cloud SQL インスタンス）
- 却下理由: コスト膨張（学校数 100 校で Cloud SQL 100 インスタンス）
- 副次理由: 接続プール・migration・バックアップが学校ごとになり運用負荷甚大

### 代替 E: SECURITY DEFINER 関数で cross-tenant 実装
- 却下理由: SECURITY DEFINER は RLS をバイパスする副作用があり、誤用すると意図しないテナント越境
- 副次理由: [CLAUDE.md ルール 2](../../CLAUDE.md) に NG パターンとして明記

## 結果（Consequences）

### 良い影響

- DB レベルでテナント分離が強制され、アプリ層のバグが即漏洩につながらない
- system_admin の cross-tenant 操作も同じ RLS 機構で表現でき、認可ロジックが一元化
- RLS テストが SQL レベルで書けるため、Firestore セキュリティルール時代より検証容易（[CLAUDE.md ルール 2](../../CLAUDE.md)）
- migration ロールに BYPASSRLS を集約することで、特権境界が明確
- [NFR03](../requirements/non-functional/NFR03-security.md), [NFR07](../requirements/non-functional/NFR07-compliance.md) の監査要件に対して「DB レベル強制」と説明可能

### 悪い影響 / リスク

- **`SET LOCAL` の漏れリスク**: トランザクション境界外（コネクションプール再利用）で context が残ると別ユーザーに混入 → middleware で SET LOCAL を必須化、テスト必須
- **`current_setting(..., true)` の `true` 引数**: missing_ok を指定しないと未設定時に ERROR、true だと NULL を返して `school_id = NULL` が False になり結果として拒否 → 拒否がデフォルトになる設計だが、明示テスト必要
- **RLS のパフォーマンス影響**: 大規模テーブルで全クエリに `WHERE school_id = X` が暗黙追加されるためインデックス設計が重要 → school_id を全 RLS テーブルの先頭インデックスに含める
- **CRM テーブルの RLS 対象外問題**: アプリ層 system_admin チェック漏れが全広告主漏洩に直結 → middleware の system_admin チェック必須化、CRM ハンドラ専用 e2e テスト必須

### トレードオフ

- 「アプリ防御 vs DB 防御」のうち **DB 防御** に振った設計
- 「単層シンプル vs 二層柔軟」のうち **二層柔軟** に振った設計（system_admin cross-tenant 要件に対応するため）
- 「物理分離の堅牢性 vs 論理分離のコスト効率」のうち **論理分離のコスト効率** に振った設計
- 将来 ISMAP 要件等で「物理分離必須」が来た場合、本 ADR を Superseded として再評価可能
