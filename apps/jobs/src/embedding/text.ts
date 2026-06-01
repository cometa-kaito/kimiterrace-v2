/**
 * F06 (#365): `content_versions.snapshot` から embedding 入力テキストを組み立てる。
 *
 * snapshot は `contents-publish.ts` の `ContentSnapshot` 形（title/body/publishScope/status/targets）。
 * RAG 検索は掲示物本文への意味的近接で引くため、`title` + `body` を埋め込み対象にする
 * （publishScope/status/targets は検索意味に寄与しないので含めない）。
 *
 * 防御的に実装する: snapshot は jsonb（任意形）なので、型が欠けても落とさず空文字を返し、呼び出し側が
 * 「埋め込み対象なし（skip）」として扱えるようにする。PII マスキングは呼び出し側がここで得た
 * テキストに対し embedding 生成の直前に行う（CLAUDE.md ルール4）。
 */

interface ContentSnapshotLike {
  title?: unknown;
  body?: unknown;
}

/** snapshot から `title\nbody` を組む。文字列でないフィールドは無視。両方空なら "" を返す。 */
export function snapshotToEmbeddingText(snapshot: unknown): string {
  if (snapshot == null || typeof snapshot !== "object") return "";
  const s = snapshot as ContentSnapshotLike;
  const title = typeof s.title === "string" ? s.title.trim() : "";
  const body = typeof s.body === "string" ? s.body.trim() : "";
  return [title, body].filter((part) => part.length > 0).join("\n");
}
