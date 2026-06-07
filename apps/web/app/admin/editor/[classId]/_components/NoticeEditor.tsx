"use client";

import {
  EDITOR_SAVE_STATE_LABEL,
  deriveEditorSaveState,
  serializeForDirty,
  useUnsavedGuard,
} from "@/lib/editor/editor-save-state";
import { setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import type { NoticeItem } from "@/lib/editor/notice-assignment-core";
import type { EditorTarget } from "@/lib/editor/schedule-core";
import { targetId } from "@/lib/editor/schedule-core";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  dirtyTextStyle,
  inputStyle,
  primaryBtnDisabledStyle,
  primaryBtnStyle,
  removeBtnStyle,
  saveBarStyle,
  savedTextStyle,
  secondaryBtnStyle,
} from "./editor-styles";
import { toEditorTarget } from "./target";

/**
 * 連絡 (お知らせ) エディタ (#48-I、段A-2 で scope 汎用化)。**Client Component** — 件の追加/削除/編集を
 * 行い、保存時に `setNoticesAction` を target (学校/学科/学年/クラス) 付きで呼ぶ。検証・認可・監査・RLS は
 * Server Action 側が担保するので、ここは入力収集と結果表示に徹する (保存後は `router.refresh()`)。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * #243 (②UI-UX): 各連絡に「表示日数」(入力日を起点に何日間サイネージに出すか) を持たせる。プリセット
 * (今日のみ/明日まで/3日間/1週間) + カスタム (1..14)。既定は今日のみ (1)。さらに未保存ガード・保存状態の
 * 明示・未変更時の保存無効化・入力 aria-label を備える（普及した編集 UI に倣う離脱事故防止）。
 */
type Row = {
  id: string;
  text: string;
  isHighlight: boolean;
  displayDays: number;
  custom: boolean;
};

/** 表示日数のプリセット (入力日を起点に N 日間)。これ以外は「カスタム」で 1..14 を直接指定。 */
const DISPLAY_DAYS_PRESETS = [
  { value: 1, label: "今日のみ" },
  { value: 2, label: "明日まで" },
  { value: 3, label: "3日間" },
  { value: 7, label: "1週間" },
] as const;
const PRESET_VALUES = new Set<number>(DISPLAY_DAYS_PRESETS.map((p) => p.value));
const DISPLAY_DAYS_MAX = 14;

function clampDisplayDays(n: number): number {
  if (!Number.isFinite(n)) {
    return 1;
  }
  return Math.min(DISPLAY_DAYS_MAX, Math.max(1, Math.round(n)));
}

/** 行 state を保存ペイロード（NoticeItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。 */
function toNoticeItems(rows: Row[]): NoticeItem[] {
  return rows.map((r) => ({
    text: r.text,
    ...(r.isHighlight ? { isHighlight: true } : {}),
    // 既定 1 (今日のみ) は省略して保存 (JSONB 最小化・後方互換)。
    ...(r.displayDays > 1 ? { displayDays: r.displayDays } : {}),
  }));
}

export function NoticeEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: NoticeItem[];
}) {
  const target = toEditorTarget(targetProp, classId);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i, idx) => {
      const dd = i.displayDays ?? 1;
      return {
        id: `r${idx}`,
        text: i.text,
        isHighlight: i.isHighlight ?? false,
        displayDays: dd,
        custom: !PRESET_VALUES.has(dd),
      };
    }),
  );
  // 新規行の安定キー用カウンタ。初期行は r0.. を使うので length から続け、衝突しない。
  const nextId = useRef(initialItems.length);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  // dirty は「保存される items」基準（行 id / custom フラグ等の UI 専用 state では誤検出しない）。
  const currentSerialized = serializeForDirty(toNoticeItems(rows));
  const baselineRef = useRef<string>(currentSerialized);
  const dirty = currentSerialized !== baselineRef.current;
  const saveState = deriveEditorSaveState({ dirty, savedOnce });
  useUnsavedGuard(dirty);

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      { id, text: "", isHighlight: false, displayDays: 1, custom: false },
    ]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function save() {
    const items = toNoticeItems(rows);
    startTransition(async () => {
      const res = await setNoticesAction(target.scope, targetId(target), date, items);
      if (res.ok) {
        baselineRef.current = serializeForDirty(items);
        setSavedOnce(true);
        setMsg({ ok: true, text: "保存しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: "720px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
        {rows.map((r, i) => (
          <li
            key={r.id}
            style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
          >
            <input
              value={r.text}
              onChange={(e) => update(i, { text: e.target.value })}
              placeholder="連絡事項"
              style={{ ...inputStyle, flex: 1, minWidth: "12rem" }}
              aria-label={`${i + 1} 件目の連絡事項`}
            />
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.85rem" }}
            >
              <input
                type="checkbox"
                checked={r.isHighlight}
                onChange={(e) => update(i, { isHighlight: e.target.checked })}
              />
              重要
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.85rem" }}
            >
              表示
              <select
                value={r.custom ? "custom" : String(r.displayDays)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "custom") {
                    update(i, { custom: true });
                  } else {
                    update(i, { custom: false, displayDays: Number(v) });
                  }
                }}
                style={inputStyle}
                aria-label={`${i + 1} 件目の表示日数`}
              >
                {DISPLAY_DAYS_PRESETS.map((p) => (
                  <option key={p.value} value={String(p.value)}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">カスタム</option>
              </select>
            </label>
            {r.custom ? (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.25rem",
                  fontSize: "0.85rem",
                }}
              >
                <input
                  type="number"
                  min={1}
                  max={DISPLAY_DAYS_MAX}
                  value={r.displayDays}
                  onChange={(e) =>
                    update(i, { displayDays: clampDisplayDays(Number(e.target.value)) })
                  }
                  style={{ ...inputStyle, width: "4rem" }}
                  aria-label={`${i + 1} 件目の表示日数 (日)`}
                />
                日間
              </label>
            ) : null}
            <button
              type="button"
              onClick={() => removeRow(i)}
              style={removeBtnStyle}
              aria-label={`${i + 1} 件目を削除`}
            >
              削除
            </button>
          </li>
        ))}
      </ul>

      <div style={saveBarStyle}>
        <button type="button" onClick={addRow} style={secondaryBtnStyle}>
          連絡を追加
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          style={pending || !dirty ? primaryBtnDisabledStyle : primaryBtnStyle}
        >
          {pending ? "保存中..." : "保存"}
        </button>
        {saveState !== "idle" ? (
          <span style={saveState === "dirty" ? dirtyTextStyle : savedTextStyle} aria-live="polite">
            {saveState === "dirty" ? "● " : "✓ "}
            {EDITOR_SAVE_STATE_LABEL[saveState]}
          </span>
        ) : null}
      </div>
    </div>
  );
}
