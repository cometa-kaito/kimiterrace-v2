import type { CSSProperties, ReactNode } from "react";
import { color, radius, space } from "./tokens";

/**
 * 白背景・枠線・角丸の汎用カードコンテナ。ページ内のセクション区切りを統一する。
 * 追加の見た目は `style` でマージできる（インライン style 主体の既存コードと共存）。
 *
 * @example
 * <Card><h2>見出し</h2>...</Card>
 * <Card padded={false}>{/* テーブル等を端まで敷く *​/}</Card>
 */
export function Card({
  children,
  style,
  padded = true,
}: {
  children: ReactNode;
  style?: CSSProperties;
  /** 既定の内側余白を付けるか（テーブル等を端まで敷きたい場合は false）。 */
  padded?: boolean;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${color.border}`,
        borderRadius: radius.lg,
        padding: padded ? space.lg : 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
