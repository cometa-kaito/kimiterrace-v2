/**
 * F01/F02 (#509 S3b): 教員入力 → 下書き content 橋渡しの**純粋コア** (型 + title 導出)。
 *
 * `"use server"` ファイル (draft-actions.ts) は async 関数しか export できないため、純粋ロジックと
 * 型はここに分離し、action とテストの両方から import する (publish-core.ts と同方針)。
 */

/** content.title の最大長 (DB: varchar(300))。draft-core でも導出時に丸める。 */
export const DRAFT_TITLE_MAX_LENGTH = 300;

/** 下書き作成 Server Action の戻り値 (例外を投げ返さず UI が分岐できる discriminated union)。 */
export type CreateDraftResult =
  | { ok: true; contentId: string }
  | {
      ok: false;
      code: "invalid_input" | "not_found" | "no_transcript" | "forbidden";
      message: string;
    };

/**
 * transcript から下書きの title を導出する。最初の非空行をトリムし `DRAFT_TITLE_MAX_LENGTH` で丸める。
 * 本文が空 / 空白のみなら既定値「無題の下書き」。教員は作成後にエディタで自由に編集できる前提。
 */
export function deriveDraftTitle(transcript: string | null | undefined): string {
  if (typeof transcript !== "string") {
    return "無題の下書き";
  }
  const firstLine = transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) {
    return "無題の下書き";
  }
  return firstLine.length > DRAFT_TITLE_MAX_LENGTH
    ? firstLine.slice(0, DRAFT_TITLE_MAX_LENGTH)
    : firstLine;
}
