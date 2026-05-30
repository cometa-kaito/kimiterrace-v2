"use client";

import {
  createClassAction,
  createDepartmentAction,
  createGradeAction,
} from "@/lib/school-admin/hub-actions";
import type { ActionResult } from "@/lib/school-admin/hub-core";
import type { SchoolHierarchy } from "@/lib/school-admin/hub-queries";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * 学校管理者ハブの操作 UI (#48-K)。**Client Component** — Server Actions を呼び、成功時は
 * `router.refresh()` で Server Component を再取得して一覧を更新する。認可・検証・監査は
 * Server Action 側 (hub-actions.ts) と RLS が担保するので、ここは入力収集と結果表示に徹する。
 */
export function HierarchyManager({ hierarchy }: { hierarchy: SchoolHierarchy }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function submit(
    e: FormEvent<HTMLFormElement>,
    action: (fd: FormData) => Promise<ActionResult<{ id: string }>>,
  ) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    startTransition(async () => {
      const res = await action(fd);
      if (res.ok) {
        setMsg({ ok: true, text: "追加しました。" });
        form.reset();
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "640px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      {/* 学科 */}
      <section style={cardStyle}>
        <h2 style={h2Style}>学科 ({hierarchy.departments.length})</h2>
        <ul style={listStyle}>
          {hierarchy.departments.map((d) => (
            <li key={d.id}>{d.name}</li>
          ))}
        </ul>
        <form
          onSubmit={(e) =>
            submit(e, (fd) =>
              createDepartmentAction({
                name: fd.get("name"),
                displayOrder: fd.get("displayOrder"),
              }),
            )
          }
          style={formStyle}
        >
          <input name="name" placeholder="学科名" required style={inputStyle} />
          <input name="displayOrder" type="number" placeholder="表示順" style={orderInputStyle} />
          <button type="submit" disabled={pending} style={btnStyle}>
            学科を追加
          </button>
        </form>
      </section>

      {/* 学年 + クラス */}
      <section style={cardStyle}>
        <h2 style={h2Style}>学年 ({hierarchy.grades.length})</h2>
        <ul style={listStyle}>
          {hierarchy.grades.map((g) => (
            <li key={g.id}>
              {g.name}
              {g.classes.length > 0 ? (
                <span style={{ color: "#6b7280" }}>
                  {" "}
                  — {g.classes.map((c) => c.name).join("、")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) =>
            submit(e, (fd) =>
              createGradeAction({
                name: fd.get("name"),
                displayOrder: fd.get("displayOrder"),
                departmentId: fd.get("departmentId") || undefined,
              }),
            )
          }
          style={formStyle}
        >
          <input name="name" placeholder="学年名 (例: 1年)" required style={inputStyle} />
          <input name="displayOrder" type="number" placeholder="表示順" style={orderInputStyle} />
          {hierarchy.departments.length > 0 ? (
            <select name="departmentId" style={inputStyle} defaultValue="">
              <option value="">学科なし</option>
              {hierarchy.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : null}
          <button type="submit" disabled={pending} style={btnStyle}>
            学年を追加
          </button>
        </form>

        {/* クラス追加 (学年が 1 つ以上あるときのみ) */}
        {hierarchy.grades.length > 0 ? (
          <form
            onSubmit={(e) =>
              submit(e, (fd) =>
                createClassAction({
                  gradeId: fd.get("gradeId"),
                  name: fd.get("name"),
                  academicYear: fd.get("academicYear"),
                  grade: fd.get("grade"),
                }),
              )
            }
            style={{ ...formStyle, marginTop: "0.5rem" }}
          >
            <select name="gradeId" required style={inputStyle} defaultValue="">
              <option value="" disabled>
                学年を選択
              </option>
              {hierarchy.grades.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <input name="name" placeholder="クラス名 (例: A組)" required style={inputStyle} />
            <input
              name="academicYear"
              type="number"
              placeholder="年度"
              required
              style={orderInputStyle}
            />
            <input
              name="grade"
              type="number"
              placeholder="学年数"
              required
              style={orderInputStyle}
            />
            <button type="submit" disabled={pending} style={btnStyle}>
              クラスを追加
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1rem",
};
const h2Style: React.CSSProperties = { fontSize: "1.1rem", margin: "0 0 0.5rem" };
const listStyle: React.CSSProperties = { margin: "0 0 0.75rem", paddingLeft: "1.25rem" };
const formStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.5rem" };
const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};
const orderInputStyle: React.CSSProperties = { ...inputStyle, width: "6rem" };
const btnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#1f2937",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
