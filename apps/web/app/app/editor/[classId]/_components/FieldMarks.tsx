import { tokens } from "@kimiterrace/ui";

/**
 * 入力フォームの **必須 / 任意 の明示** を共通化する小部品（来校者一覧 / 生徒呼び出しで共有）。
 *
 * LEDGER v2-ed-uo9（任意項目が任意と分かりにくい）への対応。色だけに依存せずテキスト記号で伝える（NFR05）:
 * - 必須列ヘッダーには {@link RequiredMark}（朱の「*」＋ SR 向け「必須」）を添える。
 * - 任意項目は従来どおり placeholder 先頭の「(任意)」で示す（既存挙動・e2e 温存）。
 * - フォーム冒頭に {@link FieldLegend} で凡例（「* = 必須」）を 1 度だけ出し、各行で繰り返さない。
 *
 * 値（色）の権威は `@kimiterrace/ui` の tokens（生 hex を持たない）。
 */

/** 必須を示す記号。視覚は朱の「*」、スクリーンリーダには「必須」と読ませる。 */
export function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" style={{ color: tokens.color.dangerFg, marginLeft: "0.15rem" }}>
        *
      </span>
      <span
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        （必須）
      </span>
    </>
  );
}

/** フォーム冒頭の凡例（「* = 必須」）。各行で必須/任意を繰り返さず 1 度だけ示す（引き算）。 */
export function FieldLegend() {
  return (
    <p style={{ margin: 0, fontSize: tokens.fontSize.xs, color: tokens.color.muted }}>
      <span aria-hidden="true" style={{ color: tokens.color.dangerFg }}>
        *
      </span>{" "}
      = 必須。それ以外は任意です。
    </p>
  );
}
