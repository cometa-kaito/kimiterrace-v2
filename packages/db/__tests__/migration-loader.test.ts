import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectMigrationFiles } from "../src/migrate-files";

// テストファイルは packages/db/__tests__/ にあるので、packageRoot は 1 つ上 (= packages/db)。
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * loader auto-discovery (docs/parallel-lanes.md §4) の順序契約を、実 DB を張らずに固定する。
 *
 * この順序は本番 migration 適用順の単一ソース (docs/runbooks/db-migrations.md) でもあるため、
 * 「DDL 先 → 手書き RLS/VIEW/関数 後」「各群ファイル名昇順 == 依存順」が崩れたら CI で落とす。
 */
describe("collectMigrationFiles (migration loader auto-discovery)", () => {
  const files = collectMigrationFiles(packageRoot);
  const rel = files.map((f) => f.slice(packageRoot.length).replace(/\\/g, "/"));
  const drizzle = rel.filter((p) => p.startsWith("/drizzle/"));
  const migrations = rel.filter((p) => p.startsWith("/migrations/"));

  it("drizzle/ の DDL を全て migrations/ より前に並べる", () => {
    expect(drizzle.length).toBeGreaterThan(0);
    expect(migrations.length).toBeGreaterThan(0);
    // 先頭 drizzle.length 個が drizzle、残りが migrations (2 群が交ざらない)
    expect(rel.slice(0, drizzle.length)).toEqual(drizzle);
    expect(rel.slice(drizzle.length)).toEqual(migrations);
  });

  it("各ディレクトリ内はファイル名昇順 (= 依存順になるよう採番している)", () => {
    expect(drizzle).toEqual([...drizzle].sort());
    expect(migrations).toEqual([...migrations].sort());
  });

  it("不変条件: baseline が最初、view と resolve_magic_link 関数は RLS の後に流れる", () => {
    expect(drizzle[0]).toBe("/drizzle/0000_initial_baseline.sql");
    const mi = (name: string): number => migrations.indexOf(`/migrations/${name}`);
    // effective_ads_view (0011) / resolve_magic_link 関数 (0012) は最後の RLS (feedback_rls 0010)
    // より後に適用される必要がある (この依存を 0007/0008 → 0011/0012 のリナンバで保証)。
    expect(mi("0010_feedback_rls.sql")).toBeGreaterThanOrEqual(0);
    expect(mi("0011_effective_ads_view.sql")).toBeGreaterThan(mi("0010_feedback_rls.sql"));
    expect(mi("0012_f05_magic_link_resolve_fn.sql")).toBeGreaterThan(
      mi("0011_effective_ads_view.sql"),
    );
  });

  it("*.sql 以外 (drizzle/meta/ の journal 等) を拾わない", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith(".sql"))).toBe(true);
  });
});
