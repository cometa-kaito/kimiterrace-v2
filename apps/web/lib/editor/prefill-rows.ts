/**
 * エディタ「行の事前生成」共通ヘルパ（盤面の固定表示枠ぶんの入力スロットを最初から見せる）。
 *
 * 盤面は各編集ブロックを {@link import("@/lib/signage/pattern-blocks").PATTERN_BLOCK_ROW_CAPACITY} の
 * 行数ぶんの「規定枠」で見せる。エディタ側はその数まで**空行を先に並べておき**、教員が「盤面に何行出るか」を
 * 入力前から把握できるようにする（規定を超えた分は盤面が自動スクロールで送る）。
 *
 * 純関数なので unit でき、client/server どちらからも import できる（postgres 非依存）。
 */

/**
 * `rows` を `minRows` まで空行で埋める。既存行が `minRows` 以上ならそのまま返す（**切り詰めない**＝既存入力を
 * 失わない）。`makeBlank` には埋める各行の最終 index（`rows.length` 始まり）を渡す（安定キー採番や時限の連番
 * 付与に使う）。`minRows <= 0` は no-op（事前生成を無効化＝従来挙動）。元配列は破壊しない。
 */
export function padBlankRows<T>(
  rows: readonly T[],
  minRows: number,
  makeBlank: (index: number) => T,
): T[] {
  const out = [...rows];
  for (let i = rows.length; i < minRows; i++) {
    out.push(makeBlank(i));
  }
  return out;
}
