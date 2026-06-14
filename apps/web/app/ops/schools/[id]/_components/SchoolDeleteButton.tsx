"use client";

import { deleteSchoolAction } from "@/lib/system-admin/schools-actions";
import { isTestSchoolName } from "@/lib/system-admin/schools-core";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

/**
 * #48-L4 (#123) / 運営整理 §4: 学校削除ボタン。**Client Component** — 認可・子データ保護 (FK RESTRICT)・
 * 監査・テスト校ガードは Server Action 側と RLS が担保するので、ここは確認と結果表示に徹する。子データが
 * 残る学校は conflict メッセージを表示する (削除されない)。
 *
 * **誤操作防止 (#246 Low-2)**: hard-delete は不可逆なため、`window.confirm` の 1 クリックではなく
 * 校名タイプ確認を要求する。削除を押すと確認パネルが開き、対象校名を正確に入力するまで実行ボタンを
 * 無効にする (隣接行を誤って消す事故を構造的に防ぐ)。
 *
 * **テスト校削除禁止 (運営整理 §4)**: 校名に「テスト」を含む検証用テナントは削除ボタン自体を無効化する
 * (`isTestSchoolName`、Server Action と同じ単一ソース)。UI を迂回しても Server Action が forbidden を返す。
 */
export function SchoolDeleteButton({
  schoolId,
  schoolName,
}: {
  schoolId: string;
  schoolName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const inputId = useId();

  // 前後空白は許容するが、それ以外は校名と完全一致を要求する (大文字小文字・全半角はそのまま)。
  const matches = typed.trim() === schoolName;
  // 検証用テスト校は削除禁止 (運営整理 §4)。判定は Server Action と同じ単一ソース。
  const isTestSchool = isTestSchoolName(schoolName);

  function reset() {
    setConfirming(false);
    setTyped("");
    setError(null);
  }

  function onSubmit() {
    if (!matches || pending) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteSchoolAction({ id: schoolId });
      if (res.ok) {
        router.push("/ops/schools");
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  if (isTestSchool) {
    return (
      <div style={wrapStyle}>
        <button
          type="button"
          disabled
          style={disabledBtnStyle}
          title="検証用のテスト校は削除できません"
        >
          削除
        </button>
        <span style={testNoteStyle}>検証用のテスト校は削除できません</span>
      </div>
    );
  }

  if (!confirming) {
    return (
      <div style={wrapStyle}>
        <button type="button" onClick={() => setConfirming(true)} style={btnStyle}>
          削除
        </button>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <div style={panelStyle}>
        <label htmlFor={inputId} style={labelStyle}>
          削除するには学校名「{schoolName}」を入力してください。元に戻せません。
        </label>
        <input
          id={inputId}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={pending}
          autoComplete="off"
          style={inputStyle}
        />
        <div style={actionsStyle}>
          <button type="button" onClick={reset} disabled={pending} style={cancelStyle}>
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!matches || pending}
            style={confirmStyle}
          >
            {pending ? "削除中…" : "削除する"}
          </button>
        </div>
      </div>
      {error ? <output style={errorStyle}>{error}</output> : null}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: "0.4rem",
};
const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  padding: "0.75rem",
  border: "1px solid #fca5a5",
  borderRadius: "8px",
  background: "#fef2f2",
  maxWidth: "22rem",
};
const labelStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#7f1d1d" };
const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  fontSize: "0.85rem",
};
const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const disabledBtnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#f3f4f6",
  color: "#9ca3af",
  border: "1px solid #e5e7eb",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "not-allowed",
};
const testNoteStyle: React.CSSProperties = { fontSize: "0.75rem", color: "#9ca3af" };
const cancelStyle: React.CSSProperties = {
  padding: "0.35rem 0.8rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.82rem",
  cursor: "pointer",
};
const confirmStyle: React.CSSProperties = {
  padding: "0.35rem 0.8rem",
  background: "#b91c1c",
  color: "#fff",
  border: "1px solid #b91c1c",
  borderRadius: "6px",
  fontSize: "0.82rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = {
  color: "#b91c1c",
  fontSize: "0.8rem",
  maxWidth: "22rem",
  textAlign: "right",
};
