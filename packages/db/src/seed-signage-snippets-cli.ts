import postgres from "postgres";
import { SIGNAGE_SNIPPET_SEEDS, validateSnippetSeeds } from "./seed-signage-snippets.js";

/**
 * サイネージ静的コンテンツ（名言/四字熟語/英単語/今日は何の日）の代表データを `signage_snippets` へ
 * 投入する **シード実行エントリ**。データ定義は {@link ./seed-signage-snippets.ts} を参照。
 *
 * ## ★ ゼロコスト枠（外部 API も Cloud Run Job も使わない）
 * weather/news 等の取得 Job とは別物。本 CLI は seed 済みの静的データを 1 度投入するだけで、定常運用の
 * 外部依存・固定費は増えない。サイネージ側は投入済みデータを日付決定論ローテで読む（取得 Job 無し）。
 *
 * ## 実行方法（ops 手順 — prod に自動適用されない）
 * - ローカル: `DATABASE_URL=postgres://... node dist/seed-signage-snippets-cli.js`
 * - staging/prod: migrate と同一イメージに本 CLI を同梱し、Cloud Run Job の command 上書き
 *   （`command=["node","dist/seed-signage-snippets-cli.js"]`）で **手動起動する ops 作業**
 *   （seed-ginan-* と同パターン。migration ではないので main merge で自動適用されない）。
 *
 * ## RLS（ルール2 / staging は migrator が非 BYPASSRLS + FORCE RLS）
 * signage_snippets は公開型 RLS（read_all USING(true) / write は system のみ、0031）。tx 内で
 * `set_config('app.current_user_role','system_admin', true)` を張り、`signage_snippets_write_system_insert`
 * policy を通して書き込む（seed の常道、seed-ginan-* と同じ）。
 *
 * ## 冪等性
 * `ON CONFLICT (category, body) DO NOTHING`（ux_signage_snippets_category_body）。再実行安全で、UI / 別シードで
 * 後から編集された行は上書きしない（DO NOTHING）。
 *
 * ## 監査（ルール1） / 秘密（ルール5）
 * created_by/updated_by は省略 = NULL（システム作成 = system://signage-snippets-seed）。created_at/updated_at
 * は DB 既定 now()。★ ログにもエラーにも DATABASE_URL を出さない（投入テキストは公開教養データゆえ出力可）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない）
 * drizzle schema barrel は pgvector 経由で `@kimiterrace/ai` に推移依存し migrate イメージで
 * ERR_MODULE_NOT_FOUND になるため、`postgres` の生 SQL で書く（migrate-cli / seed-ginan-* と同じ）。
 * データ定義 module は **型のみ**を import するので postgres を bundle に引き込まない。
 */

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  // DB に触れる前に配列の自己整合性を検証（body 非空・(category, body) 一意・on_this_day の MM-DD）。
  validateSnippetSeeds(SIGNAGE_SNIPPET_SEEDS);

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  let inserted = 0;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で signage_snippets_write_system_insert を通すため system_admin context（tx スコープ）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      for (const s of SIGNAGE_SNIPPET_SEEDS) {
        // created_by/updated_by は NULL（システム作成）。(category, body) 競合は DO NOTHING（冪等・非破壊）。
        const res = await tx<{ id: string }[]>`
          INSERT INTO signage_snippets
            (category, body, reading, meaning, attribution, month_day, active)
          VALUES
            (${s.category}, ${s.body}, ${s.reading}, ${s.meaning}, ${s.attribution}, ${s.monthDay}, true)
          ON CONFLICT (category, body) DO NOTHING
          RETURNING id`;
        if (res.length === 1) inserted++;
      }
    });

    // 件数・カテゴリ別内訳のみ（DATABASE_URL は出さない。投入テキストは公開教養データ）。
    const byCategory: Record<string, number> = {};
    for (const s of SIGNAGE_SNIPPET_SEEDS) {
      byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
    }
    console.log(
      JSON.stringify({
        event: "seed.signage.snippets.done",
        total: SIGNAGE_SNIPPET_SEEDS.length,
        inserted,
        skippedExisting: SIGNAGE_SNIPPET_SEEDS.length - inserted,
        byCategory,
      }),
    );
  } catch (err) {
    // err は postgres driver 例外。DSN 全文は含まない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
