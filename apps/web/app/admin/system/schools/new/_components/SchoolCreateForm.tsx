"use client";

import { createSchoolAction } from "@/lib/system-admin/schools-actions";
import {
  HIERARCHY_MODES,
  type SchoolFieldErrors,
  collectSchoolFieldErrors,
  hasSchoolFieldErrors,
} from "@/lib/system-admin/schools-core";
import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";
import { FormField } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * #48-L3 (#123): 学校新規作成フォーム。**Client Component** — `createSchoolAction` を呼び、
 * 成功時は作成された学校の詳細へ遷移する。認可・検証・監査・RLS WITH CHECK は Server Action 側
 * (schools-actions.ts) が担保するので、ここは入力収集と結果表示に徹する (SchoolEditForm と同方針)。
 *
 * **項目別インライン検証 (FormField)**: 送信前に `collectSchoolFieldErrors` で項目別に検証し、エラーは
 * 各項目の下に表示する (従来は送信して初めて 1 つの汎用エラーが出た)。検証規則は Server Action と同じ
 * 単一ソース。ネイティブ検証バブルと二重化しないよう `noValidate` + FormField の必須印に統一する。
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
  const [fieldErrors, setFieldErrors] = useState<SchoolFieldErrors>({});

  // 入力中はその項目のエラーを消す (修正に追従)。
  function clearError(field: keyof SchoolFieldErrors) {
    setFieldErrors((prev) => {
      if (prev[field] === undefined) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const raw = { name: fd.get("name"), prefecture: fd.get("prefecture"), code: fd.get("code") };
    // クライアント側の項目別検証。エラーがあれば送信せず項目の下に表示する (Server Action と同じ規則)。
    const errors = collectSchoolFieldErrors(raw);
    if (hasSchoolFieldErrors(errors)) {
      setFieldErrors(errors);
      setMsg(null);
      return;
    }
    setFieldErrors({});
    startTransition(async () => {
      const res = await createSchoolAction({ ...raw, hierarchyMode: fd.get("hierarchyMode") });
      if (res.ok) {
        // 作成された学校の詳細へ遷移 (登録結果と階層 0 件の確認)。
        router.push(`/admin/system/schools/${res.data.id}`);
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate style={{ display: "grid", gap: "0.5rem" }}>
      {msg && !msg.ok ? (
        <output role="alert" style={{ display: "block", color: "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <FormField label="学校名" required error={fieldErrors.name}>
        <input name="name" maxLength={200} style={inputStyle} onChange={() => clearError("name")} />
      </FormField>

      <FormField label="都道府県" required error={fieldErrors.prefecture}>
        <input
          name="prefecture"
          maxLength={32}
          style={inputStyle}
          onChange={() => clearError("prefecture")}
        />
      </FormField>

      <FormField label="学校コード" hint="任意（学校管理用の識別コード）" error={fieldErrors.code}>
        <input name="code" maxLength={32} style={inputStyle} onChange={() => clearError("code")} />
      </FormField>

      <FormField label="階層モード" hint="クラス制 = 学年>クラス / 学科制 = 学年>学科>クラス">
        <select name="hierarchyMode" defaultValue="class" style={inputStyle}>
          {HIERARCHY_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </FormField>

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

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
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
