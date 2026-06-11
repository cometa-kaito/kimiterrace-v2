import { type TenantTx, classes, memberships, schools, users } from "@kimiterrace/db";
import { type InferSelectModel, type SQL, and, asc, count, desc, eq, ilike } from "drizzle-orm";
import {
  type ListParams,
  escapeLike,
  pageWindow,
} from "@/app/admin/_components/datalist/list-params";
import { maskIdentifier } from "./mask";

/**
 * UIUX-03: memberships (ユーザー × クラス所属) **読み取り専用**ビューア
 * (`/admin/system/memberships`) の SELECT 層。`audit-log-list.ts` と同構造 (共通 DataList 基盤)。
 *
 * ## ⚠ memberships 管理 (mutation) はスコープ外
 * **memberships の管理 (作成/付替/削除 mutation) は Opus 検証後の後続スライス。本ビューは
 * 読み取り + マスクのみ** を提供する。所属の付替はテナント越境 (他校クラスへの結線) の
 * 整合性検証が必要で、横断 UI から安易に書かせない。
 *
 * ## PII (ルール4) — 表示名は必ずマスク
 * memberships は users (生徒含む) に結合する。生徒の表示名は PII のため、**本モジュールが
 * `maskIdentifier` (mask.ts) でマスクしてから返し、生の displayName / userId を呼出側 (ページ) に
 * 一切渡さない** (表示層に生 PII を持ち込まない多層防御)。突合用に userId もマスク済み
 * (両端のみ) で返す。email 等その他の users 列は射影しない。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く。テーブルは barrel から import し、
 * 行型は schema 由来 (`InferSelectModel`、ルール3)。
 *
 * ## テナント分離 (ルール2 / ADR-019)
 * memberships は tenant_isolation + system_admin_full_access policy (migration 0002) が守る。
 * WHERE に school_id / role を**テナント境界としては書かない** — 可視範囲は呼出側 (`withSession`)
 * が張る RLS context が決める (system_admin=全校)。`filters.school` は検索条件であって境界ではない。
 *
 * ## 閲覧監査 (NFR04 / ルール1)
 * 呼び出し側 (ページ) は表示のたびに `writeViewAccessAudit` (subject: "memberships_view_access")
 * をデータ取得と同一 tx で記録すること (events / ai_chat ビューアと同じ規律)。
 */

type Selectable = Pick<TenantTx, "select" | "selectDistinct">;

/** ソート可能列の allowlist (仕様: 学校 / クラス)。sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const MEMBERSHIP_SORT_COLUMNS = {
  schoolName: schools.name,
  className: classes.name,
} as const;

export const MEMBERSHIP_SORT_KEYS = Object.keys(MEMBERSHIP_SORT_COLUMNS) as readonly string[];

/**
 * membership_role の既知値 → 表示ラベル。列は varchar (柔軟運用、schema コメント参照) のため
 * enum 網羅ではなく、未知値はページ側で生値 fallback 表示する。
 */
export const MEMBERSHIP_ROLE_LABEL: Record<string, string> = {
  student: "生徒",
  homeroom_teacher: "担任",
  sub_teacher: "副担任",
};

type MembershipRow = InferSelectModel<typeof memberships>;

/**
 * 一覧 1 行。schema 由来の射影 + JOIN した学校/クラス名。**生の displayName / userId は含まない**
 * (マスク済みのみ、モジュール doc「PII」参照)。
 */
export type MembershipListEntry = Pick<
  MembershipRow,
  "id" | "schoolId" | "classId" | "membershipRole" | "createdAt"
> & {
  schoolName: string;
  className: string;
  academicYear: number;
  /** maskIdentifier 済みの表示名 (例: "田中••")。生 PII は本モジュール外に出さない。 */
  userDisplayMasked: string;
  /** maskIdentifier 済みの user uuid (両端のみ)。同名マスクの突合用。 */
  userIdMasked: string;
};

/** 一覧 1 ページ分 + 総件数。 */
export type MembershipListPage = { rows: MembershipListEntry[]; total: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `filters.school` を uuid として検証する。非該当はフィルタなし (null)。形式検証であって
 * **テナント境界ではない** — 境界は RLS が DB レベルで守る (ルール2、event-log.ts と同パターン)。
 */
export function parseSchoolFilter(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

/**
 * memberships を users / classes / schools に join して一覧する (すべて notNull FK の innerJoin で
 * 件数を変えない)。検索 (q) は**クラス名のみ** (仕様) — 表示名は生徒 PII のため検索対象にしない
 * (マスク表示と整合。氏名からの特定が必要な調査は DB 直接アクセス + 別途監査の領分)。
 * role フィルタは完全一致 (パラメタライズ済で任意文字列でも安全 — 実在しない値は 0 件に倒れる)。
 * 同値ソートでも順序が安定するよう 学校 → クラス → id をタイブレークに付ける。
 */
export async function listMembershipPage(
  db: Selectable,
  params: ListParams,
): Promise<MembershipListPage> {
  const conditions: SQL[] = [];
  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    conditions.push(ilike(classes.name, pattern));
  }
  // 検索条件としての学校絞り込み (テナント境界は RLS、parseSchoolFilter の doc 参照)。
  const school = parseSchoolFilter(params.filters.school);
  if (school) {
    conditions.push(eq(memberships.schoolId, school));
  }
  const role = params.filters.role;
  if (role) {
    conditions.push(eq(memberships.membershipRole, role));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    MEMBERSHIP_SORT_COLUMNS[params.sort as keyof typeof MEMBERSHIP_SORT_COLUMNS] ?? schools.name;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(schools.name), asc(classes.name), asc(memberships.id)]
      : [desc(sortColumn), asc(schools.name), asc(classes.name), asc(memberships.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: memberships.id,
        schoolId: memberships.schoolId,
        schoolName: schools.name,
        classId: memberships.classId,
        className: classes.name,
        academicYear: classes.academicYear,
        membershipRole: memberships.membershipRole,
        displayName: users.displayName,
        userId: memberships.userId,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(schools, eq(memberships.schoolId, schools.id))
      .innerJoin(classes, eq(memberships.classId, classes.id))
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    // count にも一覧と同じ JOIN を張る (q が classes.name を参照するため)。innerJoin はすべて
    // notNull FK + PK 結合で行数を変えないため、件数は memberships 自体の件数と一致する。
    db
      .select({ value: count() })
      .from(memberships)
      .innerJoin(schools, eq(memberships.schoolId, schools.id))
      .innerJoin(classes, eq(memberships.classId, classes.id))
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(where),
  ]);

  return {
    // 生の displayName / userId はここで落とし、マスク済みのみ返す (モジュール doc「PII」)。
    rows: rows.map(({ displayName, userId, ...rest }) => ({
      ...rest,
      userDisplayMasked: maskIdentifier(displayName),
      userIdMasked: maskIdentifier(userId),
    })),
    total: totals[0]?.value ?? 0,
  };
}

/**
 * role フィルタの選択肢用に、memberships に**実在する** membership_role を distinct で返す
 * (audit-log-list の `listAuditLogTableNames` と同パターン。varchar 柔軟運用のため静的配列より
 * 実在値が正確)。値域は高々数値オーダー (ページング不要)。
 */
export async function listMembershipRoles(db: Selectable): Promise<string[]> {
  const rows = await db
    .selectDistinct({ role: memberships.membershipRole })
    .from(memberships)
    .orderBy(asc(memberships.membershipRole));
  return rows.map((r) => r.role);
}
