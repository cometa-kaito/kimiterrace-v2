import { useEffect, useRef, useState } from "react";

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

/** 自動保存の状態。`incomplete`=未入力行があり保存待ち / `saving`=保存中 / `saved`=保存済み / `error`=失敗。 */
export type AutoSaveStatus = "idle" | "saving" | "saved" | "error" | "incomplete";

/** 自動保存状態の表示ラベル（色だけに依存しないテキスト、NFR05）。 */
export const AUTO_SAVE_STATUS_LABEL: Record<AutoSaveStatus, string> = {
  idle: "",
  saving: "保存中…",
  saved: "自動保存しました",
  error: "保存に失敗しました",
  incomplete: "未入力の項目があります（入力すると自動保存）",
};

type AutoSaveResult = { ok: true } | { ok: false; error: { message: string } };

/**
 * セクション編集器（予定 / 連絡 / 提出物）の **自動保存** フック（UIUX: 明示的な「保存」操作を不要にする）。
 * 追加・編集・削除した時点で、debounce 後に自動で保存する。明示ボタン・離脱ガードを置き換える。
 *
 * 安全弁:
 * - **dirty かつ全行が有効（complete）なときだけ保存**する。未入力の行があるうちは保存しない
 *   （不完全データの永続化・サーバ検証エラーの誤発火を避ける。入力が揃った時点で自動保存）。
 * - 保存成功で baseline を更新（dirty 解消）。保存中にさらに編集されていれば dirty が残り次周期で再保存。
 * - 失敗はエラーを保持し、次の編集で再試行する。
 * - `flush()` は debounce を待たず即時保存する（対象日の切替など、確実に保存してから遷移したい箇所用）。
 *
 * 値ロジック（保存ペイロードの直列化・complete 判定）は呼び出し側が担い、本フックはタイミングと状態に徹する。
 */
export function useAutoSaveSection<I>({
  serialized,
  items,
  complete,
  save,
  debounceMs = 800,
}: {
  /** `serializeForDirty(toItems(rows))` — 現在の保存ペイロードの直列化値。 */
  serialized: string;
  /** 保存ペイロード本体。 */
  items: I[];
  /** 全行が有効（保存してよい）か。false の間は保存しない。 */
  complete: boolean;
  /** 保存アクション（target/date は呼び出し側が束縛して渡す）。 */
  save: (items: I[]) => Promise<AutoSaveResult>;
  debounceMs?: number;
}): { status: AutoSaveStatus; error: string | null; dirty: boolean; flush: () => Promise<void> } {
  const baselineRef = useRef(serialized);
  const dirty = serialized !== baselineRef.current;
  const [status, setStatus] = useState<AutoSaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // タイマー経由で最新値を読むための ref（stale closure 回避）。
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const serializedRef = useRef(serialized);
  serializedRef.current = serialized;
  const completeRef = useRef(complete);
  completeRef.current = complete;
  const saveRef = useRef(save);
  saveRef.current = save;

  // 現在のスナップショットを保存する（debounce 満了 or flush から呼ぶ）。refs のみ参照するので安定。
  const runSave = useRef(async (): Promise<void> => {
    if (serializedRef.current === baselineRef.current) {
      return; // 変更なし
    }
    if (!completeRef.current) {
      return; // 不完全行があるうちは保存しない
    }
    const snapshot = itemsRef.current;
    const snapSerialized = serializedRef.current;
    setStatus("saving");
    setError(null);
    const res = await saveRef.current(snapshot);
    if (res.ok) {
      baselineRef.current = snapSerialized;
      // 保存中にさらに編集されていれば dirty が残る（次の周期で再保存）。
      setStatus(serializedRef.current === baselineRef.current ? "saved" : "idle");
    } else {
      setStatus("error");
      setError(res.error.message);
    }
  });

  useEffect(() => {
    if (!dirty) {
      return;
    }
    if (!complete) {
      setStatus("incomplete");
      return;
    }
    const timer = setTimeout(() => {
      void runSave.current();
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [serialized, dirty, complete, debounceMs]);

  return {
    status,
    error,
    dirty,
    flush: async () => {
      await runSave.current();
    },
  };
}
