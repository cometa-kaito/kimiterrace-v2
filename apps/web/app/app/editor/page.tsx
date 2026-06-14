import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { getSchoolHierarchy } from "@/lib/school-admin/hub-queries";
import type { GradeView } from "@/lib/school-admin/hub-queries";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LAST_CLASS_COOKIE } from "./[classId]/_components/RememberLastClass";

const { color, fontSize, radius } = tokens;

/**
 * エディタ着地 (#48-H)。編集する **範囲** を **階層ツリー（学校全体 → 学科 → 学年 → クラス）** で選ぶ。
 *
 * **分かりやすさ (ユーザー報告 2026-06-07「範囲選択 UI が分かりにくい」)**: 範囲の概念（広い範囲＝配下の全
 * クラスに共通表示 / クラス個別が優先）を冒頭で説明し、「共通（全体）」の編集ボタンを**青いピル**で、クラスは
 * **白いチップ**で視覚的に明確に区別する。これにより「クラスを編集」と「共通を編集」を取り違えにくくする。
 *
 * **空状態はロール別 (校務DX原則)**: クラス 0 件のとき、school_admin には学校管理への導線を、teacher には
 * 「管理者が追加すると表示される」案内に留める（teacher は /app/school で 403 になるため死リンクを出さない）。
 *
 * **scope まとめ編集（段A-2）**: 「学校全体」「学科の共通」「学年の共通」で保存した内容は、より具体的なクラス
 * 個別入力が無いクラスのサイネージに共通表示される（精度優先 class > grade > department > school、
 * `effective-daily-data.ts`）。
 */
export default async function EditorIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const hierarchy = await withSession((tx) => getSchoolHierarchy(tx));
  const { departments, grades } = hierarchy;
  const gradesOf = (deptId: string | null) => grades.filter((g) => g.departmentId === deptId);
  const orphanGrades = grades.filter((g) => !g.departmentId);
  const totalClasses = grades.reduce((n, g) => n + g.classes.length, 0);

  // UIUX-02 ホップ削減①: 編集できるクラスが 1 つだけの teacher は選択画面を飛ばして直行する。
  // school_admin は共通（scope）編集も使うため自動遷移しない。クラス画面の「戻る」は ?stay=1 で
  // 本ページに留まれる（自動遷移とのループ防止）。
  const allClasses = grades.flatMap((g) => g.classes.map((c) => ({ ...c, gradeName: g.name })));
  const { stay } = await searchParams;
  const onlyClass = allClasses.length === 1 ? allClasses[0] : undefined;
  if (user.role === "teacher" && onlyClass && stay !== "1") {
    redirect(`/app/editor/${onlyClass.id}`);
  }

  // UIUX-02 ホップ削減②: 最後に開いたクラス（cookie）を RLS スコープ済みの自校階層と突合し、
  // 実在するときだけ「前回のクラスを再開」を最上位に出す（失効/他校の値は無視）。
  const lastClassId = (await cookies()).get(LAST_CLASS_COOKIE)?.value;
  const lastClass = lastClassId ? (allClasses.find((c) => c.id === lastClassId) ?? null) : null;

  return (
    <div style={{ maxWidth: "760px" }}>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.5rem" }}>エディタ — 編集する範囲を選ぶ</h1>

      {lastClass ? (
        <p style={{ margin: "0 0 1rem" }}>
          <Link href={`/app/editor/${lastClass.id}`} style={resumeBtnStyle}>
            <span aria-hidden="true">▶</span> 前回のクラスを再開 — {lastClass.gradeName}{" "}
            {lastClass.name}
          </Link>
        </p>
      ) : null}

      {/* 範囲の概念を最初に説明（分かりにくさの主因＝何を選べばよいか不明）。 */}
      <div style={explainStyle}>
        <p style={{ margin: "0 0 0.4rem" }}>範囲を選んで、予定・連絡・提出物を編集します。</p>
        <ul style={explainListStyle}>
          <li>
            <span style={classDot} /> <strong>クラス</strong>（白）を選ぶ … そのクラス
            <strong>だけ</strong>に表示
          </li>
          <li>
            <span style={scopeDot} /> <strong>共通</strong>（青：学校全体／学科／学年）を選ぶ …
            配下の
            <strong>全クラスに共通</strong>で表示
          </li>
        </ul>
        <p style={{ margin: "0.4rem 0 0", color: color.muted, fontSize: fontSize.xs }}>
          クラスに個別の入力があれば、共通より優先されます（優先順位: クラス ＞ 学年 ＞ 学科 ＞
          学校全体）。
        </p>
      </div>

      <p style={{ margin: "0 0 1rem" }}>
        <Link href="/app/editor/scope/school" style={scopeBtnStyle}>
          <span aria-hidden="true">▦</span> 学校全体の共通を編集
        </Link>
      </p>

      {totalClasses === 0 ? (
        user.role === "school_admin" ? (
          <p style={mutedStyle}>
            編集できるクラスがまだありません。<Link href="/app/school">学校管理</Link>
            で学科・学年・クラスを追加してください。
          </p>
        ) : (
          <p style={mutedStyle}>
            まだクラスがありません。学校管理者がクラスを追加すると、ここに表示されます。
          </p>
        )
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {departments.length > 0 ? (
            <>
              {departments.map((d) => (
                <section key={d.id} style={deptCardStyle}>
                  <div style={headerRowStyle}>
                    <h2 style={deptTitleStyle}>{d.name}</h2>
                    <Link href={`/app/editor/scope/department/${d.id}`} style={scopeBtnSmallStyle}>
                      <span aria-hidden="true">▦</span> この学科の共通を編集
                    </Link>
                  </div>
                  <GradeGroups grades={gradesOf(d.id)} />
                </section>
              ))}
              {orphanGrades.length > 0 ? (
                <section style={deptCardStyle}>
                  <h2 style={deptTitleStyle}>学科未割当</h2>
                  <GradeGroups grades={orphanGrades} />
                </section>
              ) : null}
            </>
          ) : (
            <section style={deptCardStyle}>
              <GradeGroups grades={grades} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** 学年ごとに見出し + 「学年の共通」ボタン + 配下クラスのチップを出す。 */
function GradeGroups({ grades }: { grades: GradeView[] }) {
  if (grades.length === 0) {
    return <p style={mutedSmallStyle}>学年がありません。</p>;
  }
  return (
    <div style={{ display: "grid", gap: "0.8rem" }}>
      {grades.map((g) => (
        <div key={g.id}>
          <div style={headerRowStyle}>
            <h3 style={gradeTitleStyle}>{g.name}</h3>
            <Link href={`/app/editor/scope/grade/${g.id}`} style={scopeBtnSmallStyle}>
              <span aria-hidden="true">▦</span> この学年の共通を編集
            </Link>
          </div>
          {g.classes.length === 0 ? (
            <p style={mutedSmallStyle}>クラスがありません（学校管理で追加）。</p>
          ) : (
            <div
              style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}
            >
              <span style={classGroupLabel}>クラス:</span>
              <ul style={classListStyle}>
                {g.classes.map((c) => (
                  <li key={c.id}>
                    <Link href={`/app/editor/${c.id}`} style={classLinkStyle}>
                      {c.name}
                      <span style={classMetaStyle}>{c.academicYear}年度</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const explainStyle: React.CSSProperties = {
  border: `1px solid ${color.infoBorder}`,
  background: color.infoBg,
  borderRadius: "10px",
  padding: "0.75rem 1rem",
  marginBottom: "1rem",
  fontSize: "0.9rem",
  color: color.ink,
};
const explainListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.1rem",
  display: "grid",
  gap: "0.2rem",
};
const classDot: React.CSSProperties = {
  display: "inline-block",
  width: "0.7rem",
  height: "0.7rem",
  borderRadius: "3px",
  border: `1px solid ${color.border}`,
  background: "#fff",
  verticalAlign: "middle",
};
const scopeDot: React.CSSProperties = {
  display: "inline-block",
  width: "0.7rem",
  height: "0.7rem",
  borderRadius: "3px",
  border: `1px solid ${color.infoBorder}`,
  background: color.infoBg,
  verticalAlign: "middle",
};
const mutedStyle: React.CSSProperties = { color: color.muted };
const mutedSmallStyle: React.CSSProperties = {
  color: color.muted,
  fontSize: fontSize.sm,
  margin: 0,
};
const deptCardStyle: React.CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: "10px",
  padding: "1rem",
};
const deptTitleStyle: React.CSSProperties = { fontSize: "1.1rem", margin: 0 };
const gradeTitleStyle: React.CSSProperties = {
  fontSize: fontSize.md,
  color: color.neutralFg,
  margin: 0,
};
const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  marginBottom: "0.5rem",
  flexWrap: "wrap",
};
// 「前回のクラスを再開」: 最頻アクションなのでブランドのアクション色で最も目立たせる（タップ 48px）。
const resumeBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  minHeight: "48px",
  padding: "0.6rem 1.2rem",
  background: color.primary,
  color: "#fff",
  borderRadius: radius.md,
  fontSize: "1rem",
  fontWeight: 700,
  textDecoration: "none",
};
// 「共通（全体）」編集ボタン: クラスの白チップと明確に区別する青いピル（文字はブランドブルー）。
// タブレット/タッチ前提で最小 44px のタップ領域を確保する（UIUX-02）。
const scopeBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  minHeight: "44px",
  padding: "0.45rem 0.9rem",
  border: `1px solid ${color.infoBorder}`,
  borderRadius: radius.pill,
  background: color.infoBg,
  color: color.blueStrong,
  fontSize: "0.9rem",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
const scopeBtnSmallStyle: React.CSSProperties = {
  ...scopeBtnStyle,
  padding: "0.35rem 0.8rem",
  fontSize: fontSize.sm,
};
const classGroupLabel: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const classListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
};
const classLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  minHeight: "44px",
  padding: "0.5rem 1rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  textDecoration: "none",
  color: color.ink,
  background: "#fff",
  fontSize: "1rem",
};
const classMetaStyle: React.CSSProperties = { color: color.muted, fontSize: fontSize.xs };
