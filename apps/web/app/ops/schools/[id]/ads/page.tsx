import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getSchoolHierarchy } from "@/lib/school-admin/hub-queries";
import { listSchoolClassesForAdPlacement } from "@/lib/system-admin/ad-placement-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchoolDetail } from "@kimiterrace/db";
import { EmptyState } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * F10 / #46: **system_admin（運営）の広告掲載先ピッカー** (`/ops/schools/{id}/ads`)。**Server Component**。
 *
 * 運営が広告（広告主の素材）を表示する**掲載先スコープを選ぶ**画面。`ads.scope` は school / department / grade /
 * class を許容し、上位（学校 / 学科 / 学年）に掲載した広告は `effective_ads_per_class` VIEW で配下の全クラスに継承
 * 表示される（= 「一括掲載」の実体：親スコープ 1 件で配下全クラスへ）。本ページは 4 スコープの入口を出し分ける:
 *
 * - **学校全体** → `ads/scope/school`（配下の全クラスへ継承）
 * - **学科ごと**（学科制のみ） → `ads/scope/department/{id}`（当該学科配下へ継承）
 * - **学年ごと** → `ads/scope/grade/{id}`（当該学年配下の全クラスへ継承）
 * - **クラスごと** → `ads/{classId}`（そのクラスだけに掲載、従来導線）
 *
 * 旧実装はクラス単位のみ（`ClassPickerPage` へ委譲）で、上位スコープは「今後対応」と案内していた。本改修で
 * school_admin 側 (`/app/editor/scope/...`) と同等の一括掲載を運営導線にも開放する。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`（system_admin のみ）。
 * **対象校スコープ (ADR-019 §#95)**: 階層 (`getSchoolHierarchy`) は `withSession(..., { tenantScoped: true, schoolId })`
 * の**対象校 RLS tx** で取得する（system_admin の全校可視 policy を止め他校の学科/学年を混ぜない）。校名・存在確認は
 * 全校読取の `getSchoolDetail`、不正 / 不存在 id は 404。
 */
export default async function SchoolAdPlacementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }

  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 掲載先の候補 (学科 / 学年 / クラス) は対象校に降格スコープした tx で取得する (他校は不可視)。
  // getSchoolHierarchy は RLS 依存 (手書き WHERE school_id なし) なので必ず tenantScoped tx 内で呼ぶ。
  const { hierarchy, classList } = await withSession(
    async (tx) => {
      const tree = await getSchoolHierarchy(tx);
      const classes = await listSchoolClassesForAdPlacement(tx, school.id);
      return { hierarchy: tree, classList: classes };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  const isDepartmentMode = school.hierarchyMode === "department";
  const deptNameById = new Map(hierarchy.departments.map((d) => [d.id, d.name]));
  const base = `/ops/schools/${school.id}/ads`;

  return (
    <div style={pageStyle}>
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: school.name, href: `/ops/schools/${school.id}` },
          { label: "広告掲載" },
        ]}
      />
      <header>
        <h1 style={titleStyle}>{school.name} の広告掲載</h1>
        <p style={subtitleStyle}>
          広告を表示する範囲を選び、素材（メディアURL）・タップ時のリンク・表示秒数を設定します。
          上位（学校 / 学科 /
          学年）に掲載した広告は、配下の全クラスのサイネージに継承表示されます（一括掲載）。
          特定のクラスだけに出したい広告はクラス単位で設定します。
        </p>
      </header>

      {/* 学校全体 (一括掲載: 配下の全クラスへ継承) */}
      <Section
        title="学校全体に掲載"
        note="この学校のすべてのクラスのサイネージに継承表示されます。"
      >
        <ul style={listStyle}>
          <PickerRow primary="学校全体" href={`${base}/scope/school`} linkLabel="広告管理 →" />
        </ul>
      </Section>

      {/* 学科ごと (学科制のみ。配下の学年/クラスへ継承) */}
      {hierarchy.departments.length > 0 ? (
        <Section title="学科ごとに掲載" note="選んだ学科の配下（学年・クラス）に継承表示されます。">
          <ul style={listStyle}>
            {hierarchy.departments.map((d) => (
              <PickerRow
                key={d.id}
                primary={d.name}
                href={`${base}/scope/department/${d.id}`}
                linkLabel="広告管理 →"
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {/* 学年ごと (配下の全クラスへ継承) */}
      {hierarchy.grades.length > 0 ? (
        <Section title="学年ごとに掲載" note="選んだ学年の配下の全クラスに継承表示されます。">
          <ul style={listStyle}>
            {hierarchy.grades.map((g) => {
              // 学科制では同名の学年 (「1年」) が学科ごとに存在しうるため、学科名を副表記で区別する。
              const deptMeta =
                isDepartmentMode && g.departmentId ? (deptNameById.get(g.departmentId) ?? "") : "";
              return (
                <PickerRow
                  key={g.id}
                  primary={g.name}
                  meta={deptMeta}
                  href={`${base}/scope/grade/${g.id}`}
                  linkLabel="広告管理 →"
                />
              );
            })}
          </ul>
        </Section>
      ) : null}

      {/* クラスごと (そのクラスだけに掲載。従来導線) */}
      <Section
        title="クラスごとに掲載"
        note="選んだクラスのサイネージだけに表示されます（継承した上位の広告に追加されます）。"
      >
        {classList.length === 0 ? (
          <EmptyState
            title="クラスがありません"
            description={
              <>
                先に
                <Link href={`/ops/schools/${school.id}/hierarchy`} style={{ color: "#1d4ed8" }}>
                  {" "}
                  クラス設定{" "}
                </Link>
                でクラスを登録してください。
              </>
            }
          />
        ) : (
          <ul style={listStyle}>
            {classList.map((c) => {
              // 学科制では「電子工学科 1年」を主表記にし組は出さない (BUG-3、ClassPickerPage と同方針)。
              const primary = isDepartmentMode
                ? [c.departmentName, c.gradeName].filter(Boolean).join(" ") || c.className
                : c.className;
              const meta = isDepartmentMode ? "" : c.gradeName;
              return (
                <PickerRow
                  key={c.classId}
                  primary={primary}
                  meta={meta}
                  href={`${base}/${c.classId}`}
                  linkLabel="広告管理 →"
                />
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** 掲載先グループの見出し + 補足 + 中身をまとめるセクション。 */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div>
        <h2 style={sectionTitleStyle}>{title}</h2>
        <p style={sectionNoteStyle}>{note}</p>
      </div>
      {children}
    </section>
  );
}

/** 掲載先 1 行（主表記 + 任意の副表記 + 管理リンク）。ClassPickerPage の行と同じ見た目。 */
function PickerRow({
  primary,
  meta,
  href,
  linkLabel,
}: {
  primary: string;
  meta?: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <li style={itemStyle}>
      <span>
        <strong>{primary}</strong>
        {meta ? <span style={metaStyle}>{meta}</span> : null}
      </span>
      <Link href={href} style={manageLinkStyle}>
        {linkLabel}
      </Link>
    </li>
  );
}

const pageStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1.25rem" };
const titleStyle: React.CSSProperties = {
  fontSize: "1.4rem",
  fontWeight: 700,
  margin: "0 0 0.25rem",
};
const subtitleStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.9rem",
  margin: 0,
  lineHeight: 1.7,
};
const sectionTitleStyle: React.CSSProperties = { fontSize: "1.05rem", fontWeight: 700, margin: 0 };
const sectionNoteStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.82rem",
  margin: "0.15rem 0 0",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};
const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.6rem 0.9rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#fff",
};
const metaStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginLeft: "0.6rem",
};
const manageLinkStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  color: "#1d4ed8",
  whiteSpace: "nowrap",
};
