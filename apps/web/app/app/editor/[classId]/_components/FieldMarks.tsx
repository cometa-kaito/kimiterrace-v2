import { legendTextStyle, optionalMarkStyle, requiredMarkStyle } from "./editor-styles";

/**
 * フォームの必須/任意を**色だけに依存せず**明示する小部品（来校者一覧 / 生徒呼び出し用・finding⑨）。
 * 来校者/呼び出しは「氏名だけ必須・他は任意」だが、旧 UI は任意欄に `(任意)` プレースホルダがあるだけで
 * 必須が無印＝どれが必須か分かりにくかった。列ヘッダーに `必須`/`任意` を添え、フォーム冒頭に凡例を出す。
 */

/** 必須項目マーク（テキスト「必須」＋色）。スクリーンリーダにも読み上げられる。 */
export function RequiredMark() {
  return <span style={requiredMarkStyle}>必須</span>;
}

/** 任意項目マーク（テキスト「任意」＋控えめ色）。 */
export function OptionalMark() {
  return <span style={optionalMarkStyle}>任意</span>;
}

/** フォーム冒頭の凡例。氏名のみ必須で他は任意であることを 1 行で伝える。 */
export function RequiredLegend({ requiredFieldLabel }: { requiredFieldLabel: string }) {
  return (
    <p style={legendTextStyle}>
      <span style={requiredMarkStyle}>必須</span> は入力が必要な項目です（{requiredFieldLabel}
      のみ必須・ほかは任意）。
    </p>
  );
}
