import { useEffect } from "react";

/**
 * #243 (②UI-UX): 教員エディタ（予定 / 連絡 / 提出物）の **保存状態 UX** 共通ロジック。
 *
 * 普及した編集系 UI（Google ドキュメント / Notion 等）に倣い「未保存の変更がある／保存済み」を明示し、
 * **未保存のまま画面を離れる事故を防ぐ**。各エディタは Client Component なので、純ロジック（dirty 判定・
 * 状態ラベル）をここに切り出して決定的に unit し、`useUnsavedGuard` フックで離脱ガードを共通化する。
 *
 * ## dirty 判定は「保存ペイロード」基準
 * 行 state には UI 専用フィールド（行 id / カスタム入力フラグ等、保存されない値）が混ざる。dirty は
 * **実際に保存される items** を直列化して比較する（cosmetic な state 変化で誤って dirty にしない）。
 */

/** 保存ペイロードを安定直列化して dirty 比較に使う（順序・内容の差分を検出）。 */
export function serializeForDirty(value: unknown): string {
  return JSON.stringify(value);
}

/** エディタの保存状態。`idle`=初期未編集 / `dirty`=未保存の変更あり / `saved`=保存済み（編集なし）。 */
export type EditorSaveState = "idle" | "dirty" | "saved";

/**
 * dirty フラグと「一度でも保存したか」から保存状態を導く。
 * - 変更あり → `dirty`（保存していなくても保存後でも、現在値が baseline と違えば未保存）
 * - 変更なし & 保存実績あり → `saved`
 * - 変更なし & 保存実績なし → `idle`（初期表示。何も出さない）
 */
export function deriveEditorSaveState(args: {
  dirty: boolean;
  savedOnce: boolean;
}): EditorSaveState {
  if (args.dirty) {
    return "dirty";
  }
  return args.savedOnce ? "saved" : "idle";
}

/** 保存状態の表示ラベル（色だけに依存しないテキスト、NFR05）。 */
export const EDITOR_SAVE_STATE_LABEL: Record<EditorSaveState, string> = {
  idle: "",
  dirty: "未保存の変更があります",
  saved: "保存済み",
};

/**
 * 未保存の変更があるときに、タブを閉じる / リロード / 別サイトへの遷移を**ブラウザ標準の確認**で止める。
 *
 * App Router のクライアント内リンク遷移はフレームワークが安定した遮断 API を提供しないため、本フックは
 * `beforeunload`（タブ閉じ・リロード・外部遷移）を担保する。アプリ内リンク遷移に対しては、各エディタが
 * 「未保存バッジ + 保存ボタンの状態」で利用者に気付かせ、危険な経路（対象日の切替など `router.push`）は
 * 呼び出し側で `confirm` ガードする。dirty が false の間はリスナーを張らない（通常操作を邪魔しない）。
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handler = (e: BeforeUnloadEvent) => {
      // 標準仕様: preventDefault + returnValue 設定でブラウザの離脱確認を出す。
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
