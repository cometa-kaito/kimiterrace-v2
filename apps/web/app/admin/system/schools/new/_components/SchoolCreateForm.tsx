"use client";

import { createSchoolAction } from "@/lib/system-admin/schools-actions";
import { HIERARCHY_MODES } from "@/lib/system-admin/schools-core";
import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * #48-L3 (#123): 学校新規作成フォーム。**Client Component** — `createSchoolAction` を呼び、
 * 成功時は作成された学校の詳細へ遷移する。認可・検証・監査・RLS WITH CHECK は Server Action 側
 * (schools-actions.ts) が担保するので、ここは入力収集と結果表示に徹する (SchoolEditForm と同方針)。
 *
 * db 値は `@kimiterrace/db/schema` サブパスから `import type` のみで引く (#181: barrel は postgres を
 * client bundle に混入させ next build を落とす)。`HIERARCHY_MODES` は web 側 pure module の定数。
 */
const MODE_LABEL: Record<SchoolHierarchyMode, string> = {
  class: "クラス制 (学年 > クラス)",
  department: "学科制 (学年 > 学科 > クラス)",
};

export function SchoolCreateForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await createSchoolAction({
        name: fd.get("name"),
        prefecture: fd.get("prefecture"),
        code: fd.get("code"),
        hierarchyMode: fd.get("hierarchyMode"),
      });
      if (res.ok) {
        // 作成された学校の詳細へ遷移 (登録結果と階層 0 件の確認)。
        router.push(`/admin/system/schools/${res.data.id}`);
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "1rem" }}>
      {msg && !msg.ok ? (
        <output style={{ display: "block", color: "#b91c1c" }}>{msg.text}</output>
      ) : null}

      <label style={labelStyle}>
        学校名
        <input name="name" required maxLength={200} style={inputStyle} />
      </label>

      <label style={labelStyle}>
        都道府県
        <input name="prefecture" required maxLength={32} style={inputStyle} />
      </label>

      <label style={labelStyle}>
        学校コード (任意)
        <input name="code" maxLength={32} style={inputStyle} />
      </label>

      <label style={labelStyle}>
        階層モード
        <select name="hierarchyMode" defaultValue="class" style={inputStyle}>
          {HIERARCHY_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "登録中…" : "登録する"}
        </button>
        <a href="/admin/system/schools" style={cancelStyle}>
          キャンセル
        </a>
      </div>
    </form>
  );
}

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  fontSize: "0.85rem",
  color: "#374151",
};
const inputStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.95rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.9rem",
  cursor: "pointer",
};
const cancelStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
