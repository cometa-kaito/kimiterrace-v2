import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { KimiterraceDb, TenantTx } from "../client.js";
import { magicLinks } from "../schema/magic-links.js";

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
  schoolId: string;
  classId: string;
  /** ハッシュ済 token。平文は渡さない。 */
  tokenHash: string;
  /** 省略時は DB デフォルト (now() + 90 日)。教員 UI が短縮/延長する場合のみ指定。 */
  expiresAt?: Date;
  /** 発行者 (監査カラム created_by/updated_by)。 */
  actorUserId: string;
};

/** 発行されたクラスリンクの公開可能な属性 (token_hash は返さない)。 */
export type IssuedMagicLink = {
  id: string;
  classId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

const ISSUED_COLUMNS = {
  id: magicLinks.id,
  classId: magicLinks.classId,
  expiresAt: magicLinks.expiresAt,
  revokedAt: magicLinks.revokedAt,
  createdAt: magicLinks.createdAt,
} as const;

/**
 * 教員がクラスに magic link を発行する。RLS context (自校) を張った tx 内で呼ぶ。
 * tenant_isolation の WITH CHECK が `school_id = app.current_school_id` を強制するため、
 * 他校 school_id を渡しても INSERT は拒否される。
 */
export async function createClassMagicLink(
  tx: TenantTx,
  params: CreateClassMagicLinkParams,
): Promise<IssuedMagicLink> {
  const [row] = await tx
    .insert(magicLinks)
    .values({
      schoolId: params.schoolId,
      classId: params.classId,
      tokenHash: params.tokenHash,
      ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
      createdBy: params.actorUserId,
      updatedBy: params.actorUserId,
    })
    .returning(ISSUED_COLUMNS);
  if (!row) {
    // INSERT が 0 行を返すのは RLS WITH CHECK 違反等。呼び出し側に明示エラーを返す。
    throw new Error("createClassMagicLink: INSERT が行を返しませんでした (RLS 拒否の可能性)");
  }
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
  actorUserId: string,
): Promise<IssuedMagicLink | undefined> {
  const [row] = await tx
    .update(magicLinks)
    .set({ revokedAt: sql`now()`, updatedBy: actorUserId, updatedAt: sql`now()` })
    .where(and(eq(magicLinks.id, id), isNull(magicLinks.revokedAt)))
    .returning(ISSUED_COLUMNS);
  return row;
}

/**
 * 教員 UI 用: クラスの有効なリンク一覧 (失効済を除く) を新しい順に返す。RLS で自校のみ。
 */
export async function listClassMagicLinks(
  tx: TenantTx,
  classId: string,
): Promise<IssuedMagicLink[]> {
  return tx
    .select(ISSUED_COLUMNS)
    .from(magicLinks)
    .where(and(eq(magicLinks.classId, classId), isNull(magicLinks.revokedAt)))
    .orderBy(desc(magicLinks.createdAt));
}
