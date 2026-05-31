# packages/db/migrations

RLS / トリガ等、**drizzle-kit generate では生成できない手書き SQL マイグレーション** を
番号付きで配置する。テーブル DDL 本体は `drizzle-kit generate` が `../drizzle/` に出力する
別系統 (Part A/B/C1 のスキーマ) を使う想定で、本ディレクトリは「DDL の上に重ねる
セキュリティ層」を専用に扱う。

## 適用順

| 番号 | 役割 |
|---|---|
| `0001_enable_rls.sql` | テナント分離テーブル + CRM テーブル + audit_log に `ENABLE ROW LEVEL SECURITY` |
| `0002_rls_policies.sql` | tenant_isolation policy + system_admin_full_access policy + ロール権限 (BYPASSRLS は migrator のみ) |
| `0003_audit_trigger.sql` | audit_log の append-only 強制 + `prev_hash`/`row_hash` 自動計算トリガ |
| `0004_audit_fk.sql` | 全 18 テーブルの `created_by`/`updated_by` に `users(id)` FK 追加 (`ON DELETE SET NULL`)。`_shared/audit.ts` は循環依存回避のため drizzle 側で FK を付けず、本 migration で物理 FK を付与する設計 |

## 新しい migration を追加するとき (auto-discovery)

`__tests__/_setup/global-setup.ts` の loader は **drizzle/ と migrations/ を走査してファイル名
昇順で全件適用**する (docs/parallel-lanes.md §4)。新しい migration は **loader を編集せず**、適切な
番号 prefix の `*.sql` を置くだけでよい (並行レーンが loader の行で衝突しない = chokepoint 解消)。

- **ファイル名昇順 == 適用順 == 依存順**。後から依存するものほど大きい番号を振る。
- drizzle 生成 DDL は `drizzle-kit generate` が `migrations.prefix: "timestamp"` で
  `<epoch>_name.sql` を出力する (並行レーンの採番衝突なし)。手書き migration も時刻/単調 prefix を推奨。
- `0000..0010` の既存番号は timestamp prefix より小さくソートされるので、移行後も「既存が先・新規が後」を保つ。
- 例: `0011_effective_ads_view.sql` と `0012_f05_magic_link_resolve_fn.sql` は RLS (0001-0010)
  適用後に流す必要があるため、生成時期より大きい番号を採番している (旧 0007/0008 からリナンバ)。

## 適用方法

ローカル:
```bash
docker compose -f infrastructure/docker/docker-compose.dev.yml up -d postgres
psql "$DATABASE_URL" -f packages/db/migrations/0001_enable_rls.sql
psql "$DATABASE_URL" -f packages/db/migrations/0002_rls_policies.sql
psql "$DATABASE_URL" -f packages/db/migrations/0003_audit_trigger.sql
psql "$DATABASE_URL" -f packages/db/migrations/0004_audit_fk.sql
```

テスト (vitest が `__tests__/_setup/global-setup.ts` 経由で自動適用):
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kimiterrace_test pnpm -F db test
```

### test-DB ガード (Issue #96 H1)

`global-setup.ts` は `DROP SCHEMA public CASCADE` を実行するため、prod / staging DB に
誤接続すると即時に schema 全消失する。以下のいずれかを満たさない場合は **abort** する:

1. 環境変数 `KIMITERRACE_TEST_DB_OK=1` が明示設定されている (CI で正攻法)
2. ホストが `localhost` / `127.0.0.1` / `::1` / `host.docker.internal`
3. DB 名に `test` を含む

### TRUNCATE 衝突防止 (Issue #96 H2)

`seedBaseFixture` (`__tests__/_setup/db.ts`) は冒頭で 18 テーブルを TRUNCATE する。
複数 test ファイルが並列実行されると data race が起こるため、`vitest.config.ts` で
`fileParallelism: false` + `pool: 'forks'` + `singleFork: true` を **明示** している。
将来 fileParallelism を有効化したい場合は、test ごとに独自 schema or savepoint へ
切り替える設計変更が必要 (work expansion 大、別途 Issue 化推奨)。

## 設計

- ADR-019: RLS 二層分離 (tenant_isolation + system_admin_full_access)
- CLAUDE.md ルール 1 (監査カラム必須) / ルール 2 (RLS 必須) / ルール 7 (テスト緑必須)
- NFR03 (security) / NFR04 (audit-log)
