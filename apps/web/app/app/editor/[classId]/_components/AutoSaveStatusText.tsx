import { AUTO_SAVE_STATUS_LABEL, type AutoSaveStatus } from "@/lib/editor/editor-save-state";
import { dirtyTextStyle, errorTextStyle, savedTextStyle, savingTextStyle } from "./editor-styles";

/**
 * 自動保存の状態表示（予定 / 連絡 / 提出物 で共通）。明示的な「保存」ボタンを廃止し、
 * 追加・編集・削除した時点で自動保存される（{@link useAutoSaveSection}）ことを利用者に伝える。
 * 色だけに依存しないようテキスト + アイコンを併記する（NFR05）。
 */
const STATUS_STYLE: Record<AutoSaveStatus, React.CSSProperties | undefined> = {
  idle: undefined,
  saving: savingTextStyle,
  saved: savedTextStyle,
  error: errorTextStyle,
  incomplete: dirtyTextStyle,
};

const STATUS_ICON: Record<AutoSaveStatus, string> = {
  idle: "",
  saving: "",
  saved: "✓ ",
  error: "⚠ ",
  incomplete: "● ",
};

export function AutoSaveStatusText({
  status,
  error,
}: {
  status: AutoSaveStatus;
  error: string | null;
}) {
  if (status === "idle") {
    return null;
  }
  const text =
    status === "error" && error
      ? `${AUTO_SAVE_STATUS_LABEL.error}: ${error}`
      : AUTO_SAVE_STATUS_LABEL[status];
  return (
    <span style={STATUS_STYLE[status]} aria-live="polite">
      {STATUS_ICON[status]}
      {text}
    </span>
  );
}
