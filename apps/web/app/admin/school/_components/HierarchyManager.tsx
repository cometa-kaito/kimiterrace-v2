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
 * 学校管理者ハブの階層 CRUD UI (#48-K / #48-K2)。**Client Component**・**ツリー（枝分かれ）表示**。
 *
 * ユーザー要望(2026-06-06)で「学科 → 学年 → クラス」を**入れ子のツリー**にし、各ノード直下に
 * 「＋追加」を置く（学科の中で学年を、学年の中でクラスを足す）。学年/クラスがどの親に属するかが
 * 視覚的に明確になり、フラット一覧での迷いを解消する。各ノードに編集・削除も備える。
 *
 * 学年名は学校内で一意制約があるため、学科配下での学年追加・一括追加は **`{学科名}{入力}`**（例:
 * 電子工学科1年）で衝突を避ける（サイネージ表示にも学科が出て自然）。認可・検証・cross-tenant・監査・
 * RLS は Server Action 側 + RLS が担保し、本コンポーネントは入力収集と `router.refresh()` に徹する。
 */

type Result = ActionResult<{ id: string }>;
type Reporter = (res: Result, okMsg: string) => void;
type Dept = SchoolHierarchy["departments"][number];
type Grade = SchoolHierarchy["grades"][number];
type Cls = Grade["classes"][number];

/**
 * 学年名から学年数（1-12）を推定する（例:「電子工学科3年」→ 3 / 「1年」→ 1）。クラスの `grade` 列は
 * 並び替え用で、ツリーの親（学年）と情報が重複するため UI では入力させず親の学年名から導出する。
 * 推定不可（数字なし等）は 1 にフォールバック。
 */
function deriveGradeNumber(gradeName: string): number {
  const m = gradeName.match(/(\d+)\s*年/) ?? gradeName.match(/\d+/);
  const n = m ? Number(m[0].replace(/\D/g, "")) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}

export function HierarchyManager({ hierarchy }: { hierarchy: SchoolHierarchy }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { departments, grades } = hierarchy;
  const hasDepartments = departments.length > 0;

  const report: Reporter = (res, okMsg) => {
    if (res.ok) {
      setMsg({ ok: true, text: okMsg });
      router.refresh();
    } else {
      setMsg({ ok: false, text: res.error.message });
    }
  };

  const gradesOf = (deptId: string | null) => grades.filter((g) => g.departmentId === deptId);
  const orphanGrades = grades.filter((g) => !g.departmentId);

  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: "820px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <p style={hintStyle}>
        「学科 → 学年 →
        クラス」を枝分かれで作成します。各行の「＋」で配下を追加、「編集／削除」で変更できます。
      </p>

      {hasDepartments ? (
        <>
          <BulkAddYears departments={departments} report={report} />
          <ul style={treeRootStyle}>
            {departments.map((d) => (
              <DepartmentNode key={d.id} dept={d} grades={gradesOf(d.id)} report={report} />
            ))}
          </ul>
          {orphanGrades.length > 0 ? (
            <div style={orphanBoxStyle}>
              <p style={orphanLabelStyle}>学科に紐づかない学年（要整理）:</p>
              <ul style={treeRootStyle}>
                {orphanGrades.map((g) => (
                  <GradeNode key={g.id} grade={g} report={report} />
                ))}
              </ul>
            </div>
          ) : null}
          <AddDepartmentForm report={report} />
        </>
      ) : (
        <>
          <ul style={treeRootStyle}>
            {grades.map((g) => (
              <GradeNode key={g.id} grade={g} report={report} />
            ))}
          </ul>
          <AddGradeForm report={report} />
          <p style={hintStyle}>※ 学科制にすると「学科 → 学年 → クラス」の3階層で管理できます。</p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  再利用: ノード見出し（名前 + 表示順 の編集 / 確認付き削除）
 * ------------------------------------------------------------------ */

function NodeHeader({
  name,
  defaultOrder,
  entity,
  badge,
  onSave,
  onDelete,
  report,
  deleteWarn,
}: {
  name: string;
  defaultOrder: number;
  entity: string;
  badge: string;
  onSave: (v: {
    name: FormDataEntryValue | null;
    displayOrder: FormDataEntryValue | null;
  }) => Promise<Result>;
  onDelete: () => Promise<Result>;
  report: Reporter;
  deleteWarn?: string;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await onSave({ name: fd.get("name"), displayOrder: fd.get("displayOrder") });
      report(res, `${entity}を更新しました。`);
      if (res.ok) setEditing(false);
    });
  }

  if (editing) {
    return (
      <form onSubmit={save} style={formStyle}>
        <input
          name="name"
          defaultValue={name}
          required
          style={inputStyle}
          aria-label={`${entity}名`}
        />
        <input
          name="displayOrder"
          type="number"
          defaultValue={defaultOrder}
          style={orderInputStyle}
          aria-label="表示順"
        />
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "保存中…" : "保存"}
        </button>
        <button type="button" onClick={() => setEditing(false)} style={ghostBtnStyle}>
          やめる
        </button>
      </form>
    );
  }

  return (
    <div style={headerRowStyle}>
      <span style={nameStyle}>
        <span style={badgeStyle}>{badge}</span>
        {name}
      </span>
      {confirming ? (
        <span style={actionsStyle}>
          <span style={confirmTextStyle}>
            削除しますか？{deleteWarn ? `（${deleteWarn}）` : ""}
          </span>
          <button
            type="button"
            disabled={pending}
            style={dangerBtnStyle}
            onClick={() =>
              start(async () => {
                const res = await onDelete();
                report(res, `${entity}を削除しました。`);
              })
            }
          >
            {pending ? "削除中…" : "削除する"}
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
  );
}

/* ------------------------------------------------------------------ *
 *  学科ノード（配下: 学年）
 * ------------------------------------------------------------------ */

function DepartmentNode({
  dept,
  grades,
  report,
}: {
  dept: Dept;
  grades: Grade[];
  report: Reporter;
}) {
  return (
    <li style={deptNodeStyle}>
      <NodeHeader
        name={dept.name}
        defaultOrder={dept.displayOrder}
        entity="学科"
        badge="学科"
        deleteWarn="配下に学年があると削除不可"
        onSave={(v) =>
          updateDepartmentAction({ id: dept.id, name: v.name, displayOrder: v.displayOrder })
        }
        onDelete={() => deleteDepartmentAction(dept.id)}
        report={report}
      />
      <ul style={childListStyle}>
        {grades.map((g) => (
          <GradeNode key={g.id} grade={g} report={report} />
        ))}
        <li>
          <AddGradeForm department={dept} report={report} />
        </li>
      </ul>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 *  学年ノード（配下: クラス）
 * ------------------------------------------------------------------ */

function GradeNode({ grade, report }: { grade: Grade; report: Reporter }) {
  return (
    <li style={gradeNodeStyle}>
      <NodeHeader
        name={grade.name}
        defaultOrder={grade.displayOrder}
        entity="学年"
        badge="学年"
        deleteWarn="配下にクラスがあると削除不可"
        onSave={(v) =>
          updateGradeAction({
            id: grade.id,
            name: v.name,
            displayOrder: v.displayOrder,
            // name/順のみ変更。hasClasses / departmentId は現状値を保持（全置換 API のため明示）。
            hasClasses: grade.hasClasses,
            departmentId: grade.departmentId ?? undefined,
          })
        }
        onDelete={() => deleteGradeAction(grade.id)}
        report={report}
      />
      <ul style={childListStyle}>
        {grade.classes.length === 0 ? (
          <li style={emptyGradeStyle}>
            <span style={emptyGradeTextStyle}>
              掲示・サイネージにはクラス（表示単位）が必要です。組に分けない学年は「1まとまり」にできます。
            </span>
            <MakeGradeUnitButton grade={grade} report={report} />
          </li>
        ) : (
          grade.classes.map((c) => <ClassNode key={c.id} cls={c} report={report} />)
        )}
        <li>
          <AddClassForm grade={grade} report={report} />
        </li>
      </ul>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 *  クラスノード（末端・編集/削除）
 * ------------------------------------------------------------------ */

function ClassNode({ cls, report }: { cls: Cls; report: Reporter }) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await updateClassAction({
        id: cls.id,
        name: fd.get("name"),
        academicYear: fd.get("academicYear"),
        // 学年数はツリーの親に追従するため編集させず現状値を保持する。
        grade: cls.grade,
      });
      report(res, "クラスを更新しました。");
      if (res.ok) setEditing(false);
    });
  }

  if (editing) {
    return (
      <li>
        <form onSubmit={save} style={formStyle}>
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
          <button type="submit" disabled={pending} style={btnStyle}>
            {pending ? "保存中…" : "保存"}
          </button>
          <button type="button" onClick={() => setEditing(false)} style={ghostBtnStyle}>
            やめる
          </button>
        </form>
      </li>
    );
  }

  return (
    <li style={headerRowStyle}>
      <span style={classNameStyle}>
        <span style={classBadgeStyle}>クラス</span>
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
            {pending ? "削除中…" : "削除する"}
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

/* ------------------------------------------------------------------ *
 *  追加フォーム群
 * ------------------------------------------------------------------ */

function AddDepartmentForm({ report }: { report: Reporter }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
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
    <form onSubmit={add} style={addFormStyle}>
      <span style={plusStyle}>＋</span>
      <input name="name" placeholder="学科名（例: 電子工学科）" required style={inputStyle} />
      <input name="displayOrder" type="number" placeholder="表示順" style={orderInputStyle} />
      <button type="submit" disabled={pending} style={btnStyle}>
        {pending ? "追加中…" : "学科を追加"}
      </button>
    </form>
  );
}

/**
 * 学年追加。`department` があれば学科配下の追加で、学年名は **`{学科名}{入力}`** にして学校内一意制約の
 * 衝突を避ける（入力は「1年」等の短い学年でよい）。`department` 無し（学科なし校）は入力をそのまま使う。
 */
function AddGradeForm({ department, report }: { department?: Dept; report: Reporter }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const base = String(new FormData(form).get("name") ?? "").trim();
    if (!base) {
      report({ ok: false, error: { code: "invalid", message: "学年名を入力してください。" } }, "");
      return;
    }
    start(async () => {
      const res = await createGradeAction(
        department
          ? { name: `${department.name}${base}`, departmentId: department.id }
          : { name: base },
      );
      report(res, "学年を追加しました。");
      if (res.ok) form.reset();
    });
  }
  return (
    <form onSubmit={add} style={addFormStyle}>
      <span style={plusStyle}>＋</span>
      <input
        name="name"
        placeholder={department ? "学年（例: 1年・学科名が自動で付きます）" : "学年名（例: 1年）"}
        required
        style={inputStyle}
      />
      <button type="submit" disabled={pending} style={secondaryBtnStyle}>
        {pending ? "追加中…" : department ? "この学科に学年を追加" : "学年を追加"}
      </button>
    </form>
  );
}

/**
 * 「この学年を1まとまりにする」: 組に分けない学年の表示単位を 1 つ用意する。エディタ/サイネージ/QR は
 * クラス基準のため、学年名と同名のクラスを 1 つ作り「学年＝1画面」として扱えるようにする（ユーザーは
 * クラスを個別に名付け・管理しなくてよい。完全な学年スコープ対応の最小実装）。年度=今年・学年数=学年名から。
 */
function MakeGradeUnitButton({ grade, report }: { grade: Grade; report: Reporter }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      style={secondaryBtnStyle}
      onClick={() =>
        start(async () => {
          const res = await createClassAction({
            gradeId: grade.id,
            name: grade.name,
            academicYear: new Date().getFullYear(),
            grade: deriveGradeNumber(grade.name),
          });
          report(res, "この学年を1まとまりにしました。");
        })
      }
    >
      {pending ? "設定中…" : "この学年を1まとまりにする"}
    </button>
  );
}

function AddClassForm({ grade, report }: { grade: Grade; report: Reporter }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createClassAction({
        gradeId: grade.id,
        name: fd.get("name"),
        // 年度は今年を自動設定、学年数は親の学年名から自動算出（UI では入力させない）。
        academicYear: new Date().getFullYear(),
        grade: deriveGradeNumber(grade.name),
      });
      report(res, "クラスを追加しました。");
      if (res.ok) form.reset();
    });
  }
  return (
    <form onSubmit={add} style={addFormStyle}>
      <span style={plusStyle}>＋</span>
      <input
        name="name"
        placeholder="クラス名（例: 1組／組が無ければ『全体』）"
        required
        style={inputStyle}
      />
      <button type="submit" disabled={pending} style={secondaryBtnStyle}>
        {pending ? "追加中…" : "この学年にクラスを追加"}
      </button>
    </form>
  );
}

/** 全学科に同じ学年をまとめて追加（各学科に `{学科名}{入力}` を生成）。 */
function BulkAddYears({ departments, report }: { departments: Dept[]; report: Reporter }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const base = String(new FormData(form).get("base") ?? "").trim();
    if (!base) {
      report({ ok: false, error: { code: "invalid", message: "学年名を入力してください。" } }, "");
      return;
    }
    start(async () => {
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
    <form onSubmit={add} style={bulkBoxStyle}>
      <span style={bulkLabelStyle}>一括: 全 {departments.length} 学科に</span>
      <input name="base" placeholder="学年名（例: 1年）" style={inputStyle} />
      <span style={bulkLabelStyle}>を追加</span>
      <button type="submit" disabled={pending} style={secondaryBtnStyle}>
        {pending ? "追加中…" : "全学科に一括追加"}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 *  styles
 * ------------------------------------------------------------------ */

const hintStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem", margin: 0 };
const treeRootStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.6rem",
};
const childListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "0.4rem 0 0",
  padding: "0 0 0 1rem",
  borderLeft: "2px solid #e5e7eb",
  display: "grid",
  gap: "0.4rem",
};
const deptNodeStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.75rem",
};
const gradeNodeStyle: React.CSSProperties = {
  background: "#f9fafb",
  borderRadius: "6px",
  padding: "0.5rem 0.6rem",
};
const orphanBoxStyle: React.CSSProperties = {
  border: "1px dashed #f59e0b",
  borderRadius: "8px",
  padding: "0.75rem",
  background: "#fffbeb",
};
const orphanLabelStyle: React.CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "0.85rem",
  color: "#b45309",
};
const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const nameStyle: React.CSSProperties = {
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const classNameStyle: React.CSSProperties = {
  fontSize: "0.92rem",
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const badgeStyle: React.CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 700,
  color: "#1d4ed8",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: "999px",
  padding: "0.05rem 0.45rem",
};
const classBadgeStyle: React.CSSProperties = {
  ...badgeStyle,
  color: "#166534",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
};
const classMetaStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.8rem",
  fontWeight: 400,
};
const actionsStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: "0.4rem",
  alignItems: "center",
};
const confirmTextStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#b91c1c" };
const bulkBoxStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.6rem 0.75rem",
  background: "#f7f8fa",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
};
const bulkLabelStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#374151" };
const emptyGradeStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
};
const emptyGradeTextStyle: React.CSSProperties = { fontSize: "0.82rem", color: "#6b7280" };
const addFormStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem",
  alignItems: "center",
};
const plusStyle: React.CSSProperties = { color: "#6b7280", fontWeight: 700 };
const formStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem",
  alignItems: "center",
};
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
