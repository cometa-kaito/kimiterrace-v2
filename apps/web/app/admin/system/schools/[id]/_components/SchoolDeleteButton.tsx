"use client";

import { deleteSchoolAction } from "@/lib/system-admin/schools-actions";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * #48-L4 (#123): 学校削除ボタン。**Client Component** — 確認ダイアログ後 `deleteSchoolAction` を呼び、
 * 成功時は一覧へ戻る。認可・子データ保護 (FK RESTRICT)・監査は Server Action 側と RLS が担保するので、
 * ここは確認と結果表示に徹する。子データが残る学校は conflict メッセージを表示する (削除されない)。
 */
export function SchoolDeleteButton({
  schoolId,
  schoolName,
}: { schoolId: string; schoolName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    if (!window.confirm(`「${schoolName}」を削除します。元に戻せません。よろしいですか？`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteSchoolAction({ id: schoolId });
      if (res.ok) {
        router.push("/admin/system/schools");
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.4rem" }}
    >
      <button type="button" onClick={onClick} disabled={pending} style={btnStyle}>
        {pending ? "削除中…" : "削除"}
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = {
  color: "#b91c1c",
  fontSize: "0.8rem",
  maxWidth: "20rem",
  textAlign: "right",
};
