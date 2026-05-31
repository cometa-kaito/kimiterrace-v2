# DB マイグレーション実行手順（本番）

PostgreSQL マイグレーションを本番 (Cloud SQL `signage-v2-prod`) に適用する手順。
特に **SECURITY DEFINER 関数を含むマイグレーションは実行ロールを誤ると静かに壊れる**ため、
その不変条件を明文化する（#147 L1）。

## 前提（誰が、いつ実行する）

- 実行者: 人間（導入フェーズ担当）。Claude は staging までで本番適用は行わない。
- タイミング: PR merge 後、新リビジョンを Cloud Run にデプロイする前。
- 対象: `packages/db/drizzle/*.sql`（drizzle 生成 DDL）+ `packages/db/migrations/*.sql`
  （手書き RLS / トリガ / SECURITY DEFINER 関数）。テスト適用順は
  `packages/db/__tests__/_setup/global-setup.ts` の loader が単一ソース。

## 必要な権限 ＝ 最重要の不変条件

**マイグレーションは必ずテーブルオーナーロール（`kimiterrace_migrator` 相当）で実行する。
アプリロール `kimiterrace_app`（非特権・RLS 強制対象）では実行しない。**

### なぜか（壊れ方）

`migrations/0008_f05_magic_link_resolve_fn.sql` の `resolve_magic_link(token_hash)` は
**SECURITY DEFINER** 関数で、**実行時に「関数オーナー」の権限で走る**。F05 の生徒匿名アクセスは、
生徒が `school_id` 未確定のまま `/s/{token}` に到達するため、この関数だけが RLS をくぐって
token → school_id を解決できる「唯一の細い扉」になっている（ADR-019 / CLAUDE.md ルール2）。

- `magic_links` は `ENABLE ROW LEVEL SECURITY` のみで **`FORCE` は付けていない** →
  テーブルオーナーは RLS をバイパスできる。
- よって関数オーナー ＝ マイグレーション実行ロールが**テーブルオーナーであれば**、関数は
  テナント横断で 1 行を引ける（設計どおり）。
- 逆にマイグレーションを**非特権ロールで流す**と、関数オーナーがその非特権ロールになり、
  RLS をバイパスできない → `resolve_magic_link` が**常に 0 行**を返す → 全生徒の
  `/s/{token}` が一律 410 Gone（**fail-closed**。情報漏洩はしないが F05 が全断する）。
- この障害は **テストでは再現しない**（CI は superuser=オーナーで流すため正常）。本番のロール
  選択でのみ顕在化するため、本 runbook で固定する。

## 手順（コピペで動く形）

```bash
# 1. migrator ロール（テーブルオーナー）で接続する。Cloud SQL Auth Proxy 経由を想定。
#    認証情報は Secret Manager から取得（JSON キーファイル禁止 = ルール5）。
export DATABASE_URL="$(gcloud secrets versions access latest --secret=db-url-migrator)"

# 2. オーナーロールであることを確認（後述の検証スニペットを先に流してもよい）。
psql "$DATABASE_URL" -c "SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;"

# 3. マイグレーション適用（適用ツールは drizzle-kit migrate もしくは loader 相当の順序で）。
pnpm --filter @kimiterrace/db migrate
```

## 検証（成功確認）

```sql
-- (a) resolve_magic_link のオーナーが migrator（テーブルオーナー）であること。
SELECT p.proname, r.rolname AS owner, r.rolbypassrls
FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
WHERE p.proname = 'resolve_magic_link';
-- owner が kimiterrace_app だったら NG（直ちに後述の是正）。

-- (b) magic_links のオーナーと resolve_magic_link のオーナーが一致すること。
SELECT c.relname, r.rolname AS owner
FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
WHERE c.relname = 'magic_links';

-- (c) 実地スモーク: 有効なクラスリンクの token_hash を 1 つ用意し、app ロールで解決できること。
SET ROLE kimiterrace_app;
SELECT * FROM resolve_magic_link('<有効な token_hash>');  -- 1 行返れば OK
RESET ROLE;
```

`(a)` のオーナーが `kimiterrace_app` 等の非特権ロールなら、生徒アクセスは全断する。

## 失敗時の対処

- **`resolve_magic_link` のオーナーが誤っている場合**: オーナーをテーブルオーナーに付け替える。
  ```sql
  ALTER FUNCTION resolve_magic_link(text) OWNER TO kimiterrace_migrator;
  ```
  付け替え後に検証 `(a)(c)` を再実行。恒久対応としてマイグレーション実行ロールを
  `kimiterrace_migrator` に固定し、CI/CD のデプロイパイプラインにも反映する。
- **migrator ロールが存在しない / 権限不足**: Cloud SQL のロールは Terraform 管理
  （`infrastructure/terraform/modules/cloud_sql/`、ルール8）。コンソールで手当てした場合は
  必ず Terraform に反映する。

## 関連

- ADR-019（二層 RLS / テナント分離）
- `packages/db/migrations/0008_f05_magic_link_resolve_fn.sql`（関数定義と設計コメント）
- CLAUDE.md ルール2（RLS を DB レベルで強制）・ルール5（シークレット）・ルール8（Terraform）
- Issue #147（本 runbook の起点 = PR #143 Reviewer L1）
