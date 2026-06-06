import type { CSSProperties, ReactElement, ReactNode } from "react";
import { cloneElement, isValidElement, useId } from "react";
import { color, fontSize, space } from "./tokens";

/**
 * フォーム 1 項目（ラベル + 必須印 + 補足 + コントロール + インラインエラー）の共通ラッパ。
 *
 * これまで各フォームが「ラベルと input の `htmlFor`/`id` 手配線」「エラーは送信後にまとめて 1 つ」
 * という素な作りで、**項目ごとのインライン検証フィードバックが無かった**（UX 課題の筆頭）。本コンポーネントは
 * `useId` で id を採番し、単一の子コントロールに `id` / `aria-invalid` / `aria-describedby` を
 * **自動注入**して、ラベル・補足・エラーを支援技術に正しく結ぶ。
 *
 * **Server / Client 両用**（state/effect 無し・`useId` は両環境で動く）。素な `<input>` を包むだけで使える:
 * @example
 * <FormField label="学校名" required hint="正式名称" error={errors.name}>
 *   <input name="name" required />
 * </FormField>
 *
 * 必須印（*）は装飾（`aria-hidden`）。必須の意味はコントロール側の `required` 属性で伝える。
 * エラーは `role="alert"` で即時に読み上げる。
 */
export function FormField({
  label,
  children,
  required = false,
  hint,
  error,
  htmlFor,
}: {
  label: ReactNode;
  /** 単一のフォームコントロール要素（input/select/textarea 等）。id/aria を注入する。 */
  children: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  /** インラインエラー。真値なら role=alert で表示し、コントロールに aria-invalid を立てる。 */
  error?: ReactNode;
  /** id を明示したい場合の上書き（既定は useId 採番）。 */
  htmlFor?: string;
}) {
  const generatedId = useId();
  const fieldId = htmlFor ?? generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  // 単一の子要素に id / aria を注入（ラベルと結ぶ）。要素でなければそのまま描画する。
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: fieldId,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })
    : children;

  return (
    <div style={{ marginBottom: space.lg }}>
      <label htmlFor={fieldId} style={labelStyle}>
        {label}
        {required ? (
          <span aria-hidden="true" style={{ color: color.dangerFg, marginLeft: "0.2rem" }}>
            *
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={hintId} style={hintStyle}>
          {hint}
        </p>
      ) : null}
      {control}
      {error ? (
        <p id={errorId} role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: space.xs,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: color.ink,
};
const hintStyle: CSSProperties = {
  margin: `0 0 ${space.xs}`,
  fontSize: fontSize.xs,
  color: color.muted,
};
const errorStyle: CSSProperties = {
  margin: `${space.xs} 0 0`,
  fontSize: fontSize.xs,
  color: color.dangerFg,
  fontWeight: 600,
};
