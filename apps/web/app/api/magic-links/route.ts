import {
  MagicLinkClassNotFoundError,
  type TenantRole,
  createClassMagicLink,
  listClassMagicLinks,
  withTenantContext,
} from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../lib/auth/session";
import { getDb } from "../../../lib/db";
import {
  EXPIRES_DEFAULT_DAYS,
  computeExpiresAt,
  isIssuerRole,
  isUuid,
  parseIssueBody,
} from "../../../lib/magic-link/request";
import { generateToken, hashToken } from "../../../lib/magic-link/token";

/**
 * F05: クラス magic link の発行 / 一覧 API (ADR-008 Route Handlers / ADR-019 RLS)。
 *
 * - `POST /api/magic-links` — 教員/学校管理者がクラスにリンクを発行。**平文トークンはこの
 *   レスポンスで 1 度だけ返す** (QR/URL 用)。以降は DB に hash しか無く再取得不可 (ルール5)。
 * - `GET /api/magic-links?classId=` — クラスの有効なリンク一覧 (メタのみ、token は返さない)。
 *
 * 認可は二層: ここで role を弾く (UX/早期 deny) + DB の tenant_isolation が school 越境を
 * DB レベルで止める (ルール2 多層防御)。RLS context は `withTenantContext` で一元配線 (ADR-008)。
 */

/** 認証 + 発行者ロールを確認し、未認証/権限不足なら NextResponse、OK なら user を返す。 */
async function requireIssuer(): Promise<
  | { ok: true; uid: string; schoolId: string; role: TenantRole }
  | { ok: false; response: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  if (!isIssuerRole(user.role) || !user.schoolId) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, uid: user.uid, schoolId: user.schoolId, role: user.role };
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireIssuer();
  if (!auth.ok) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const parsed = parseIssueBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // 平文トークンは発行レスポンスのみ。DB には hash を保存する。
  const token = generateToken();
  const tokenHash = hashToken(token);
  // 有効期限はサーバ時刻起点で**常に明示算出**する（client 時刻を信用しない）。`expiresInDays` 省略時は
  // 既定 1 年（`EXPIRES_DEFAULT_DAYS`、学年度カバー・finding④）を適用し、DB 列デフォルト（90 日）には
  // 倒さない（既定を 1 箇所＝アプリ層に集約）。
  const expiresAt = computeExpiresAt(
    parsed.value.expiresInDays ?? EXPIRES_DEFAULT_DAYS,
    new Date(),
  );

  try {
    const issued = await withTenantContext(
      getDb(),
      { userId: auth.uid, schoolId: auth.schoolId, role: auth.role },
      (tx) =>
        createClassMagicLink(tx, {
          schoolId: auth.schoolId,
          classId: parsed.value.classId,
          tokenHash,
          expiresAt,
          actorUserId: auth.uid,
        }),
    );

    return NextResponse.json(
      {
        id: issued.id,
        classId: issued.classId,
        // 平文トークンと相対パス。クライアントが origin を付けて URL/QR を生成する。
        // 同一トークンが 2 つの匿名経路で有効: `path`(/s/ = 生徒ショートリンク→/student) と
        // `signagePath`(/signage/ = サイネージ盤面)。サイネージ端末用 URL を UI に出すため両方返す。
        token,
        path: `/s/${token}`,
        signagePath: `/signage/${token}`,
        expiresAt: issued.expiresAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof MagicLinkClassNotFoundError) {
      return NextResponse.json({ error: "class_not_found" }, { status: 404 });
    }
    throw err;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireIssuer();
  if (!auth.ok) {
    return auth.response;
  }

  const params = new URL(request.url).searchParams;
  const classId = params.get("classId");
  if (!isUuid(classId)) {
    return NextResponse.json({ error: "invalid_class_id" }, { status: 400 });
  }
  // 失効済も含めるか (F05 失効履歴の監査表示)。既定は有効リンクのみ。
  const includeRevoked = params.get("includeRevoked") === "true";

  const links = await withTenantContext(
    getDb(),
    { userId: auth.uid, schoolId: auth.schoolId, role: auth.role },
    (tx) => listClassMagicLinks(tx, classId, { includeRevoked }),
  );

  // token は一切返さない (発行時のみ)。メタ情報のみ。revokedAt で失効済を判別できる。
  return NextResponse.json({
    links: links.map((l) => ({
      id: l.id,
      classId: l.classId,
      expiresAt: l.expiresAt.toISOString(),
      revokedAt: l.revokedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
    })),
  });
}
