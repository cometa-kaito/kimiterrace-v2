import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  type OtherClass,
  computeTodayActiveOtherClasses,
  getOtherClasses,
} from "@/lib/editor/other-classes-queries";
import { getClassMonitorInfo } from "@/lib/editor/monitor-queries";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import {
  type GradeView,
  type SchoolHierarchy,
  computeTodayActiveClasses,
  getSchoolHierarchy,
  getTodayDailyDataScopes,
} from "@/lib/school-admin/hub-queries";
import { resolveDesignPattern } from "@/lib/signage/design-pattern";
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
 * 壁の各モニタ（実画面サムネ）の描画幅(px)。`ScaledSignageBoard` に**明示 width** を渡し、cqw（container
 * query）非依存で確実に縮小する。grid の `1fr` トラックだと `.frame` の幅が定まらず container-query が
 * 破綻して盤面が原寸のままクリップされる不具合があったため、固定幅 + 明示 width で決定的に縮小する。
 */
const MONITOR_THUMB_W = 160;

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
  const { hierarchy, otherClasses, statusByClass, payloadByClass, monitorInfo } = await withSession(
    async (tx) => {
      const hierarchy = await getSchoolHierarchy(tx);
      // 「その他」(grade_id NULL の非教室設置場所) は学年ツリー外なので hub-queries の hierarchy に含まれない。
      // エディタ自身のデータ層で別途読み、壁に「その他」セクションとして出す（全ロールが daily_data を編集可）。
      const otherClasses = await getOtherClasses(tx);
      const scopes = await getTodayDailyDataScopes(tx);
      const statusByClass = {
        ...computeTodayActiveClasses(scopes, hierarchy.grades),
        // 「その他」は学年を持たないので class → department → school で本日掲示状態を判定する（grade 段スキップ）。
        ...computeTodayActiveOtherClasses(scopes, otherClasses),
      };
      // 自校の「クラス→代表サイネージ URL」と学校レベル既定パターンをまとめて取得（1 tx・RLS 自校限定）。
      // (1) 学科にモニタが紐づくか（壁から学科を出すか）/ (2) 端末別 `?design` でサムネを実機と同じパターンで描く、
      // の両方をこの 1 ソースで駆動する。
      const monitorInfo = await getClassMonitorInfo(tx);
      // 各クラスの実画面 payload を実機と同一ビルダーで組み立てる（単一ソース）。空クラスは空 payload
      // （盤面は placeholder を自然に描く）。N が増えても 1 tx 内で読むので追加コネクションは増えない。
      // この学校はクラス少で問題なし（将来 N 多数時は lazy 化できるよう「事前構築 payload を素材に渡す」
      // 形に保つ）。「その他」も通常クラスと同じビルダーで組む（payload 単一ソース・実機一致）。
      const allClassIds = [
        ...hierarchy.grades.flatMap((g) => g.classes.map((c) => c.id)),
        ...otherClasses.map((c) => c.id),
      ];
      const payloadByClass: Record<string, SignagePayload> = {};
      for (const classId of allClassIds) {
        // このクラスの端末別パターン（`?design` > 学校既定 > pattern1）でサムネを実機と同じ盤面で描く。
        const design = resolveDesignPattern(
          monitorInfo.signageUrlByClass.get(classId),
          monitorInfo.schoolDefaultPattern,
        );
        const payload = await buildSignagePayloadForClass(tx, schoolId, classId, date, design);
        if (payload) {
          payloadByClass[classId] = payload;
        }
      }
      return { hierarchy, otherClasses, statusByClass, payloadByClass, monitorInfo };
    },
  );

  const { departments, grades } = hierarchy;
  // 「その他」を学科ごと / 学校直下に振り分ける（学科配下＝department_id 一致 / 学校直下＝department_id NULL）。
  const othersOf = (deptId: string | null) => otherClasses.filter((c) => c.departmentId === deptId);
  const schoolOthers = othersOf(null);
  const gradesOf = (deptId: string | null) => grades.filter((g) => g.departmentId === deptId);
  const orphanGrades = grades.filter((g) => !g.departmentId);
  // 実機モニタが紐づくクラス集合（`signage_url` を持つ未削除 TV が在るクラス）。学科を壁に出すかの判定に使う。
  const monitorClassIds = new Set(monitorInfo.signageUrlByClass.keys());
  // 学科に実機モニタが 1 台も紐づかないなら、その学科は壁から丸ごと隠す（見出し・「まとめて出す」・配下タイル）。
  // 判定は学科配下の通常クラス（学年経由）＋学科配下「その他」のいずれかが monitorClassIds に含まれるか
  // （ユーザー指示 2026-06-18: モニタの壁なので、表示するモニタが無い学科は出さない）。
  const departmentHasMonitor = (deptId: string): boolean => {
    const classIds = [
      ...gradesOf(deptId).flatMap((g) => g.classes.map((c) => c.id)),
      ...othersOf(deptId).map((c) => c.id),
    ];
    return classIds.some((id) => monitorClassIds.has(id));
  };
  const visibleDepartments = departments.filter((d) => departmentHasMonitor(d.id));
  // 編集できる箱の総数（通常クラス + 「その他」）。空状態 / 単一クラス自動直行の判定に使う。
  const totalClasses = grades.reduce((n, g) => n + g.classes.length, 0) + otherClasses.length;

  // UIUX-02 ホップ削減①: 編集できるクラスが 1 つだけの teacher は選択画面を飛ばして直行する。
  // school_admin は共通（scope）編集も使うため自動遷移しない。クラス画面の「戻る」は ?stay=1 で
  // 本ページに留まれる（自動遷移とのループ防止）。「その他」も 1 つの編集可能な箱として扱う（学年は
  // 持たないのでラベルは名前のみ、grade 突合からは除外）。
  const allClasses = [
    ...grades.flatMap((g) => g.classes.map((c) => ({ id: c.id, label: `${g.name} ${c.name}` }))),
    ...otherClasses.map((c) => ({ id: c.id, label: c.name })),
  ];
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
  const resumeLabel = lastClass ? lastClass.label : null;
  const broadcastAllHref = "/app/editor/scope/school";

  // ドロワー（スマホ横リスト）用の serializable な学科グループを Server 側で組み立てる。実機モニタが紐づか
  // ない学科は壁と同様にドロワーからも除く（monitorClassIds で判定）。
  const drawerDepts = buildDrawerDepts(hierarchy, otherClasses, statusByClass, monitorClassIds);

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
              {/* 実機モニタが紐づく学科だけを出す（visibleDepartments）。モニタの無い学科は見出し・「まとめて
                  出す」・配下タイルごと非表示（ユーザー指示 2026-06-18）。学科未割当 / 学校直下「その他」は
                  学科ではないので従来どおり別枠で出す。 */}
              {visibleDepartments.map((d) => (
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
                  {/* この学科配下の「その他」(非教室・学年なし) 設置場所。学年ツリーの下に並べる。 */}
                  <OtherMonitors
                    others={othersOf(d.id)}
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

          {/* 学校直下の「その他」(department_id NULL の非教室設置場所)。学科配下の「その他」は各学科
              セクション内に出すので、ここは学校直下ぶんだけ。学科が無い学校では全「その他」がここに集まる。 */}
          {schoolOthers.length > 0 ? (
            <section className={styles.deptSection}>
              <div className={styles.sectionHead}>
                <h2 style={deptTitleStyle}>その他</h2>
              </div>
              <OtherMonitors
                others={schoolOthers}
                statusByClass={statusByClass}
                payloadByClass={payloadByClass}
                hideHeading
              />
            </section>
          ) : null}
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
  // 学科内の全クラスを **1 グリッドに集約**（学年順）。学年ごとに別グリッドにすると 1 学年 1 クラスの学校で
  // モニタが縦に細く積まれてしまう（実機の壁＝横並びにならない）ため。学年の文脈はラベル（学年 + クラス名）で示す。
  const classes = grades.flatMap((g) => g.classes.map((c) => ({ ...c, gradeName: g.name })));
  if (classes.length === 0) {
    return null;
  }
  return (
    <div className={styles.monitorGrid}>
      {classes.map((c) => {
        const active = statusByClass[c.id] ?? false;
        const payload = payloadByClass[c.id] ?? null;
        return (
          <Link
            key={c.id}
            href={`/app/editor/${c.id}`}
            className={`${styles.monitorTile} ${active ? "" : styles.monitorTileEmpty}`}
            aria-label={`${c.gradeName} ${c.name} を編集`}
          >
            <div className={styles.thumb}>
              {/* 明示 width で確実に縮小（cqw 非依存・原寸クリップ不具合の対策）。 */}
              {payload ? <ScaledSignageBoard payload={payload} width={MONITOR_THUMB_W} /> : null}
            </div>
            <div className={styles.tileFoot}>
              <span
                className={`${styles.statusDot} ${active ? styles.statusActive : styles.statusEmpty}`}
                aria-label={active ? "本日表示中" : "未入力"}
              />
              <span className={styles.tileLabel}>
                {c.gradeName} {c.name}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * 「その他」(非教室・grade_id NULL の設置場所) のモニタ（実画面サムネ）グリッド。通常クラスと同じタイル/
 * リンク（`/app/editor/[classId]`）・状態ドットで出し、全ロールが中身（daily_data）を編集できる。学年を
 * 持たないのでラベルはクラス名のみ（年度・学年は出さない）。`hideHeading` は呼び出し側が既に「その他」見出しを
 * 出しているとき（学校直下セクション）に小見出しを抑制する。学科配下では学年モニタの下に小見出し付きで並ぶ。
 */
function OtherMonitors({
  others,
  statusByClass,
  payloadByClass,
  hideHeading = false,
}: {
  others: OtherClass[];
  statusByClass: Record<string, boolean>;
  payloadByClass: Record<string, SignagePayload>;
  hideHeading?: boolean;
}) {
  if (others.length === 0) {
    return null;
  }
  return (
    <div style={hideHeading ? undefined : otherGroupStyle}>
      {hideHeading ? null : <h3 style={otherSubTitleStyle}>その他</h3>}
      <div className={styles.monitorGrid}>
        {others.map((c) => {
          const active = statusByClass[c.id] ?? false;
          const payload = payloadByClass[c.id] ?? null;
          return (
            <Link
              key={c.id}
              href={`/app/editor/${c.id}`}
              className={`${styles.monitorTile} ${active ? "" : styles.monitorTileEmpty}`}
              aria-label={`${c.name} を編集`}
            >
              <div className={styles.thumb}>
                {payload ? <ScaledSignageBoard payload={payload} width={MONITOR_THUMB_W} /> : null}
              </div>
              <div className={styles.tileFoot}>
                <span
                  className={`${styles.statusDot} ${active ? styles.statusActive : styles.statusEmpty}`}
                  aria-label={active ? "本日表示中" : "未入力"}
                />
                <span className={styles.tileLabel}>{c.name}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ドロワー（スマホ横リスト）用に serializable な学科グループを組み立てる。年度は出さない。
 * `monitorClassIds` に配下クラスが 1 つも含まれない学科は**壁と同様に除外**する（実機モニタが紐づかない学科は
 * 出さない・ユーザー指示 2026-06-18）。
 */
function buildDrawerDepts(
  hierarchy: SchoolHierarchy,
  otherClasses: OtherClass[],
  statusByClass: Record<string, boolean>,
  monitorClassIds: Set<string>,
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
  // 「その他」(学年なし) はラベルを名前のみにする（学年文脈が無い）。学年クラスの後ろに並べる。
  const toOtherRows = (deptId: string | null): DrawerClass[] =>
    otherClasses
      .filter((c) => c.departmentId === deptId)
      .map((c) => ({ id: c.id, label: c.name, active: statusByClass[c.id] ?? false }));
  const gradesOf = (deptId: string | null) => grades.filter((g) => g.departmentId === deptId);
  const out: DrawerDept[] = [];
  if (departments.length > 0) {
    for (const d of departments) {
      const classes = [...toClasses(gradesOf(d.id)), ...toOtherRows(d.id)];
      // 実機モニタが配下に無い学科はドロワーにも出さない（壁の visibleDepartments と一致）。
      if (!classes.some((c) => monitorClassIds.has(c.id))) {
        continue;
      }
      out.push({
        id: d.id,
        name: d.name,
        broadcastHref: `/app/editor/scope/department/${d.id}`,
        // 学科配下の通常クラス + 同学科の「その他」を 1 グループに（壁の学科セクションと同じ並び）。
        classes,
      });
    }
    const orphan = toClasses(grades.filter((g) => !g.departmentId));
    if (orphan.length > 0) {
      out.push({ id: null, name: null, broadcastHref: null, classes: orphan });
    }
    // 学校直下の「その他」(department_id NULL) は独立した「その他」グループに。
    const schoolOthers = toOtherRows(null);
    if (schoolOthers.length > 0) {
      out.push({ id: "__other__", name: "その他", broadcastHref: null, classes: schoolOthers });
    }
  } else {
    // 学科が無い学校: 学科未割当の単一グループにまとめる（まとめ出し導線は学校全体側で担う）。
    // 「その他」は全て学校直下なのでここに続けて並べる（ラベルは名前のみ）。
    out.push({
      id: null,
      name: null,
      broadcastHref: null,
      classes: [...toClasses(grades), ...toOtherRows(null)],
    });
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
// 学科配下「その他」グループ: 学年モニタの下に少し間隔を空けて並べる。
const otherGroupStyle: React.CSSProperties = { marginTop: "1rem" };
// 学科配下「その他」の小見出し（学科見出しより一段小さく・控えめ）。
const otherSubTitleStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: color.muted,
  margin: "0 0 0.5rem",
};
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
