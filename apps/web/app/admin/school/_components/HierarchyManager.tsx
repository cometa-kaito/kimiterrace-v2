"use client";

import {
  createClassAction,
  createDepartmentAction,
  createGradeAction,
  deleteClassAction,
  deleteDepartmentAction,
  deleteGradeAction,
  updateClassAction,
  updateDepartmentAction,
  updateGradeAction,
} from "@/lib/school-admin/hub-actions";
import type { ActionResult } from "@/lib/school-admin/hub-core";
import type { SchoolHierarchy } from "@/lib/school-admin/hub-queries";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * 学校管理者ハブの階層 CRUD UI (#48-K / #48-K2)。**Client Component**。
 *
 * 学科 / 学年 / クラスの **追加・編集・削除** を提供する（編集/削除アクションは hub-actions.ts に既存、
 * 本コンポーネントが UI に配線する）。認可・検証・cross-tenant ガード・監査・RLS は Server Action 側 +
 * RLS が担保するので、ここは入力収集と結果表示・`router.refresh()` での再取得に徹する。
 *
 * **学年の追加（学科制 UX、ユーザー要望 2026-06-06）**: 学科が 1 つ以上ある学校では「学年は各学科に
 * 紐づく」。学年名は学校内で一意制約があるため、(1) 単体追加では学科を必須選択にし、(2)「全学科に一括
 * 追加」で各学科に `{学科名}{学年名}`（例: 電子工学科1年）をまとめて作れるようにし、繰り返し入力を解消する。
 */

type Result = ActionResult<{ id: string }>;
type Reporter = (res: Result, okMsg: string) => void;
type Dept = SchoolHierarchy["departments"][number];
type Grade = SchoolHierarchy["grades"][number];
type Cls = Grade["classes"][number];

export function HierarchyManager({ hierarchy }: { hierarchy: SchoolHierarchy }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const departments = hierarchy.departments;
  const hasDepartments = departments.length > 0;

  const report: Reporter = (res, okMsg) => {
    if (res.ok) {
      setMsg({ ok: true, text: okMsg });
      router.refresh();
    } else {
      setMsg({ ok: false, text: res.error.message });
    }
  };

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "760px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      {/* 学科 */}
      <section style={cardStyle}>
        <h2 style={h2Style}>学科 ({departments.length})</h2>
        {departments.length === 0 ? (
          <p style={emptyStyle}>学科がありません。下のフォームで追加してください。</p>
        ) : (
          <ul style={plainListStyle}>
            {departments.map((d) => (
              <DepartmentRow key={d.id} dept={d} report={report} />
            ))}
          </ul>
        )}
        <AddDepartmentForm report={report} />
      </section>

      {/* 学年 + クラス */}
      <section style={cardStyle}>
        <h2 style={h2Style}>学年・クラス ({hierarchy.grades.length} 学年)</h2>
        {hierarchy.grades.length === 0 ? (
          <p style={emptyStyle}>学年がありません。下のフォームで追加してください。</p>
        ) : (
          <ul style={plainListStyle}>
            {hierarchy.grades.map((g) => (
              <GradeBlock key={g.id} grade={g} report={report} />
            ))}
          </ul>
        )}
        <AddGradeForm departments={departments} hasDepartments={hasDepartments} report={report} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  学科
 * ------------------------------------------------------------------ */

function DepartmentRow({ dept, report }: { dept: Dept; report: Reporter }) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await updateDepartmentAction({
        id: dept.id,
        name: fd.get("name"),
        displayOrder: fd.get("displayOrder"),
      });
      report(res, "学科を更新しました。");
      if (res.ok) setEditing(false);
    });
  }

  if (editing) {
    return (
      <li style={rowStyle}>
        <form onSubmit={onSave} style={formStyle}>
          <input name="name" defaultValue={dept.name} required style={inputStyle} />
          <input
            name="displayOrder"
            type="number"
            defaultValue={dept.displayOrder}
            style={orderInputStyle}
            aria-label="表示順"
          />
          <button type="submit" disabled={pending} style={btnStyle}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)} style={ghostBtnStyle}>
            やめる
          </button>
        </form>
      </li>
    );
  }

  return (
    <li style={rowStyle}>
      <span style={nameStyle}>{dept.name}</span>
      {confirming ? (
        <span style={actionsStyle}>
          <span style={confirmTextStyle}>削除しますか？</span>
          <button
            type="button"
            disabled={pending}
            style={dangerBtnStyle}
            onClick={() =>
              start(async () => {
                const res = await deleteDepartmentAction(dept.id);
                report(res, "学科を削除しました。");
              })
            }
          >
            削除する
          </button>
          <button type="button" onClick={() => setConfirming(false)} style={ghostBtnStyle}>
            やめる
          </button>
        </span>
      ) : (
        <span style={actionsStyle}>
          <button type="button" onClick={() => setEditing(true)} style={ghostBtnStyle}>
            編集
          </button>
          <button type="button" onClick={() => setConfirming(true)} style={dangerGhostBtnStyle}>
            削除
          </button>
        </span>
      )}
    </li>
  );
}

function AddDepartmentForm({ report }: { report: Reporter }) {
  const [pending, start] = useTransition();
  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createDepartmentAction({
        name: fd.get("name"),
        displayOrder: fd.get("displayOrder"),
      });
      report(res, "学科を追加しました。");
      if (res.ok) form.reset();
    });
  }
  return (
    <form onSubmit={onAdd} style={{ ...formStyle, marginTop: "0.75rem" }}>
      <input name="name" placeholder="学科名（例: 電子工学科）" required style={inputStyle} />
      <input name="displayOrder" type="number" placeholder="表示順" style={orderInputStyle} />
      <button type="submit" disabled={pending} style={btnStyle}>
        学科を追加
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 *  学年（配下にクラス）
 * ------------------------------------------------------------------ */

function GradeBlock({ grade, report }: { grade: Grade; report: Reporter }) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      // name / displayOrder のみ変更。hasClasses / departmentId は現状値を保持（全置換 API のため明示）。
      const res = await updateGradeAction({
        id: grade.id,
        name: fd.get("name"),
        displayOrder: fd.get("displayOrder"),
        hasClasses: grade.hasClasses,
        departmentId: grade.departmentId ?? undefined,
      });
      report(res, "学年を更新しました。");
      if (res.ok) setEditing(false);
    });
  }

  return (
    <li style={gradeBlockStyle}>
      {editing ? (
        <form onSubmit={onSave} style={formStyle}>
          <input name="name" defaultValue={grade.name} required style={inputStyle} />
          <input
            name="displayOrder"
            type="number"
            defaultValue={grade.displayOrder}
            style={orderInputStyle}
            aria-label="表示順"
          />
          <button type="submit" disabled={pending} style={btnStyle}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)} style={ghostBtnStyle}>
            やめる
          </button>
        </form>
      ) : (
        <div style={rowStyle}>
          <span style={nameStyle}>{grade.name}</span>
          {confirming ? (
            <span style={actionsStyle}>
              <span style={confirmTextStyle}>削除しますか？（配下にクラスがあると削除不可）</span>
              <button
                type="button"
                disabled={pending}
                style={dangerBtnStyle}
                onClick={() =>
                  start(async () => {
                    const res = await deleteGradeAction(grade.id);
                    report(res, "学年を削除しました。");
                  })
                }
              >
                削除する
              </button>
              <button type="button" onClick={() => setConfirming(false)} style={ghostBtnStyle}>
                やめる
              </button>
            </span>
          ) : (
            <span style={actionsStyle}>
              <button type="button" onClick={() => setEditing(true)} style={ghostBtnStyle}>
                編集
              </button>
              <button type="button" onClick={() => setConfirming(true)} style={dangerGhostBtnStyle}>
                削除
              </button>
            </span>
          )}
        </div>
      )}

      {/* 配下クラス */}
      <ul style={classListStyle}>
        {grade.classes.map((c) => (
          <ClassRow key={c.id} cls={c} report={report} />
        ))}
      </ul>
      <AddClassForm grade={grade} report={report} />
    </li>
  );
}

function AddGradeForm({
  departments,
  hasDepartments,
  report,
}: {
  departments: Dept[];
  hasDepartments: boolean;
  report: Reporter;
}) {
  const [pending, start] = useTransition();
  const [bulkPending, startBulk] = useTransition();

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createGradeAction({
        name: fd.get("name"),
        displayOrder: fd.get("displayOrder"),
        departmentId: fd.get("departmentId") || undefined,
      });
      report(res, "学年を追加しました。");
      if (res.ok) form.reset();
    });
  }

  // 全学科に一括追加: 各学科に `{学科名}{学年名}`（例: 電子工学科1年）を作る。学年名は学校内一意のため
  // 学科名を前置して衝突を避ける（サイネージ表示にも学科が出て自然）。
  function onBulk(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const base = String(new FormData(form).get("base") ?? "").trim();
    if (!base) {
      report({ ok: false, error: { code: "invalid", message: "学年名を入力してください。" } }, "");
      return;
    }
    startBulk(async () => {
      let ok = 0;
      let firstFail = "";
      for (const d of departments) {
        const res = await createGradeAction({ name: `${d.name}${base}`, departmentId: d.id });
        if (res.ok) {
          ok += 1;
        } else if (!firstFail) {
          firstFail = `${d.name}: ${res.error.message}`;
        }
      }
      if (firstFail) {
        report(
          {
            ok: false,
            error: { code: "conflict", message: `一部失敗（${ok} 件成功）。${firstFail}` },
          },
          "",
        );
      } else {
        report(
          { ok: true, data: { id: "" } },
          `全 ${departments.length} 学科に「${base}」を追加しました。`,
        );
      }
      form.reset();
    });
  }

  return (
    <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.6rem" }}>
      <form onSubmit={onAdd} style={formStyle}>
        <input
          name="name"
          placeholder={hasDepartments ? "学年名（例: 電子工学科1年）" : "学年名（例: 1年）"}
          required
          style={inputStyle}
        />
        <input name="displayOrder" type="number" placeholder="表示順" style={orderInputStyle} />
        {hasDepartments ? (
          <select name="departmentId" required style={inputStyle} defaultValue="">
            <option value="" disabled>
              学科を選択
            </option>
            {departments.map((d) => (
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

      {hasDepartments ? (
        <form onSubmit={onBulk} style={{ ...formStyle, alignItems: "center" }}>
          <span style={bulkLabelStyle}>一括: 全学科に</span>
          <input name="base" placeholder="学年名（例: 1年）" style={inputStyle} />
          <span style={bulkLabelStyle}>を追加</span>
          <button type="submit" disabled={bulkPending} style={secondaryBtnStyle}>
            全学科に一括追加
          </button>
        </form>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  クラス
 * ------------------------------------------------------------------ */

function ClassRow({ cls, report }: { cls: Cls; report: Reporter }) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await updateClassAction({
        id: cls.id,
        name: fd.get("name"),
        academicYear: fd.get("academicYear"),
        grade: fd.get("grade"),
      });
      report(res, "クラスを更新しました。");
      if (res.ok) setEditing(false);
    });
  }

  if (editing) {
    return (
      <li style={rowStyle}>
        <form onSubmit={onSave} style={formStyle}>
          <input
            name="name"
            defaultValue={cls.name}
            required
            style={inputStyle}
            aria-label="クラス名"
          />
          <input
            name="academicYear"
            type="number"
            defaultValue={cls.academicYear}
            required
            style={orderInputStyle}
            aria-label="年度"
          />
          <input
            name="grade"
            type="number"
            defaultValue={cls.grade}
            required
            style={orderInputStyle}
            aria-label="学年数"
          />
          <button type="submit" disabled={pending} style={btnStyle}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)} style={ghostBtnStyle}>
            やめる
          </button>
        </form>
      </li>
    );
  }

  return (
    <li style={rowStyle}>
      <span style={classNameStyle}>
        {cls.name}
        <span style={classMetaStyle}>
          （{cls.academicYear}年度・{cls.grade}年）
        </span>
      </span>
      {confirming ? (
        <span style={actionsStyle}>
          <span style={confirmTextStyle}>削除しますか？</span>
          <button
            type="button"
            disabled={pending}
            style={dangerBtnStyle}
            onClick={() =>
              start(async () => {
                const res = await deleteClassAction(cls.id);
                report(res, "クラスを削除しました。");
              })
            }
          >
            削除する
          </button>
          <button type="button" onClick={() => setConfirming(false)} style={ghostBtnStyle}>
            やめる
          </button>
        </span>
      ) : (
        <span style={actionsStyle}>
          <button type="button" onClick={() => setEditing(true)} style={ghostBtnStyle}>
            編集
          </button>
          <button type="button" onClick={() => setConfirming(true)} style={dangerGhostBtnStyle}>
            削除
          </button>
        </span>
      )}
    </li>
  );
}

function AddClassForm({ grade, report }: { grade: Grade; report: Reporter }) {
  const [pending, start] = useTransition();
  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createClassAction({
        gradeId: grade.id,
        name: fd.get("name"),
        academicYear: fd.get("academicYear"),
        grade: fd.get("grade"),
      });
      report(res, "クラスを追加しました。");
      if (res.ok) form.reset();
    });
  }
  return (
    <form onSubmit={onAdd} style={{ ...formStyle, marginTop: "0.4rem", paddingLeft: "1.25rem" }}>
      <input name="name" placeholder="クラス名（例: 1組）" required style={inputStyle} />
      <input
        name="academicYear"
        type="number"
        placeholder="年度（例: 2026）"
        required
        style={orderInputStyle}
      />
      <input name="grade" type="number" placeholder="学年数" required style={orderInputStyle} />
      <button type="submit" disabled={pending} style={secondaryBtnStyle}>
        クラスを追加
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 *  styles
 * ------------------------------------------------------------------ */

const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1rem",
};
const h2Style: React.CSSProperties = { fontSize: "1.1rem", margin: "0 0 0.5rem" };
const emptyStyle: React.CSSProperties = {
  color: "#6b7280",
  margin: "0 0 0.75rem",
  fontSize: "0.9rem",
};
const plainListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "0 0 0.75rem",
  padding: 0,
  display: "grid",
  gap: "0.4rem",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const gradeBlockStyle: React.CSSProperties = {
  borderTop: "1px solid #f3f4f6",
  paddingTop: "0.5rem",
};
const classListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "0.3rem 0 0",
  padding: "0 0 0 1.25rem",
  display: "grid",
  gap: "0.3rem",
};
const nameStyle: React.CSSProperties = { fontWeight: 600 };
const classNameStyle: React.CSSProperties = { fontSize: "0.92rem" };
const classMetaStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.82rem" };
const actionsStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: "0.4rem",
  alignItems: "center",
};
const confirmTextStyle: React.CSSProperties = { fontSize: "0.82rem", color: "#b91c1c" };
const bulkLabelStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#374151" };
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
const secondaryBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: "#fff",
  color: "#1f2937",
  border: "1px solid #d1d5db",
};
const ghostBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.7rem",
  background: "transparent",
  color: "#1d4ed8",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.82rem",
};
const dangerGhostBtnStyle: React.CSSProperties = { ...ghostBtnStyle, color: "#b91c1c" };
const dangerBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.7rem",
  background: "#b91c1c",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.82rem",
};
