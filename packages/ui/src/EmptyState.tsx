import type { ReactNode } from "react";
import { color, fontSize, radius, space } from "./tokens";

/**
 * 一覧やデータが空のときの統一プレースホルダ。これまで各ページが素の `<p>空です</p>` を別々の
 * 体裁で出していたのを 1 つに集約する（見出し + 補足 + 任意のアクション導線）。
 *
 * `role="status"` で支援技術にも「内容が無い」状態を伝える。アクションには次の一手（リンク/ボタン）を
 * 置けるので、行き止まりにならない空状態を作れる。
 *
 * @example
 * <EmptyState title="まだコンテンツがありません" description="音声/チャット入力から作成できます" />
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** 次の一手（リンク/ボタン等）。行き止まり防止。 */
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      style={{
        textAlign: "center",
        padding: space.xl,
        border: `1px dashed ${color.border}`,
        borderRadius: radius.lg,
        background: color.bgSoft,
        color: color.muted,
      }}
    >
      <p style={{ margin: 0, fontSize: fontSize.lg, fontWeight: 600, color: color.ink }}>{title}</p>
      {description ? (
        <p style={{ margin: `${space.sm} 0 0`, fontSize: fontSize.sm }}>{description}</p>
      ) : null}
      {action ? <div style={{ marginTop: space.lg }}>{action}</div> : null}
    </div>
  );
}
