import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { getSchoolHierarchy } from "@/lib/school-admin/hub-queries";
import type { GradeView } from "@/lib/school-admin/hub-queries";
import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LAST_CLASS_COOKIE } from "./[classId]/_components/RememberLastClass";

const { color, fontSize, radius } = tokens;

/**
 * エディタ着地 (#48-H)。編集する **クラス** または **共通範囲**（学校全体 / 学科 / 学年）を選ぶ。
 *
 * **見やすさ刷新 (UI レーン 2026-06-13、ユーザー指摘「見にくい」)**: クラス選択（最頻アクション）を
 * **大きなタイルで主役**にし、頻用の「全クラス共通で出す」は**上部のクイック操作に常設**してクラスが
 * 増えてもスクロールせず押せるようにする。学年共通は各学年見出しの右に置き、その場で押せる。重かった
 * 概念説明ボックスは 1 行に圧縮する（白＝クラス / 共通＝青、という区別はレイアウトで表現）。
 *
 * **scope まとめ編集（段A-2）**: 「学校全体」「学科の共通」「学年の共通」で保存した内容は、より具体的な
 * クラス個別入力が無いクラスのサイネージに共通表示される（精度優先 class > grade > department > school、
 * `effective-daily-data.ts`）。
 */
export default async function EditorIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const { hierarchy, schoolPattern } = await withSession(async (tx) => {
    const hierarchy = await getSchoolHierarchy(tx);
    // クラスタイルの「何を編集する画面か」を示すパターンバッジ用（学校レベル既定）。
    const schoolPattern = await getSignageDesignPattern(tx);
    return { hierarchy, schoolPattern };
  });
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
    <div style={{ maxWidth: "780px" }}>
      <h1 style={{ fontSize: "1.15rem", marginBottom: "0.15rem" }}>編集するクラスを選ぶ</h1>
      <p style={{ margin: "0 0 0.75rem", color: color.muted, fontSize: fontSize.xs }}>
        クラスを選ぶとそのクラスだけに表示。共通は全クラスへ（個別入力が優先）。
      </p>

      {/* クイック操作: 「前回のクラス」と「全クラス共通」は頻用なので常に上部（クラスが増えてもスクロール不要）。 */}
      <div style={quickRowStyle}>
        {lastClass ? (
          <Link href={`/app/editor/${lastClass.id}`} style={resumeBtnStyle}>
            <span aria-hidden="true">▶</span> 前回のクラスを再開 — {lastClass.gradeName}{" "}
            {lastClass.name}
          </Link>
        ) : null}
        <Link href="/app/editor/scope/school" style={commonBtnStyle}>
          <span aria-hidden="true">▦</span> 全クラス共通で出す
        </Link>
      </div>

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
        <div style={{ display: "grid", gap: "1.25rem" }}>
          {departments.length > 0 ? (
            <>
              {departments.map((d) => (
                <section key={d.id}>
                  <div style={sectionHeadStyle}>
                    <h2 style={deptTitleStyle}>{d.name}</h2>
                    <Link href={`/app/editor/scope/department/${d.id}`} style={scopeChipStyle}>
                      この学科の共通 →
                    </Link>
                  </div>
                  <GradeGroups grades={gradesOf(d.id)} schoolPattern={schoolPattern} />
                </section>
              ))}
              {orphanGrades.length > 0 ? (
                <section>
                  <h2 style={deptTitleStyle}>学科未割当</h2>
                  <GradeGroups grades={orphanGrades} schoolPattern={schoolPattern} />
                </section>
              ) : null}
            </>
          ) : (
            <GradeGroups grades={grades} schoolPattern={schoolPattern} />
          )}
        </div>
      )}
    </div>
  );
}

/** 学年ごとに見出し + 「学年の共通」ボタン + 配下クラスの大きなタイル（パターンバッジ付き）を出す。 */
function GradeGroups({
  grades,
  schoolPattern,
}: {
  grades: GradeView[];
  schoolPattern: SignageDesignPattern;
}) {
  if (grades.length === 0) {
    return <p style={mutedSmallStyle}>学年がありません。</p>;
  }
  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {grades.map((g) => (
        <div key={g.id}>
          <div style={sectionHeadStyle}>
            <h3 style={gradeTitleStyle}>{g.name}</h3>
            <Link href={`/app/editor/scope/grade/${g.id}`} style={scopeChipStyle}>
              この学年の共通 →
            </Link>
          </div>
          {g.classes.length === 0 ? (
            <p style={mutedSmallStyle}>クラスがありません（学校管理で追加）。</p>
          ) : (
            <div style={classGridStyle}>
              {g.classes.map((c) => (
                <Link key={c.id} href={`/app/editor/${c.id}`} style={classTileStyle}>
                  <span style={classTileNameStyle}>{c.name}</span>
                  <span style={classTileMetaRowStyle}>
                    <span style={classTileYearStyle}>{c.academicYear}年度</span>
                    <PatternBadge pattern={schoolPattern} />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * クラスが「何を編集する画面か（サイネージパターン）」を一目で示すバッジ。
 *
 * TODO(その他レーン / pattern 単一ソース): 現状は **学校レベル既定**（`getSignageDesignPattern`）を全クラス
 * 共通で表示している。端末別 `?design` 上書きを含む **per-class 解決**は、pattern→ブロックの宣言的単一
 * ソース（finding①）確定後にそこから取得して差し替える（バッジ位置・見た目は本実装を流用）。
 */
function PatternBadge({ pattern }: { pattern: SignageDesignPattern }) {
  const isP2 = pattern === "pattern2";
  return (
    <span
      style={{
        fontSize: fontSize.xs,
        padding: "0.05rem 0.45rem",
        borderRadius: radius.sm,
        background: isP2 ? color.warningBg : color.infoBg,
        color: isP2 ? color.warningFg : color.infoFg,
        whiteSpace: "nowrap",
      }}
    >
      {isP2 ? "パターン2" : "パターン1"}
    </span>
  );
}

const quickRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.75rem",
  marginBottom: "1.5rem",
};
// 「前回のクラス」: 最頻アクションなのでブランドのアクション色（オレンジ）で最も目立たせる（タップ 52px）。
const resumeBtnStyle: React.CSSProperties = {
  flex: "1 1 240px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  minHeight: "52px",
  padding: "0.6rem 1.2rem",
  background: color.primary,
  color: "#fff",
  borderRadius: radius.md,
  fontSize: "1rem",
  fontWeight: 700,
  textDecoration: "none",
};
// 「全クラス共通で出す」: 頻用の副次アクション。ブランドブルーで前回クラス（オレンジ）と並べて常設。
const commonBtnStyle: React.CSSProperties = {
  flex: "1 1 240px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  minHeight: "52px",
  padding: "0.6rem 1.2rem",
  background: color.blueStrong,
  color: "#fff",
  borderRadius: radius.md,
  fontSize: "1rem",
  fontWeight: 600,
  textDecoration: "none",
};
const sectionHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  marginBottom: "0.6rem",
  flexWrap: "wrap",
};
const deptTitleStyle: React.CSSProperties = { fontSize: "1.1rem", margin: 0 };
const gradeTitleStyle: React.CSSProperties = {
  fontSize: fontSize.md,
  color: color.neutralFg,
  margin: 0,
  fontWeight: 600,
};
// 「この学年/学科の共通」: その場で押せる青チップ（タップ 36px）。クラスタイル（白）と色で区別。
const scopeChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "36px",
  padding: "0.35rem 0.8rem",
  borderRadius: radius.md,
  background: color.infoBg,
  color: color.blueStrong,
  fontSize: fontSize.sm,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
const classGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  gap: "0.6rem",
};
// クラスタイル: 主役。白カードで大きくタップしやすく（最小 66px）、年度＋パターンを添える。
const classTileStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.4rem",
  minHeight: "66px",
  padding: "0.7rem 0.85rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: "#fff",
  textDecoration: "none",
  color: color.ink,
};
const classTileNameStyle: React.CSSProperties = { fontSize: "1rem", fontWeight: 600 };
const classTileMetaRowStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const classTileYearStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const mutedStyle: React.CSSProperties = { color: color.muted };
const mutedSmallStyle: React.CSSProperties = {
  color: color.muted,
  fontSize: fontSize.sm,
  margin: 0,
};
