import {
  MagicLinkClassNotFoundError,
  createClassMagicLink,
  getVisibleClassSchoolId,
  listClassMagicLinks,
  withTenantContext,
} from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";
import {
  requireIssuer,
  tenantContextForIssuer,
  toMagicLinkActor,
} from "../../../lib/magic-link/issuer";
import {
  EXPIRES_DEFAULT_DAYS,
  computeExpiresAt,
  isUuid,
  parseIssueBody,
} from "../../../lib/magic-link/request";
import { generateToken, hashToken } from "../../../lib/magic-link/token";

/**
 * F05: クラス magic link の発行 / 一覧 API (ADR-008 Route Handlers / ADR-019 RLS)。
 *
 * - `POST /api/magic-links` — 学校管理者 / 運営がクラスにリンクを発行。**平文トークンはこの
 *   レスポンスで 1 度だけ返す** (QR/URL 用)。以降は DB に hash しか無く再取得不可 (ルール5)。
 * - `GET /api/magic-links?classId=` — クラスの有効なリンク一覧 (メタのみ、token は返さない)。
 *
 * 認可（発行者ロール・RLS context・監査 actor）の解決は `lib/magic-link/issuer.ts` に集約し 3 ルートで共有
 * する（発行者 = school_admin / system_admin のみ・teacher 除外・finding④。system_admin は cross-tenant 発行）。
 */

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

  const { issuer } = auth;
  try {
    const issued = await withTenantContext(getDb(), tenantContextForIssuer(issuer), async (tx) => {
      // 発行先クラスの学校。school_admin は自校 id。**system_admin は対象クラスから cross-tenant 解決**
      // （system_admin_full_access 下で可視）。解決できなければ（別テナント不可視・不存在）class_not_found。
      const schoolId = issuer.schoolId ?? (await getVisibleClassSchoolId(tx, parsed.value.classId));
      if (!schoolId) {
        throw new MagicLinkClassNotFoundError(parsed.value.classId);
      }
      return createClassMagicLink(tx, {
        schoolId,
        classId: parsed.value.classId,
        tokenHash,
        expiresAt,
        actor: toMagicLinkActor(issuer),
      });
    });

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
        // ADR-042: expiresAt は NULL = 無期限のため null 安全化（string | null）。
        expiresAt: issued.expiresAt?.toISOString() ?? null,
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

  const links = await withTenantContext(getDb(), tenantContextForIssuer(auth.issuer), (tx) =>
    listClassMagicLinks(tx, classId, { includeRevoked }),
  );

  // token は一切返さない (発行時のみ)。メタ情報のみ。revokedAt で失効済を判別できる。
  return NextResponse.json({
    links: links.map((l) => ({
      id: l.id,
      classId: l.classId,
      // ADR-042: expiresAt は NULL = 無期限のため null 安全化（string | null）。
      expiresAt: l.expiresAt?.toISOString() ?? null,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
    })),
  });
}
