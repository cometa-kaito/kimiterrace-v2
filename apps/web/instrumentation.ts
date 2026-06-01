/**
 * Next.js 起動時フック（サーバ起動で一度だけ `register` が呼ばれる）。
 *
 * F03 (#311): 本番 standalone バンドルで `pdfjs-dist/standard_fonts/` が同梱漏れすると、標準フォント
 * PDF の text 抽出がサイレントに空になり、教員入力 PDF の構造化が機能しなくなる。`next.config.ts` の
 * `outputFileTracingIncludes` で同梱を配線しているが、万一漏れても **起動時に fail-fast** させて
 * デプロイ事故を早期検知する（サイレント劣化より loud failure を選ぶ）。
 *
 * - Edge runtime では Node の fs / pdfjs を扱えないため nodejs runtime のみで実行する。
 * - `@kimiterrace/ai` は Node 専用依存（fs / pdfjs / vertex 等）を芋づるで引くため、**nodejs ガード内の
 *   動的 import** で取り込み、edge バンドルに Node グラフを載せない（PR #316 Reviewer Med-1）。
 * - 開発/テストでは node_modules にフォント実体があるため通常 throw しない。本番固有の同梱漏れを狙う。
 */
export async function register(): Promise<void> {
  // instrumentation は edge / nodejs 双方で呼ばれる。fs アクセスは nodejs runtime のみ。
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  // 本番起動のみで検査する（開発の hot-reload や CI ユニットには影響させない）。
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  const { assertStandardFontsAvailable } = await import("@kimiterrace/ai");
  assertStandardFontsAvailable();
}
