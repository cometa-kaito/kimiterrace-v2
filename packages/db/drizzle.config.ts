import { defineConfig } from "drizzle-kit";

// drizzle-kit generate / migrate のエントリポイント。
// 接続情報は DATABASE_URL を必須（Secret Manager / .env から）。
// CLAUDE.md ルール5: シークレットをファイルに直書きしない。
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // drizzle-kit はコマンド実行時にしか必要としないので、import 時に throw しない。
  // ただし誤検知防止のため明示的に警告 (config ファイルは biome.json override で noConsole 除外済)。
  console.warn("[drizzle.config] DATABASE_URL が未設定です。generate のみなら無視可。");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/kimiterrace_dev",
  },
  // 並行レーンが migration 番号で衝突しないよう timestamp prefix で採番 (docs/parallel-lanes.md §4)。
  // 生成名は `<epoch>_name.sql` となり既存 `0000..0010_*.sql` より後にソートされるので、loader の
  // ファイル名昇順 auto-discovery (= 適用順) で「既存 DDL が先・新規が後」の不変条件を保つ。
  migrations: { prefix: "timestamp" },
  strict: true,
  verbose: true,
});
