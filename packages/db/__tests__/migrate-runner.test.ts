import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate-runner";

/**
 * 本番 migration runner (`applyMigrations`) の hermetic テスト。**実 PG を張らない**。
 *
 * runner の不変条件 (拡張を先に / `_schema_migrations` 追跡 / 未適用のみ per-file tx /
 * 適用順 / GRANT 後処理 / ロール名検証 / secret 非ログ) を、発行 SQL を記録する fake
 * client で固定する。RLS テストと違い DB 接続不要なので DATABASE_URL なしでも常に走る。
 */

// ---- 記録用 fake postgres-js client -------------------------------------------------

/** tagged-template 呼び出しを「strings を ${} で繋いだ」読める文字列に復元する。 */
function renderTagged(strings: TemplateStringsArray, values: readonly unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += `\${${String(values[i])}}${strings[i + 1] ?? ""}`;
  }
  return out;
}

interface FakeClient {
  // tagged-template 呼び出し
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  unsafe(query: string): Promise<unknown>;
  begin<T>(cb: (tx: FakeTx) => Promise<T>): Promise<T>;
}

interface FakeTx {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  unsafe(query: string): Promise<unknown>;
}

/**
 * 発行された全 SQL を `statements` 配列へ順に記録する fake client を作る。
 * `appliedFilenames` は `SELECT filename FROM _schema_migrations` の戻り値を擬似する
 * (= 既適用集合)。それ以外の `.unsafe` は空配列を返す。
 */
function makeFakeClient(appliedFilenames: string[] = []): {
  client: FakeClient;
  statements: string[];
} {
  const statements: string[] = [];

  const unsafe = (query: string): Promise<unknown> => {
    statements.push(query);
    if (query.includes("SELECT filename FROM _schema_migrations")) {
      return Promise.resolve(appliedFilenames.map((filename) => ({ filename })));
    }
    return Promise.resolve([]);
  };

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    statements.push(renderTagged(strings, values));
    return Promise.resolve([]);
  };

  const begin = async <T>(cb: (tx: FakeTx) => Promise<T>): Promise<T> => {
    const tx = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
        statements.push(renderTagged(strings, values));
        return Promise.resolve([]);
      },
      {
        unsafe: (query: string): Promise<unknown> => {
          statements.push(query);
          return Promise.resolve([]);
        },
      },
    ) as FakeTx;
    return await cb(tx);
  };

  const client = Object.assign(tagged, { unsafe, begin }) as FakeClient;
  return { client, statements };
}

// ---- tmp パッケージルート (drizzle/ + migrations/) -----------------------------------

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kt-migrate-runner-"));
  mkdirSync(join(root, "drizzle"), { recursive: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  // collectMigrationFiles は drizzle/ → migrations/ をファイル名昇順で返す。
  writeFileSync(join(root, "drizzle", "0000_a.sql"), "CREATE TABLE a();\n", "utf-8");
  writeFileSync(join(root, "migrations", "0001_b.sql"), "SELECT 1;\n", "utf-8");
});

afterAll(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("applyMigrations (production migration runner, hermetic)", () => {
  it("拡張を loop より先に作る (vector が最初・pgcrypto が次)", async () => {
    const { client, statements } = makeFakeClient();
    await applyMigrations(client, root, { log: () => {} });

    expect(statements[0]).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(statements[1]).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  });

  it("_schema_migrations 追跡テーブルを CREATE する", async () => {
    const { client, statements } = makeFakeClient();
    await applyMigrations(client, root, { log: () => {} });

    const createTracking = statements.find(
      (s) => s.includes("CREATE TABLE IF NOT EXISTS _schema_migrations") && s.includes("filename"),
    );
    expect(createTracking).toBeDefined();
  });

  it("空の適用済み集合では両ファイルを順に適用し各々記録する", async () => {
    const { client, statements } = makeFakeClient([]);
    await applyMigrations(client, root, { log: () => {} });

    // 0000_a (CREATE TABLE a) は ; 分割で () 付きの DDL が流れる。
    const idxA = statements.findIndex((s) => s.includes("CREATE TABLE a"));
    const idxB = statements.findIndex((s) => s.includes("SELECT 1"));
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    // drizzle/0000_a が migrations/0001_b より先 (適用順契約)。
    expect(idxA).toBeLessThan(idxB);

    // 各ファイルが _schema_migrations に記録される (tagged-template INSERT)。
    const insertA = statements.find(
      (s) => s.includes("INSERT INTO _schema_migrations") && s.includes("drizzle/0000_a.sql"),
    );
    const insertB = statements.find(
      (s) => s.includes("INSERT INTO _schema_migrations") && s.includes("migrations/0001_b.sql"),
    );
    expect(insertA).toBeDefined();
    expect(insertB).toBeDefined();
  });

  it("適用済み集合に含まれるファイルは skip し再適用しない", async () => {
    const { client, statements } = makeFakeClient(["drizzle/0000_a.sql"]);
    const skipped: string[] = [];
    await applyMigrations(client, root, { log: (m) => skipped.push(m) });

    // 0000_a は skip → DDL も INSERT も出ない。
    expect(statements.some((s) => s.includes("CREATE TABLE a"))).toBe(false);
    expect(
      statements.some(
        (s) => s.includes("INSERT INTO _schema_migrations") && s.includes("drizzle/0000_a.sql"),
      ),
    ).toBe(false);
    expect(skipped).toContain("skip drizzle/0000_a.sql");

    // 0001_b は未適用なので適用される。
    expect(statements.some((s) => s.includes("SELECT 1"))).toBe(true);
  });

  it("grantAppRoleMember 指定で GRANT kimiterrace_app TO <member> を loop 後に発行する", async () => {
    const { client, statements } = makeFakeClient();
    await applyMigrations(client, root, { grantAppRoleMember: "app", log: () => {} });

    const grant = statements.find((s) => s === "GRANT kimiterrace_app TO app");
    expect(grant).toBeDefined();
    // GRANT は全 migration の後 (最後の INSERT より後ろ)。
    const lastInsert = statements
      .map((s, i) => (s.includes("INSERT INTO _schema_migrations") ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    const grantIdx = statements.indexOf("GRANT kimiterrace_app TO app");
    expect(grantIdx).toBeGreaterThan(lastInsert);
  });

  it("不正な grantAppRoleMember (SQL インジェクション試行) は throw する", async () => {
    const { client } = makeFakeClient();
    await expect(
      applyMigrations(client, root, {
        grantAppRoleMember: "app; DROP ROLE kimiterrace_app",
        log: () => {},
      }),
    ).rejects.toThrow();
  });

  it("発行 SQL に DATABASE_URL らしき接続文字列が混入しない", async () => {
    const { client, statements } = makeFakeClient();
    await applyMigrations(client, root, { grantAppRoleMember: "app", log: () => {} });

    for (const s of statements) {
      expect(s).not.toMatch(/postgres(ql)?:\/\//i);
      expect(s.toLowerCase()).not.toContain("password");
    }
  });
});
