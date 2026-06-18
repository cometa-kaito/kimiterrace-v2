import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { KimiterraceDb, TenantTx } from "../client.js";
import { auditLog } from "../schema/audit-log.js";
import { classes } from "../schema/classes.js";
import { magicLinks } from "../schema/magic-links.js";

/**
 * magic link 操作の実行者。
 *
 * - **school_admin**: `userId` は `users.id`（FK 列 created_by/updated_by/actor_user_id に載る）。
 * - **system_admin**: `users` 行ではなく `system_admins` 行のため、FK を持つ列には入れられず `userId=null`。
 *   FK の無い `actor_identity_uid` に IdP uid（`identityUid`）を載せ「誰が」を audit_log 上で追跡可能にする
 *   （system-admin 監査 actor の作法。config-edit / schools-actions と同型。ルール1）。
 */
export type MagicLinkActor = { userId: string | null; identityUid: string };

/**
 * magic_links の発行/失効/延長を audit_log に追記する (NFR04 / CLAUDE.md ルール1)。
 *
 * magic link は生徒の匿名アクセス credential であり、「誰がいつ発行/失効したか」は漏洩時に
 * 最も追跡したい情報。`prev_hash`/`row_hash` は BEFORE INSERT トリガ (migration 0003) が
 * 計算するため渡さない。`actor_user_id` は audit_log_insert policy が「自分自身 / system_admin / null」を
 * 許可する（system_admin context では null actor + 任意 school_id が通る）。FK 列に載せられない system_admin
 * は `actor_identity_uid` で追跡する。**token_hash や平文 token は diff に含めない** (ルール5)。
 */
async function writeMagicLinkAudit(
  tx: TenantTx,
  actor: MagicLinkActor & { schoolId: string },
  params: { recordId: string; operation: "insert" | "update"; diff: object },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: "magic_links",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/**
 * F05: クラス magic link のドメインサービス。
 *
 * 2 系統に分かれる:
 *   1. **生徒匿名アクセス側** (`resolveMagicLink`): テナントコンテキスト確立前に走る。
 *      RLS をくぐる唯一の扉である SECURITY DEFINER 関数 `resolve_magic_link`
 *      (migration 0008) を呼ぶ。呼び出し側は RLS context 不要 (= 任意の kimiterrace_app
 *      接続でよい) で、有効なクラスリンクのみが 0/1 行で返る。
 *   2. **教員管理側** (`createClassMagicLink` / `revokeMagicLink` / `listClassMagicLinks`):
 *      RLS context を張ったトランザクション (`TenantTx`) で呼ぶ前提。tenant_isolation で
 *      自校のリンクのみ INSERT/UPDATE/SELECT できる。
 *
 * token 平文は **この層には渡さない**。呼び出し側 (apps/web) が SHA-256 等でハッシュ化した
 * `tokenHash` のみを受け渡す (CLAUDE.md ルール5: 平文 token をコード・DB・ログに残さない)。
 */

/** 匿名解決の結果。token 保持者が知ってよい最小情報のみ。 */
export type ResolvedMagicLink = {
  id: string;
  schoolId: string;
  classId: string;
};

/**
 * 生徒の `/s/{token}` 到達時に、token (ハッシュ済) を school_id / class_id に解決する。
 *
 * SECURITY DEFINER 関数経由なので RLS コンテキスト不要。返るのは **有効な** (失効しておらず
 * 期限内の) **クラスリンクのみ**。該当なし (不正/失効/期限切れ token) は `null` を返すので、
 * 呼び出し側はこれを 410 Gone / 404 にマップする (F05: 失効後アクセスは 410 Gone)。
 *
 * @param db        kimiterrace_app ロールの接続 (RLS context は不要)
 * @param tokenHash クライアントが提示した token のハッシュ値
 */
export async function resolveMagicLink(
  db: Pick<KimiterraceDb, "execute">,
  tokenHash: string,
): Promise<ResolvedMagicLink | null> {
  const rows = (await db.execute(
    sql`SELECT id, school_id, class_id FROM resolve_magic_link(${tokenHash})`,
  )) as unknown as Array<{ id: string; school_id: string; class_id: string }>;
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, schoolId: row.school_id, classId: row.class_id };
}

/** 新規クラスリンク発行のパラメータ。 */
export type CreateClassMagicLinkParams = {
  /**
   * 発行先クラスの学校。school_admin は自校 id、**system_admin は発行対象クラスから解決した学校 id**
   * （cross-tenant。`getVisibleClassSchoolId` で取得）。INSERT は magic_links の `system_admin_full_access`
   * もしくは `tenant_isolation` WITH CHECK のいずれかで通る。
   */
  schoolId: string;
  classId: string;
  /** ハッシュ済 token。resolve はこの hash 参照のまま。 */
  tokenHash: string;
  /**
   * ADR-042 D2: 再表示用の**平文トークン**。`magic_links.token` 列に保存し、後から完全な URL を
   * 再表示できるようにする（system_admin + 自校 school_admin が RLS スコープで `listClassMagicLinks`
   * 経由で読む）。**監査 diff・ログには載せない**（保存は列のみ・ルール5 の規律はログ/diff に維持）。
   * 省略時は NULL（旧経路・後方互換）で、その行は再表示不可。
   */
  token?: string;
  /**
   * ADR-042 D1: **未指定 = NULL（無期限・永続リンク）を明示的に書く**。発行 API は既定で未指定とし
   * 無期限で発行する。明示指定時のみ従来どおり有限期限（後方互換。発行者 UI の短縮/延長や明示 days）。
   * 旧来の「省略時 DB 列デフォルト 90 日に倒れる」挙動は採らない（NULL を明示 INSERT する）。
   */
  expiresAt?: Date;
  /** 発行者（監査カラム created_by/updated_by + audit_log actor）。system_admin は userId=null。 */
  actor: MagicLinkActor;
};

/**
 * 発行されたクラスリンクの公開可能な属性 (`token_hash` は返さない)。
 *
 * ADR-042 D2: 再表示用の平文 `token` を含む。PR2 以前に発行された行（`token` 列が NULL）は再表示不可なので
 * `null`。呼び出し側（運用者の RLS スコープ＝system_admin / 自校 school_admin）は token があれば完全な URL を
 * 再構築できる。`token` を含むのはこの管理側 (`createClassMagicLink` / `listClassMagicLink`) のみで、生徒匿名
 * 解決 (`resolveMagicLink`) には含めない。
 */
export type IssuedMagicLink = {
  id: string;
  classId: string | null;
  /** ADR-042 D2: 再表示用の平文トークン。NULL = 旧リンク（PR2 以前発行）で再表示不可。 */
  token: string | null;
  /** ADR-042 D1: NULL = 無期限（永続リンク）。期限つきリンクは従来どおり Date。 */
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const ISSUED_COLUMNS = {
  id: magicLinks.id,
  classId: magicLinks.classId,
  token: magicLinks.token,
  expiresAt: magicLinks.expiresAt,
  revokedAt: magicLinks.revokedAt,
  createdAt: magicLinks.createdAt,
} as const;

/** `class_id` が現在のテナントのクラスを指していないときに投げる。 */
export class MagicLinkClassNotFoundError extends Error {
  constructor(classId: string) {
    super(`magic link 発行: クラス ${classId} は自校に存在しません`);
    this.name = "MagicLinkClassNotFoundError";
  }
}

/**
 * `classId` が現在の RLS コンテキスト (自校) のクラスかを判定する。
 * RLS の tenant_isolation により、他校のクラスは SELECT で 0 行 = false になる。
 */
export async function classBelongsToTenant(tx: TenantTx, classId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: classes.id })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  return Boolean(row);
}

/**
 * 可視クラスの `school_id` を返す（別テナント / 不存在は null）。**system_admin が発行対象クラスの学校を
 * cross-tenant に解決**するのに使う（`system_admin_full_access` 下では全校のクラスが可視、自校 RLS 下では
 * 自校のクラスのみ）。解決した school_id を `createClassMagicLink` の `schoolId` に渡すことで、system_admin
 * でも当該クラスの正しい学校に紐づく magic_links 行を INSERT できる。
 */
export async function getVisibleClassSchoolId(
  tx: TenantTx,
  classId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ schoolId: classes.schoolId })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  return row?.schoolId ?? null;
}

/**
 * 教員がクラスに magic link を発行する。RLS context (自校) を張った tx 内で呼ぶ。
 *
 * 二層の防御:
 * - `school_id` は tenant_isolation の WITH CHECK が `app.current_school_id` を強制し、他校
 *   school_id を渡しても INSERT が拒否される。
 * - `class_id` は school_id と独立な FK のため、自校 school_id + **他校 class_id** という
 *   ねじれた行を作れてしまう (RLS は school_id しか見ない)。データ漏洩には至らない (生徒側で
 *   下層 content が別校になり RLS で 0 件) が、壊れたリンクを生む。これを防ぐため発行前に
 *   `classBelongsToTenant` で自校クラスであることを検証し、違えば例外で倒す。
 */
export async function createClassMagicLink(
  tx: TenantTx,
  params: CreateClassMagicLinkParams,
): Promise<IssuedMagicLink> {
  if (!(await classBelongsToTenant(tx, params.classId))) {
    throw new MagicLinkClassNotFoundError(params.classId);
  }
  const [row] = await tx
    .insert(magicLinks)
    .values({
      schoolId: params.schoolId,
      classId: params.classId,
      tokenHash: params.tokenHash,
      // ADR-042 D2: 再表示用の平文 token を列に保存（省略時は NULL = 旧リンク扱いで再表示不可）。
      token: params.token ?? null,
      // ADR-042 D1: 未指定 = NULL（無期限）を**明示的に書く**。DB 列デフォルト(90 日)には倒さない。
      expiresAt: params.expiresAt ?? null,
      createdBy: params.actor.userId,
      updatedBy: params.actor.userId,
    })
    .returning(ISSUED_COLUMNS);
  if (!row) {
    // INSERT が 0 行を返すのは RLS WITH CHECK 違反等。呼び出し側に明示エラーを返す。
    throw new Error("createClassMagicLink: INSERT が行を返しませんでした (RLS 拒否の可能性)");
  }
  await writeMagicLinkAudit(
    tx,
    { ...params.actor, schoolId: params.schoolId },
    {
      recordId: row.id,
      operation: "insert",
      // token/hash は載せない (ルール5)。発行された事実とメタのみ。
      // ADR-042: expiresAt は NULL = 無期限のため null 安全化する。
      diff: { classId: row.classId, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null },
    },
  );
  return row;
}

/**
 * クラスリンクを失効させる (F05: 漏洩検知時の即時失効)。既に失効済の場合は冪等
 * (revoked_at は最初の失効時刻を保持し上書きしない)。自校のリンクのみ更新できる (RLS)。
 *
 * @returns 失効した行 (見つからない/他校なら undefined)
 */
export async function revokeMagicLink(
  tx: TenantTx,
  id: string,
  actor: MagicLinkActor,
): Promise<IssuedMagicLink | undefined> {
  const [row] = await tx
    .update(magicLinks)
    .set({ revokedAt: sql`now()`, updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(and(eq(magicLinks.id, id), isNull(magicLinks.revokedAt)))
    // schoolId は audit 記録に使うため内部的に取得する (公開戻り値には含めない)。
    .returning({ ...ISSUED_COLUMNS, schoolId: magicLinks.schoolId });
  if (!row) {
    return undefined;
  }
  await writeMagicLinkAudit(
    tx,
    { ...actor, schoolId: row.schoolId },
    {
      recordId: row.id,
      operation: "update",
      diff: { revokedAt: row.revokedAt?.toISOString() ?? null },
    },
  );
  const { schoolId: _schoolId, ...issued } = row;
  return issued;
}

/**
 * クラスリンクの有効期限を更新する (F05: 教員 UI からの短縮/延長)。`newExpiresAt` は
 * 呼び出し側 (apps/web) が **サーバ時刻 `new Date()` を起点に** 算出した値を渡す前提
 * (発行 API と同思想で client 時刻を信用しない)。
 *
 * - **失効済リンクは更新不可** (`revoked_at IS NULL` 条件)。失効は不可逆 (再有効化は新規発行)。
 * - **期限切れ (未失効) リンクは再有効化できる**: `resolve_magic_link` は期限切れを 410 にする
 *   だけで、新しい未来の期限を張れば再び解決可能になる (新学期の再利用)。
 * - 自校のリンクのみ更新できる (RLS tenant_isolation)。他校/不存在は undefined。
 * - 監査 (ルール1): 更新前後の `expires_at` を before/after で `audit_log` に残す。token は載せない。
 *
 * @returns 更新後の行 (見つからない/失効済/他校なら undefined)
 */
export async function extendMagicLink(
  tx: TenantTx,
  id: string,
  newExpiresAt: Date,
  actor: MagicLinkActor,
): Promise<IssuedMagicLink | undefined> {
  // 監査の before 値 (旧期限) を取るため更新前に読む。同一 tx・同一 WHERE で直後に UPDATE するため
  // 取り違えは起きない (単一テナント seam、UPDATE も revoked_at IS NULL を再評価)。
  const [before] = await tx
    .select({ expiresAt: magicLinks.expiresAt, schoolId: magicLinks.schoolId })
    .from(magicLinks)
    .where(and(eq(magicLinks.id, id), isNull(magicLinks.revokedAt)));
  if (!before) {
    return undefined;
  }
  const [row] = await tx
    .update(magicLinks)
    // expiresAt は drizzle ORM 経由で Date を bind (createClassMagicLink と同方式、
    // raw sql の timestamptz Date-bind 罠を踏まない)。updatedAt は DB now() で監査整合。
    .set({ expiresAt: newExpiresAt, updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(and(eq(magicLinks.id, id), isNull(magicLinks.revokedAt)))
    .returning(ISSUED_COLUMNS);
  if (!row) {
    return undefined;
  }
  await writeMagicLinkAudit(
    tx,
    { ...actor, schoolId: before.schoolId },
    {
      recordId: row.id,
      operation: "update",
      diff: {
        // ADR-042: expiresAt は NULL = 無期限のため null 安全化する。
        expiresAt: {
          before: before.expiresAt ? before.expiresAt.toISOString() : null,
          after: row.expiresAt ? row.expiresAt.toISOString() : null,
        },
      },
    },
  );
  return row;
}

/**
 * 教員 UI 用: クラスのリンク一覧を新しい順に返す。RLS で自校のみ。
 *
 * 既定は **有効なリンクのみ** (失効済を除く)。`includeRevoked` を渡すと失効済も含めて返す
 * (F05: 漏洩失効フローの監査透明性 — 教員が「どのリンクをいつ失効したか」を確認できる)。
 * 失効済かどうかは戻り値の `revokedAt` (非 null = 失効済) で判別する。
 *
 * ADR-042 D2: 返却に**平文 `token`**（再表示用）を含む。本クエリは RLS の tenant_isolation 下で**自校の
 * リンクのみ**返すため、平文 token を読めるのは system_admin（全校）/ school_admin（自校）に限られる
 * （ADR-042 の再表示可の対象に一致）。PR2 以前発行の行は `token` が NULL で再表示不可。
 */
export async function listClassMagicLinks(
  tx: TenantTx,
  classId: string,
  options?: { includeRevoked?: boolean },
): Promise<IssuedMagicLink[]> {
  const where = options?.includeRevoked
    ? eq(magicLinks.classId, classId)
    : and(eq(magicLinks.classId, classId), isNull(magicLinks.revokedAt));
  return tx
    .select(ISSUED_COLUMNS)
    .from(magicLinks)
    .where(where)
    .orderBy(desc(magicLinks.createdAt));
}
