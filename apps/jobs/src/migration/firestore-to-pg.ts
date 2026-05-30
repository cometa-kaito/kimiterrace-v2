import { readFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";
import { runMigration } from "./import.js";
import type { V1Export } from "./types.js";

/**
 * CLI / Cloud Run Job エントリ (#48-D): 整形済み V1 エクスポート JSON を読み、V2 へ冪等インポートする。
 *
 * 使い方: `node src/migration/firestore-to-pg.ts <export.json>`
 * 必須 env: `DATABASE_URL` (**migrator ロール / BYPASSRLS**。CLAUDE.md ルール2・5 — 値は
 * Secret Manager 経由で注入し、コード/コミットされる env にハードコードしない)。
 *
 * 本ファイルは I/O 結線のみ。ロジックは transform.ts (純粋) / import.ts に置きテスト可能にする。
 */
async function main(): Promise<void> {
  const exportPath = argv[2];
  if (!exportPath) {
    throw new Error(
      "使い方: firestore-to-pg.ts <export.json> (整形済み V1 エクスポート JSON のパス)",
    );
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL (migrator ロール) が未設定。Secret Manager 経由で注入すること (ルール2/5)。",
    );
  }

  const raw = await readFile(exportPath, "utf8");
  const exportData = JSON.parse(raw) as V1Export;
  if (!exportData || !Array.isArray(exportData.schools)) {
    throw new Error("エクスポート JSON の形式が不正です (schools 配列が必要)。");
  }

  const summary = await runMigration(databaseUrl, exportData);
  // 件数サマリを info ログに (Cloud Logging に構造化ログとして残る)。secret は出さない。
  console.info(JSON.stringify({ event: "migration.firestore-to-pg.done", summary }));
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "migration.firestore-to-pg.error", message: String(err) }));
  exit(1);
});
