import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import {
  computeTodayActiveClasses,
  getSchoolHierarchy,
  getTodayDailyDataScopes,
} from "@/lib/school-admin/hub-queries";
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
 * エディタ着地 (#48-H)。編集する **モニタ**（＝クラスのサイネージ画面）または **共通範囲**
 * （全クラス一斉 / 学科まとめ / 学年まとめ）を選ぶ。
 *
 * **モニタの壁 (UI レーン 2026-06-15、ユーザー案「モニタが並んでいてタップで編集」)**: 廊下に並ぶ
 * サイネージ TV をそのまま画面に再現する。学科ごとにクラスのモニタが並び、タップでそのモニタの編集
 * 画面（`/app/editor/[classId]`）へ直行する。各画面に **本日 表示中 / 未入力** を出し、空のモニタが
 * 一目で分かるようにする（`getTodayDailyDataScopes` + `computeTodayActiveClasses`、学校管理ハブと同ロジック）。
 * 共通範囲は **青い放送タイル**（全クラス一斉＝上部常設、学科/学年まとめ＝各見出し）で「まとめて映す」
 * ことを色で示し、白い個別モニタと区別する。年度（旧 `academic_year` 表記）は表示しない。
 *
 * **scope まとめ編集（段A-2）**: 「全クラス」「学科」「学年」で保存した内容は、より具体的なクラス個別
 * 入力が無いモニタに共通表示される（精度優先 class > grade > department > school、`effective-daily-data.ts`）。
 */
export default async function EditorIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const { hierarchy, schoolPattern, activeMap } = await withSession(async (tx) => {
    const hierarchy = await getSchoolHierarchy(tx);
    // モニタの「何を編集する画面か」を示すパターンバッジ用（学校レベル既定）。
    const schoolPattern = await getSignageDesignPattern(tx);
    // 各モニタの「本日サイネージに表示中か」を学校管理ハブと同じ遡及窓ロジックで求める。
    const scopes = await getTodayDailyDataScopes(tx);
    const activeMap = computeTodayActiveClasses(scopes, hierarchy.grades);
    return { hierarchy, schoolPattern, activeMap };
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
  // 実在するときだけ「前回のモニタを再開」を最上位に出す（失効/他校の値は無視）。
  const lastClassId = (await cookies()).get(LAST_CLASS_COOKIE)?.value;
  const lastClass = lastClassId ? (allClasses.find((c) => c.id === lastClassId) ?? null) : null;

  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date());

  return (
    <div style={{ maxWidth: "820px", marginInline: "auto" }}>
      <h1 style={{ fontSize: "1.15rem", marginBottom: "0.15rem" }}>編集するモニタを選ぶ</h1>
      <p style={{ margin: "0 0 0.75rem", color: color.muted, fontSize: fontSize.xs }}>
        本日 {todayLabel}
        。モニタをタップするとその画面の編集に進みます。青いタイルはまとめて一斉表示（個別入力が優先）。
      </p>

      {/* クイック操作: 「前回のモニタ」と「全クラス一斉」は頻用なので常に上部（モニタが増えてもスクロール不要）。 */}
      <div style={quickRowStyle}>
        {lastClass ? (
          <Link href={`/app/editor/${lastClass.id}`} style={resumeBtnStyle}>
            <span aria-hidden="true">▶</span> 前回のモニタを再開 — {lastClass.gradeName}{" "}
            {lastClass.name}
          </Link>
        ) : null}
        <Link href="/app/editor/scope/school" style={broadcastBtnStyle}>
          <span aria-hidden="true">▦</span> 全クラスに一斉表示
        </Link>
      </div>

      {totalClasses === 0 ? (
        user.role === "school_admin" ? (
          <p style={mutedStyle}>
            編集できるモニタがまだありません。<Link href="/app/school">学校管理</Link>
            で学科・学年・クラスを追加してください。
          </p>
        ) : (
          <p style={mutedStyle}>
            まだモニタがありません。学校管理者がクラスを追加すると、ここに表示されます。
          </p>
        )
      ) : (
        <div style={{ display: "grid", gap: "1.5rem" }}>
          {departments.length > 0 ? (
            <>
              {departments.map((d) => (
                <section key={d.id}>
                  <div style={sectionHeadStyle}>
                    <h2 style={deptTitleStyle}>{d.name}</h2>
                    <BroadcastChip href={`/app/editor/scope/department/${d.id}`}>
                      この学科にまとめて出す
                    </BroadcastChip>
                  </div>
                  <GradeGroups
                    grades={gradesOf(d.id)}
                    schoolPattern={schoolPattern}
                    activeMap={activeMap}
                  />
                </section>
              ))}
              {orphanGrades.length > 0 ? (
                <section>
                  <h2 style={deptTitleStyle}>学科未割当</h2>
                  <GradeGroups
                    grades={orphanGrades}
                    schoolPattern={schoolPattern}
                    activeMap={activeMap}
                  />
                </section>
              ) : null}
            </>
          ) : (
            <GradeGroups grades={grades} schoolPattern={schoolPattern} activeMap={activeMap} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 学年ごとに薄い見出し + 「学年まとめ」放送チップ + 配下クラスのモニタを並べる。
 * 学年見出しは細い区切り線で軽く（旧「見にくい」対策）、主役はモニタ。
 */
function GradeGroups({
  grades,
  schoolPattern,
  activeMap,
}: {
  grades: GradeView[];
  schoolPattern: SignageDesignPattern;
  activeMap: Record<string, boolean>;
}) {
  if (grades.length === 0) {
    return <p style={mutedSmallStyle}>学年がありません。</p>;
  }
  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {grades.map((g) => (
        <div key={g.id}>
          <div style={gradeDividerStyle}>
            <span style={gradeLabelStyle}>{g.name}</span>
            <span style={gradeRuleStyle} aria-hidden="true" />
            {g.classes.length > 1 ? (
              <BroadcastChip href={`/app/editor/scope/grade/${g.id}`} small>
                この学年だけまとめて
              </BroadcastChip>
            ) : null}
          </div>
          {g.classes.length === 0 ? (
            <p style={mutedSmallStyle}>クラスがありません（学校管理で追加）。</p>
          ) : (
            <div style={monitorGridStyle}>
              {g.classes.map((c) => (
                <Monitor
                  key={c.id}
                  href={`/app/editor/${c.id}`}
                  name={c.name}
                  active={activeMap[c.id] ?? false}
                  pattern={schoolPattern}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 1 台のモニタ（クラスのサイネージ画面）。ベゼル + 画面 + スタンドで TV を再現し、タップで編集へ。 */
function Monitor({
  href,
  name,
  active,
  pattern,
}: {
  href: string;
  name: string;
  active: boolean;
  pattern: SignageDesignPattern;
}) {
  return (
    <Link href={href} style={monitorLinkStyle}>
      <div style={bezelStyle}>
        <div style={{ ...screenStyle, background: active ? "#fff" : "#f9fafb" }}>
          <div style={screenHeadStyle}>
            <StatusDot active={active} />
          </div>
          <span style={{ ...screenNameStyle, color: active ? color.ink : color.muted }}>
            {name}
          </span>
          <span style={screenSubStyle}>
            {active ? "本日の内容を表示中" : "まだ何も表示していません"}
          </span>
          <span style={screenPatternRowStyle}>
            <PatternBadge pattern={pattern} />
          </span>
        </div>
      </div>
      <div style={neckStyle} aria-hidden="true" />
      <div style={baseStyle} aria-hidden="true" />
      <span style={captionStyle}>タップして編集</span>
    </Link>
  );
}

/** 本日サイネージに表示中か（緑＝表示中 / グレー＝未入力）を一目で示す。 */
function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        fontSize: "0.7rem",
        color: active ? color.successFg : color.muted,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: active ? "#22c55e" : "transparent",
          border: active ? "none" : `1.5px solid ${color.border}`,
        }}
      />
      {active ? "表示中" : "未入力"}
    </span>
  );
}

/**
 * 「まとめて映す」共通範囲（学校 / 学科 / 学年）への放送チップ。クラスの白いモニタと色で区別し、
 * 「1 つの画面ではなく、配下のモニタ全部へまとめて出す」ことを青 + 放送アイコンで示す。
 */
function BroadcastChip({
  href,
  children,
  small,
}: {
  href: string;
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <Link href={href} style={small ? broadcastChipSmallStyle : broadcastChipStyle}>
      {children} <span aria-hidden="true">→</span>
    </Link>
  );
}

/**
 * モニタが「何を映す画面か（サイネージパターン）」を一目で示すバッジ。
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
        fontSize: "0.65rem",
        padding: "0.05rem 0.4rem",
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
// 「前回のモニタ」: 最頻アクションなのでブランドのアクション色（オレンジ）で最も目立たせる（タップ 52px）。
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
// 「全クラスに一斉表示」: 頻用の放送アクション。ブランドブルーで前回モニタ（オレンジ）と並べて常設。
const broadcastBtnStyle: React.CSSProperties = {
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
  marginBottom: "0.75rem",
  flexWrap: "wrap",
};
const deptTitleStyle: React.CSSProperties = { fontSize: "1.1rem", margin: 0 };
// 学年見出し: 細い区切り線で軽く出す（モニタを主役にするため）。
const gradeDividerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  marginBottom: "0.6rem",
};
const gradeLabelStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.neutralFg,
  fontWeight: 600,
  whiteSpace: "nowrap",
};
const gradeRuleStyle: React.CSSProperties = {
  flex: "1 1 auto",
  height: "1px",
  background: color.border,
};
// 放送チップ: その場で押せる青チップ。白いモニタと色で区別（まとめて映す＝青）。
const broadcastChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
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
const broadcastChipSmallStyle: React.CSSProperties = {
  ...broadcastChipStyle,
  minHeight: "30px",
  padding: "0.2rem 0.6rem",
  fontSize: fontSize.xs,
};
const monitorGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: "1rem",
};
// モニタ: 主役。TV ベゼル + 画面 + スタンドで「廊下のサイネージ」を再現し、大きくタップしやすく。
const monitorLinkStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textDecoration: "none",
  color: color.ink,
};
const bezelStyle: React.CSSProperties = {
  width: "100%",
  background: "#23272e",
  borderRadius: "10px",
  padding: "7px",
};
const screenStyle: React.CSSProperties = {
  borderRadius: "4px",
  minHeight: "108px",
  padding: "0.5rem 0.6rem",
  display: "flex",
  flexDirection: "column",
};
const screenHeadStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
};
const screenNameStyle: React.CSSProperties = {
  fontSize: "0.95rem",
  fontWeight: 600,
  margin: "0.3rem 0 0.2rem",
};
const screenSubStyle: React.CSSProperties = { fontSize: "0.7rem", color: color.muted };
const screenPatternRowStyle: React.CSSProperties = {
  marginTop: "auto",
  alignSelf: "flex-start",
  paddingTop: "0.4rem",
};
const neckStyle: React.CSSProperties = { width: "14px", height: "9px", background: "#23272e" };
const baseStyle: React.CSSProperties = {
  width: "64px",
  height: "7px",
  background: "#23272e",
  borderRadius: "2px 2px 5px 5px",
};
const captionStyle: React.CSSProperties = {
  marginTop: "0.5rem",
  fontSize: fontSize.xs,
  color: color.muted,
};
const mutedStyle: React.CSSProperties = { color: color.muted };
const mutedSmallStyle: React.CSSProperties = {
  color: color.muted,
  fontSize: fontSize.sm,
  margin: 0,
};
