import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import {
  type GradeView,
  type SchoolHierarchy,
  computeTodayActiveClasses,
  getSchoolHierarchy,
  getTodayDailyDataScopes,
} from "@/lib/school-admin/hub-queries";
import { jstDateString } from "@/lib/signage/rotation";
import { type SignagePayload, buildSignagePayloadForClass } from "@/lib/signage/signage-display";
import { ScaledSignageBoard } from "@/app/(signage)/signage/[classToken]/_components/ScaledSignageBoard";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LAST_CLASS_COOKIE } from "./[classId]/_components/RememberLastClass";
import { type DrawerClass, type DrawerDept, MonitorDrawer } from "./_components/MonitorDrawer";
import styles from "./_components/MonitorWall.module.css";

const { color, radius } = tokens;

/**
 * エディタ着地「**実画面モニタの壁**」(PR・A、#953 `ScaledSignageBoard` に依存・stacked)。
 *
 * 編集する **クラス** を、その端末に実際に映るサイネージ画面（16:9 縮小サムネ）で選ばせる。各モニタは実機
 * サイネージと**同一の payload ビルダー**（`buildSignagePayloadForClass`、`signage-display.ts` 単一ソース）で
 * 組み立てた `SignagePayload` を `ScaledSignageBoard`（read-only・静的）で縮小描画する＝見た目が実画面と一致
 * する。タイトル・説明見出しは出さない／年度（academic_year）表記は一切出さない（承認済みプレビュー準拠）。
 *
 * **レイアウト（1 ページで PC=複数列 / スマホ=3 列＋ドロワー、CSS メディアクエリで切替）**:
 *   - PC: モニタを小さめに複数列（`auto-fill, minmax(200px,1fr)` ≒ 3 列前後）で学科ごとにグルーピング。
 *     学科見出しの右に青い放送チップ「この学科にまとめて出す」。上部にクイック行（前回再開=オレンジ /
 *     全クラス一斉=青）。
 *   - スマホ: 本体はモニタのみ（1 行 3 列・小さめ）。クイック行/サマリは出さず、ハンバーガー → 横リスト
 *     （ドロワー `MonitorDrawer`・client island）に操作を集約する。本体ページは Server のまま。
 *
 * **scope まとめ編集（段A-2）**: 「学校全体」「学科の共通」で保存した内容は、より具体的なクラス個別入力が
 * 無いクラスのサイネージに共通表示される（精度優先 class > grade > department > school、`effective-daily-data.ts`）。
 * 承認済みプレビュー準拠で**学年共通チップは出さない**が、scope/grade ルート自体は存続する（直接 URL で到達可）。
 */
export default async function EditorIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const date = jstDateString();
  // EDITOR_ROLES（school_admin / teacher）はテナント claim を持つので schoolId は実運用では非 null。
  // 万一 null（claim 欠落）でも weather の prefecture 解決対象が空になるだけで RLS が越境を止める（fail-soft、
  // 盤面は壊さない）。weather 取得対象特定にのみ使い、テナント分離は withSession の RLS 文脈が担保する（ルール2）。
  const schoolId = user.schoolId ?? "";
  const { hierarchy, statusByClass, payloadByClass } = await withSession(async (tx) => {
    const hierarchy = await getSchoolHierarchy(tx);
    const scopes = await getTodayDailyDataScopes(tx);
    const statusByClass = computeTodayActiveClasses(scopes, hierarchy.grades);
    // 各クラスの実画面 payload を実機と同一ビルダーで組み立てる（単一ソース）。空クラスは空 payload
    // （盤面は placeholder を自然に描く）。N が増えても 1 tx 内で読むので追加コネクションは増えない。
    // この学校はクラス少で問題なし（将来 N 多数時は lazy 化できるよう「事前構築 payload を素材に渡す」
    // 形に保つ）。
    const allClassIds = hierarchy.grades.flatMap((g) => g.classes.map((c) => c.id));
    const payloadByClass: Record<string, SignagePayload> = {};
    for (const classId of allClassIds) {
      const payload = await buildSignagePayloadForClass(tx, schoolId, classId, date);
      if (payload) {
        payloadByClass[classId] = payload;
      }
    }
    return { hierarchy, statusByClass, payloadByClass };
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
  // 実在するときだけ「前回のモニタを再開」を出す（失効/他校の値は無視＝IDOR 防止）。
  const lastClassId = (await cookies()).get(LAST_CLASS_COOKIE)?.value;
  const lastClass = lastClassId ? (allClasses.find((c) => c.id === lastClassId) ?? null) : null;
  const resumeHref = lastClass ? `/app/editor/${lastClass.id}` : null;
  const resumeLabel = lastClass ? `${lastClass.gradeName} ${lastClass.name}` : null;
  const broadcastAllHref = "/app/editor/scope/school";

  // ドロワー（スマホ横リスト）用の serializable な学科グループを Server 側で組み立てる。
  const drawerDepts = buildDrawerDepts(hierarchy, statusByClass);

  return (
    <div className={styles.root}>
      {/* スマホのみ: ハンバーガー → 横リスト（ドロワー）。操作はここに集約（本体はモニタのみ）。 */}
      <div className={styles.hamburgerBar}>
        <MonitorDrawer
          depts={drawerDepts}
          resumeHref={resumeHref}
          resumeLabel={resumeLabel}
          broadcastAllHref={broadcastAllHref}
        />
      </div>

      {/* PC のみ: クイック行（前回再開 / 全クラス一斉）。スマホは display:none（ドロワーに集約）。 */}
      <div className={styles.quickRow}>
        {resumeHref ? (
          <Link href={resumeHref} style={resumeBtnStyle}>
            <span aria-hidden="true">▶</span> 前回のモニタを再開 — {resumeLabel}
          </Link>
        ) : null}
        <Link href={broadcastAllHref} style={commonBtnStyle}>
          <span aria-hidden="true">▦</span> 全クラスに一斉表示
        </Link>
      </div>

      {totalClasses === 0 ? (
        user.role === "school_admin" ? (
          <p className={styles.empty}>
            編集できるクラスがまだありません。<Link href="/app/school">学校管理</Link>
            で学科・学年・クラスを追加してください。
          </p>
        ) : (
          <p className={styles.empty}>
            まだクラスがありません。学校管理者がクラスを追加すると、ここに表示されます。
          </p>
        )
      ) : (
        <div>
          {departments.length > 0 ? (
            <>
              {departments.map((d) => (
                <section key={d.id} className={styles.deptSection}>
                  <div className={styles.sectionHead}>
                    <h2 style={deptTitleStyle}>{d.name}</h2>
                    <Link href={`/app/editor/scope/department/${d.id}`} style={broadcastChipStyle}>
                      この学科にまとめて出す →
                    </Link>
                  </div>
                  <GradeMonitors
                    grades={gradesOf(d.id)}
                    statusByClass={statusByClass}
                    payloadByClass={payloadByClass}
                  />
                </section>
              ))}
              {orphanGrades.length > 0 ? (
                <section className={styles.deptSection}>
                  <div className={styles.sectionHead}>
                    <h2 style={deptTitleStyle}>学科未割当</h2>
                  </div>
                  <GradeMonitors
                    grades={orphanGrades}
                    statusByClass={statusByClass}
                    payloadByClass={payloadByClass}
                  />
                </section>
              ) : null}
            </>
          ) : (
            <GradeMonitors
              grades={grades}
              statusByClass={statusByClass}
              payloadByClass={payloadByClass}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** 学年ごとにモニタ（実画面サムネ）のグリッドを出す。年度は出さない（承認済みプレビュー準拠）。 */
function GradeMonitors({
  grades,
  statusByClass,
  payloadByClass,
}: {
  grades: GradeView[];
  statusByClass: Record<string, boolean>;
  payloadByClass: Record<string, SignagePayload>;
}) {
  const withClasses = grades.filter((g) => g.classes.length > 0);
  if (withClasses.length === 0) {
    return null;
  }
  return (
    <div>
      {withClasses.map((g) => (
        <div key={g.id} className={styles.gradeGroup}>
          <div className={styles.monitorGrid}>
            {g.classes.map((c) => {
              const active = statusByClass[c.id] ?? false;
              const payload = payloadByClass[c.id] ?? null;
              return (
                <Link
                  key={c.id}
                  href={`/app/editor/${c.id}`}
                  className={`${styles.monitorTile} ${active ? "" : styles.monitorTileEmpty}`}
                  aria-label={`${g.name} ${c.name} を編集`}
                >
                  <div className={styles.thumb}>
                    {payload ? <ScaledSignageBoard payload={payload} /> : null}
                  </div>
                  <div className={styles.tileFoot}>
                    <span
                      className={`${styles.statusDot} ${active ? styles.statusActive : styles.statusEmpty}`}
                      aria-label={active ? "本日表示中" : "未入力"}
                    />
                    <span className={styles.tileLabel}>
                      {g.name} {c.name}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** ドロワー（スマホ横リスト）用に serializable な学科グループを組み立てる。年度は出さない。 */
function buildDrawerDepts(
  hierarchy: SchoolHierarchy,
  statusByClass: Record<string, boolean>,
): DrawerDept[] {
  const { departments, grades } = hierarchy;
  const toClasses = (gradeList: GradeView[]): DrawerClass[] =>
    gradeList.flatMap((g) =>
      g.classes.map((c) => ({
        id: c.id,
        label: `${g.name} ${c.name}`,
        active: statusByClass[c.id] ?? false,
      })),
    );
  const gradesOf = (deptId: string | null) => grades.filter((g) => g.departmentId === deptId);
  const out: DrawerDept[] = [];
  if (departments.length > 0) {
    for (const d of departments) {
      out.push({
        id: d.id,
        name: d.name,
        broadcastHref: `/app/editor/scope/department/${d.id}`,
        classes: toClasses(gradesOf(d.id)),
      });
    }
    const orphan = toClasses(grades.filter((g) => !g.departmentId));
    if (orphan.length > 0) {
      out.push({ id: null, name: null, broadcastHref: null, classes: orphan });
    }
  } else {
    // 学科が無い学校: 学科未割当の単一グループにまとめる（まとめ出し導線は学校全体側で担う）。
    out.push({ id: null, name: null, broadcastHref: null, classes: toClasses(grades) });
  }
  return out;
}

// 「前回のモニタを再開」: 最頻アクションなのでブランドのアクション色（オレンジ）で最も目立たせる（タップ 52px）。
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
// 「全クラスに一斉表示」: 頻用の副次アクション。ブランドブルーで前回モニタ（オレンジ）と並べて常設。
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
const deptTitleStyle: React.CSSProperties = { fontSize: "1.1rem", margin: 0 };
// 「この学科にまとめて出す」: その場で押せる青チップ（タップ 36px）。
const broadcastChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "36px",
  padding: "0.35rem 0.8rem",
  borderRadius: radius.md,
  background: color.infoBg,
  color: color.blueStrong,
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
