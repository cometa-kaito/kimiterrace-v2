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
import { computeExpiresAt, isUuid, parseIssueBody } from "../../../lib/magic-link/request";
import { generateToken, hashToken } from "../../../lib/magic-link/token";

/**
 * F05 / ADR-042: クラス magic link の発行 / 一覧 API (ADR-008 Route Handlers / ADR-019 RLS)。
 *
 * - `POST /api/magic-links` — 学校管理者 / 運営がクラスにリンクを発行。**ADR-042 D1: `expiresInDays`
 *   省略時は無期限（expires_at=NULL）**で発行する（明示指定時のみ有限期限・後方互換）。**ADR-042 D2:
 *   平文トークンを `magic_links.token` に保存**して後から再表示可にする（resolve は hash 参照のまま）。
 * - `GET /api/magic-links?classId=` — クラスのリンク一覧。**ADR-042 D2: 平文 `token` を含めて返す**
 *   （RLS スコープ済＝system_admin 全校 / school_admin 自校のみ。再表示要件）。旧リンクは token=null。
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

  // 平文トークンを生成し、hash（resolve 照合用）と平文（ADR-042 D2: 再表示用に列保存）の両方を保存する。
  const token = generateToken();
  const tokenHash = hashToken(token);
  // ADR-042 D1: `expiresInDays` 省略時は**無期限（NULL）**で発行する（既定を無期限に変更）。明示指定時のみ
  // サーバ時刻起点で有限期限を算出する（client 時刻を信用しない・後方互換）。undefined を渡すと
  // createClassMagicLink が expires_at に NULL を明示 INSERT する（DB 列デフォルト 90 日には倒さない）。
  const expiresAt =
    parsed.value.expiresInDays === undefined
      ? undefined
      : computeExpiresAt(parsed.value.expiresInDays, new Date());

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
        // ADR-042 D2: 平文 token を列に保存（再表示用）。監査 diff には載らない（queries 層で除外）。
        token,
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

  // ADR-042 D2: 再表示のため**平文 `token` を含めて返す**。これは RLS の tenant_isolation 下で自校のリンク
  // のみが返る（system_admin は全校・school_admin は自校）ため、再表示できる人は ADR-042 の対象に一致する。
  // token_hash は依然返さない。旧リンク（PR2 以前発行）は token=null で、クライアント側で「再表示不可」に倒す。
  return NextResponse.json({
    links: links.map((l) => ({
      id: l.id,
      classId: l.classId,
      token: l.token,
      // ADR-042: expiresAt は NULL = 無期限のため null 安全化（string | null）。
      expiresAt: l.expiresAt?.toISOString() ?? null,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
    })),
  });
}
