/**
 * `@kimiterrace/ui` 公開バレル。
 *
 * 段1（横断基盤）の presentational プリミティブのみ。interactive 系（Button / Toast /
 * ConfirmDialog / FormField / DataTable / useUnsavedGuard）は後続 PR で追加する。
 *
 * **消費前提（重要）**: 本パッケージは `package.json` の `exports.default` が **raw TS ソース**
 * (`./src/index.ts`) を指す JIT パッケージで、dist ビルドを持たない。これは `@kimiterrace/db` /
 * `ai` / `observability` とは**異なる**（あれらは `default` が `./dist/index.js`＝実ビルド成果物）。
 * 成立条件は唯一の消費者である apps/web が Next の `transpilePackages` で `.ts`/`.tsx` を変換する
 * ことだけ。非 transpile 文脈（素の node/tsx スクリプト、esbuild-jsx 無しの vitest 等）から import
 * すると raw `.tsx` に当たって失敗するため、新たな消費者を足すときは transpile 経路を必ず用意する。
 */
export { StatusBadge } from "./StatusBadge";
export type { BadgeTone } from "./StatusBadge";
export { EmptyState } from "./EmptyState";
export { Card } from "./Card";
export * as tokens from "./tokens";
