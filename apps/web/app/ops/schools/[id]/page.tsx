import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import {
  type SchoolTree,
  type TreeClass,
  type TreeDepartment,
  type TreeDevice,
  type TreeGrade,
  getSchoolTree,
} from "@/lib/system-admin/school-tree";
import { TV_STATUS_ICON, TV_STATUS_LABEL, classifyTvLiveness } from "@/lib/tv/status";
import { getSchoolDetail } from "@kimiterrace/db";
import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SchoolDeleteButton } from "./_components/SchoolDeleteButton";

const { color } = tokens;

/** 階層モードの表示ラベル。enum 値を網羅 (型でズレ検出、ルール3、一覧ページと同方針)。 */
const HIERARCHY_MODE_LABEL: Record<SchoolHierarchyMode, string> = {
  class: "クラス制",
  department: "学科制",
};

/**
 * #48-L2 (#123) / 運営整理 §4 item3: システム管理者の学校詳細 (`/ops/schools/{id}`)。**Server Component**。
 *
 * マスタ情報に加え、配下を **学科 → 学年 → クラス → 設置場所 → モニタ** の**階層ツリー**で展開する
 * (`getSchoolTree`)。数字サマリ (件数カード) で止めず、運営がどこにモニタが設置済 / 未設置かを構造で把握できる
 * ようにする。物理最小単位はモニタ = `tv_devices` 1 行で、その `label` が設置場所を表す (統合マスター §0b)。
 * モニタの稼働状態は `last_seen_at` 鮮度から判定 (`classifyTvLiveness`、TV 一覧と同一ロジック)、行から
 * 端末設定 (`/ops/tv-devices/{id}/edit`) へ遷移できる。
 *
 * **認可**: `/admin` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。school_admin / teacher は 403。可視範囲は schools / 配下テーブルの RLS が決め
 * (system_admin=全校)、不可視 / 不存在 / 不正 id は 404。秘匿値 (device_id・MAC 等) はツリーに出さない (ルール4)。
 */
export default async function SystemSchoolDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school, counts } = detail;
  const tree = await withSession((tx) => getSchoolTree(tx, school.id));
  // 稼働判定の基準時刻はリクエスト時の 1 点に固定する (ツリー全体で一貫させる)。
  const now = new Date();

  return (
    <article style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <Breadcrumb items={[{ label: "学校一覧", href: "/ops/schools" }, { label: school.name }]} />

      {/* タイトル行: マスタ編集（この学校の属性）のみ。破壊（削除）は誤操作耐性のためページ末尾の
          危険ゾーンへ分離する（旧: 8 操作を1列フラットに並べ、削除が編集の直後に隣接していた）。 */}
      <div className="kt-page-head">
        <h1 className="kt-page-title">{school.name}</h1>
        <div className="kt-actions">
          <Link href={`/ops/schools/${school.id}/edit`} className="kt-action">
            編集
          </Link>
        </div>
      </div>

      {/* 操作ゾーン: この学校を対象にした運用操作（頻用）を、マスタ編集/破壊から「地の差」で分離した
          帯にまとめる（橙アクセント罫 + 見出し）。個々は二次トーンの chip（アクション言語の単一ソース）。 */}
      <section className="kt-opzone" aria-label={`${school.name} の操作`}>
        <p className="kt-opzone__label">この学校で操作</p>
        <div className="kt-actions">
          {/* エディタ導線 (C2): 運営がこの学校のクラスを選び、予定 / 連絡 / 提出物 (daily_data) を編集する。 */}
          <Link href={`/ops/schools/${school.id}/editor`} className="kt-action">
            エディタ
          </Link>
          {/* クラス設定導線: 運営がこの学校の学科 / 学年 / クラス階層を編集する (対象校スコープ、監査記録)。 */}
          <Link href={`/ops/schools/${school.id}/hierarchy`} className="kt-action">
            クラス設定
          </Link>
          {/* 広告掲載導線 (#46): 運営がこの学校のクラスを選び、クラス別広告管理で素材/リンク/秒数を設定する。 */}
          <Link href={`/ops/schools/${school.id}/ads`} className="kt-action">
            広告掲載
          </Link>
          {/* 静粛時間導線 (#1002 対称): 運営がこの学校のクラスを選び、サイネージ静音/非表示の時間帯を設定する。 */}
          <Link href={`/ops/schools/${school.id}/quiet-hours`} className="kt-action">
            静粛時間
          </Link>
          {/* 生徒アクセスリンク導線 (F05): 運営がこの学校のクラスを選び、magic link を発行/失効する。 */}
          <Link href={`/ops/schools/${school.id}/magic-link`} className="kt-action">
            生徒アクセスリンク
          </Link>
          {/* 来場検知センサー導線 (ADR-041 D3): 運営がこの学校のセンサーを登録/編集する (対象校スコープ、監査記録)。 */}
          <Link href={`/ops/schools/${school.id}/sensors`} className="kt-action">
            センサー
          </Link>
        </div>
      </section>

      <dl style={dlStyle}>
        <Field label="都道府県" value={school.prefecture} />
        <Field label="学校コード" value={school.code ?? "—"} />
        <Field label="階層モード" value={HIERARCHY_MODE_LABEL[school.hierarchyMode]} />
        <Field label="備考" value={school.notes ?? "—"} />
        <Field label="登録日" value={formatJstDateTime(school.createdAt)} />
        <Field label="更新日" value={formatJstDateTime(school.updatedAt)} />
      </dl>

      <section>
        <h2 style={sectionTitleStyle}>階層</h2>
        <div style={countsRowStyle}>
          <CountCard label="学年" value={counts.grades} />
          {school.hierarchyMode === "department" ? (
            <CountCard label="学科" value={counts.departments} />
          ) : null}
          <CountCard label="クラス" value={counts.classes} />
        </div>
      </section>

      <section>
        <h2 style={sectionTitleStyle}>階層ツリー（学科 → 学年 → クラス → 設置場所・モニタ）</h2>
        <p style={treeNoteStyle}>
          設置場所はモニタのラベルで表します。モニタ行から端末設定を編集できます。
        </p>
        <SchoolTreeView tree={tree} now={now} />
      </section>

      {/* 危険ゾーン: 破壊操作（学校削除）を routine 動線（タイトル/操作ゾーン）から物理的に末尾へ隔離する。
          薄赤の danger サーフェスで「危険」を面として明示し、注意文と削除ボタンを近接させる。削除自体の
          認可・子データ保護・監査・テスト校ガード・校名タイプ確認は SchoolDeleteButton + Server Action + RLS。 */}
      <section className="kt-dangerzone" aria-label="危険な操作">
        <p className="kt-dangerzone__note">
          この学校と配下のクラス・モニタ紐付けを削除します。元に戻せません。
        </p>
        <SchoolDeleteButton schoolId={school.id} schoolName={school.name} />
      </section>
    </article>
  );
}

/** 学校階層ツリー本体。学科モードは学科 → 学年、クラスモードは学年直下から展開する。 */
function SchoolTreeView({ tree, now }: { tree: SchoolTree; now: Date }) {
  const isEmpty =
    tree.departments.length === 0 && tree.grades.length === 0 && tree.schoolDevices.length === 0;
  if (isEmpty) {
    return <p style={emptyStyle}>階層 (学年・学科・クラス) がまだ登録されていません。</p>;
  }
  return (
    <div style={treeStyle}>
      {tree.departments.map((d) => (
        <DepartmentNode key={d.id} dept={d} now={now} />
      ))}
      {tree.grades.map((g) => (
        <GradeNode key={g.id} grade={g} now={now} />
      ))}
      {tree.schoolDevices.length > 0 ? (
        <details style={nodeStyle}>
          <summary style={summaryStyle}>
            学校全体（設置場所）
            <span style={badgeCountStyle}>モニタ {tree.schoolDevices.length}</span>
          </summary>
          <DeviceList devices={tree.schoolDevices} now={now} />
        </details>
      ) : null}
    </div>
  );
}

function DepartmentNode({ dept, now }: { dept: TreeDepartment; now: Date }) {
  return (
    <details style={nodeStyle} open>
      <summary style={summaryStyle}>
        🏛 {dept.name}
        <span style={badgeCountStyle}>学年 {dept.grades.length}</span>
      </summary>
      <div style={childrenStyle}>
        {dept.grades.map((g) => (
          <GradeNode key={g.id} grade={g} now={now} />
        ))}
        {dept.devices.length > 0 ? (
          <DeviceList devices={dept.devices} now={now} caption="学科直下のモニタ" />
        ) : null}
        {dept.grades.length === 0 && dept.devices.length === 0 ? (
          <p style={emptyStyle}>この学科に学年がありません。</p>
        ) : null}
      </div>
    </details>
  );
}

function GradeNode({ grade, now }: { grade: TreeGrade; now: Date }) {
  return (
    <details style={nodeStyle}>
      <summary style={summaryStyle}>
        📚 {grade.name}
        <span style={badgeCountStyle}>クラス {grade.classes.length}</span>
      </summary>
      <div style={childrenStyle}>
        {grade.classes.map((c) => (
          <ClassNode key={c.id} cls={c} now={now} />
        ))}
        {grade.devices.length > 0 ? (
          <DeviceList devices={grade.devices} now={now} caption="学年直下のモニタ" />
        ) : null}
        {grade.classes.length === 0 && grade.devices.length === 0 ? (
          <p style={emptyStyle}>この学年にクラスがありません。</p>
        ) : null}
      </div>
    </details>
  );
}

function ClassNode({ cls, now }: { cls: TreeClass; now: Date }) {
  return (
    <div style={classRowStyle}>
      <div style={classHeadStyle}>
        <span>🏫 {cls.name}</span>
        <span style={badgeCountStyle}>モニタ {cls.devices.length}</span>
      </div>
      {cls.devices.length > 0 ? (
        <DeviceList devices={cls.devices} now={now} />
      ) : (
        <p style={emptyStyle}>モニタ未設置</p>
      )}
    </div>
  );
}

function DeviceList({
  devices,
  now,
  caption,
}: {
  devices: TreeDevice[];
  now: Date;
  caption?: string;
}) {
  return (
    <div style={deviceWrapStyle}>
      {caption ? <p style={deviceCaptionStyle}>{caption}</p> : null}
      <ul style={deviceListStyle}>
        {devices.map((d) => {
          const status = classifyTvLiveness(d.lastSeenAt, now);
          return (
            <li key={d.id} style={deviceItemStyle}>
              <span style={deviceLabelStyle}>📺 {d.label ?? "（ラベル未設定）"}</span>
              <span
                style={statusBadgeStyle}
                title={d.monitoringEnabled ? undefined : "死活監視オフ"}
              >
                {/* アイコンは色の補助、テキストラベルが本体 (NFR05: 色のみに依存しない)。 */}
                <span aria-hidden="true">{TV_STATUS_ICON[status]}</span> {TV_STATUS_LABEL[status]}
                {d.monitoringEnabled ? "" : "（監視オフ）"}
              </span>
              <Link href={`/ops/tv-devices/${d.id}/edit`} style={deviceLinkStyle}>
                端末設定
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={fieldStyle}>
      <dt style={dtStyle}>{label}</dt>
      <dd style={ddStyle}>{value}</dd>
    </div>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={cardStyle}>
      <div style={cardValueStyle}>{value}</div>
      <div style={cardLabelStyle}>{label}</div>
    </div>
  );
}

/** createdAt/updatedAt を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール固定)。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

const dlStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  gap: "0.5rem 1.5rem",
  margin: 0,
};
const fieldStyle: React.CSSProperties = { display: "contents" };
const dtStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem" };
const ddStyle: React.CSSProperties = { margin: 0, fontSize: "0.9rem", whiteSpace: "pre-wrap" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  marginBottom: "0.6rem",
};
const countsRowStyle: React.CSSProperties = { display: "flex", gap: "0.75rem" };
const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.75rem 1.25rem",
  textAlign: "center",
  minWidth: "5rem",
};
const cardValueStyle: React.CSSProperties = { fontSize: "1.5rem", fontWeight: 700 };
const cardLabelStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280" };
const treeNoteStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.8rem",
  margin: "0 0 0.6rem",
};
const treeStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "0.4rem" };
const nodeStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.4rem 0.75rem",
};
const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.92rem",
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};
const childrenStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  margin: "0.5rem 0 0.25rem 1rem",
  paddingLeft: "0.75rem",
  borderLeft: "2px solid #f3f4f6",
};
const classRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "0.35rem 0",
};
const classHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  fontSize: "0.9rem",
};
const badgeCountStyle: React.CSSProperties = { fontSize: "0.72rem", color: "#6b7280" };
const deviceWrapStyle: React.CSSProperties = { marginLeft: "1.25rem" };
const deviceCaptionStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: color.muted,
  margin: "0.25rem 0",
};
const deviceListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};
const deviceItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  fontSize: "0.85rem",
};
const deviceLabelStyle: React.CSSProperties = { color: "#374151" };
const statusBadgeStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  whiteSpace: "nowrap",
  color: "#374151",
};
// 端末設定リンクは AA 合格のブランド青（アクション言語と同色）に統一（旧 #1d4ed8 生hex → 単一ソース）。
const deviceLinkStyle: React.CSSProperties = { color: color.blueStrong, fontSize: "0.8rem" };
const emptyStyle: React.CSSProperties = {
  color: color.muted,
  fontSize: "0.82rem",
  margin: "0.25rem 0",
};
