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

## 適用方法

ローカル:
```bash
docker compose -f infrastructure/docker/docker-compose.dev.yml up -d postgres
psql "$DATABASE_URL" -f packages/db/migrations/0001_enable_rls.sql
psql "$DATABASE_URL" -f packages/db/migrations/0002_rls_policies.sql
psql "$DATABASE_URL" -f packages/db/migrations/0003_audit_trigger.sql
```

テスト (vitest が `__tests__/rls/_setup/db.ts` 経由で自動適用):
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kimiterrace_test pnpm -F db test
```

## 設計

- ADR-019: RLS 二層分離 (tenant_isolation + system_admin_full_access)
- CLAUDE.md ルール 1 (監査カラム必須) / ルール 2 (RLS 必須) / ルール 7 (テスト緑必須)
- NFR03 (security) / NFR04 (audit-log)
