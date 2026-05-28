import { defineConfig } from "drizzle-kit";

// drizzle-kit generate / migrate のエントリポイント。
// 接続情報は DATABASE_URL を必須（Secret Manager / .env から）。
// CLAUDE.md ルール5: シークレットをファイルに直書きしない。
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // drizzle-kit はコマンド実行時にしか必要としないので、import 時に throw しない。
  // ただし誤検知防止のため明示的に警告。
  // biome-ignore lint/suspicious/noConsoleLog: drizzle-kit CLI 向けの起動時警告
  console.warn("[drizzle.config] DATABASE_URL が未設定です。generate のみなら無視可。");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/kimiterrace_dev",
  },
  strict: true,
  verbose: true,
});
