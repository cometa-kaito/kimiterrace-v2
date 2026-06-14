import { getDb } from "@/lib/db";
import {
  getConfiguredPartnerSecret,
  partnerKeyFromHeaders,
  verifyPartnerSecret,
} from "@/lib/partner/secret";
import { type SchoolSummary, type TenantTx, listSchools, withTenantContext } from "@kimiterrace/db";
import { NextResponse } from "next/server";

/**
 * Partner API K5（`docs/api/partner-api-contract.md` §3.6）: **学校一覧 pull**（read-only・運営整理 Phase6）。
 *
 * `GET /api/partner/schools`
 *
 * portal「学校営業台帳」の **名寄せ（reconcile）** 用。portal は未名寄せの自校（商流側 schools）と、
 * 配信 SoR である v2 の学校一覧を server-to-server で突き合わせ、候補を自動提示する。確定（橋キー
 * `schools.v2_school_id` への UUID 書き込み）は人間の一括確認で行う（名前一致での自動リンクは禁止＝
 * 別校データ誤表示の事故防止）。本エンドポイントは候補の母集合（id・校名・都道府県・コード）を供給する。
 *
 * K1 metrics / K4 hierarchy と同じ chokepoint：ブラウザ非経由・共有シークレット認証・system_admin context・
 * PII/秘匿無し（学校マスタの公開的属性のみ）・冪等。
 *
 * ## 認証（契約 §1 / ADR-019）
 * `x-partner-key` または `Authorization: Bearer` を `PARTNER_API_SECRET` と SHA-256 + timingSafeEqual で
 * 定数時間比較。未設定（fail-closed）/ 不一致は **401**。
 *
 * ## DB アクセス（ルール2 / 契約 §0）
 * 外部呼び出しでユーザーセッション無 → **system_admin context**（cross-tenant・BYPASSRLS 不使用）。
 * schools は system_admin_full_access policy を持つ。
 *
 * ## エラー（契約 §3.6）
 * 401（未設定/不一致）/ 500（内部）。一覧なので 404 は無い（0 件は空配列）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 契約 §3.6 の 200 レスポンス形（snake_case）。型は DB 由来 `SchoolSummary` から派生（ルール3）。 */
type SchoolListResponse = {
  schools: Array<{
    id: SchoolSummary["id"];
    name: SchoolSummary["name"];
    prefecture: SchoolSummary["prefecture"];
    code: SchoolSummary["code"];
    hierarchy_mode: SchoolSummary["hierarchyMode"];
  }>;
  generated_at: string;
  source: "live";
};

export async function GET(request: Request): Promise<NextResponse> {
  // 1. 共有シークレット検証（fail-closed）。未設定 / 不一致 / 欠如は一律 401。
  const expected = getConfiguredPartnerSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const provided = partnerKeyFromHeaders(request.headers);
  if (!verifyPartnerSecret(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. system_admin context（cross-tenant）で全校マスタを読む。降格しない・BYPASSRLS 不使用。
  try {
    const rows = await withTenantContext(
      getDb(),
      { userId: null, schoolId: null, role: "system_admin" },
      (tx: TenantTx) => listSchools(tx),
    );
    return NextResponse.json(toResponse(rows), {
      status: 200,
      // 認可スコープ付きの読み取りを共有キャッシュへ残さない。
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** DB 由来の学校サマリを契約 §3.6 の snake_case JSON 形へ写す（PII/秘匿無し）。 */
function toResponse(rows: SchoolSummary[]): SchoolListResponse {
  return {
    schools: rows.map((s) => ({
      id: s.id,
      name: s.name,
      prefecture: s.prefecture,
      code: s.code,
      hierarchy_mode: s.hierarchyMode,
    })),
    generated_at: new Date().toISOString(),
    source: "live",
  };
}
