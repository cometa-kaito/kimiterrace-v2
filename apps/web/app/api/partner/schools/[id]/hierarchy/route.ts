import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/magic-link/request";
import {
  getConfiguredPartnerSecret,
  partnerKeyFromHeaders,
  verifyPartnerSecret,
} from "@/lib/partner/secret";
import { type TvLivenessStatus, classifyTvLiveness } from "@/lib/tv/status";
import {
  type SchoolHierarchy,
  type SchoolHierarchyMonitor,
  type TenantTx,
  getSchoolHierarchy,
  withTenantContext,
} from "@kimiterrace/db";
import { NextResponse } from "next/server";

/**
 * Partner API K4（`docs/api/partner-api-contract.md` §3.5）: **学校階層 pull**（read-only・運営整理 Phase6）。
 *
 * `GET /api/partner/schools/{schoolId}/hierarchy`
 *
 * portal「学校営業台帳」が、名寄せ済（portal `schools.v2_school_id`）の学校について、配信 SoR である v2 から
 * 「学校 → 設置場所 → モニタ」の階層を server-to-server で取得する。台帳の運用中校は v2 を正本として
 * **自動表示・編集ロック**するため、portal は本エンドポイントを参照のみに使う（K1 metrics と同じ chokepoint・
 * ブラウザ非経由・PII/秘匿無し・冪等）。
 *
 * ## 認証（二層 RLS の第一層 = 共有シークレット、契約 §1 / ADR-019）
 * `x-partner-key: <secret>`（または `Authorization: Bearer <secret>`）を `PARTNER_API_SECRET` と
 * SHA-256 + timingSafeEqual で定数時間比較する（metrics route と同方式）。未設定（fail-closed）/ 不一致は **401**。
 *
 * ## DB アクセス（二層 RLS の第二層 = system_admin policy、ルール2 / 契約 §0）
 * 外部（portal）呼び出しでユーザーセッションが無いため **system_admin context** で実行する
 * （cross-tenant 可。schools / tv_devices は system_admin_full_access policy を持つ）。BYPASSRLS 不使用・降格なし。
 *
 * ## runtime / dynamic
 * `runtime='nodejs'`（外部 origin GET を CSRF から分離・node:crypto 定数時間比較）/ `force-dynamic`
 * （シークレット検証 + cross-tenant 読み取りで都度評価・キャッシュしない）。metrics route と同方針。
 *
 * ## エラー（契約 §3.5）
 * 401（未設定/不一致）/ 400（id 形式不正）/ 404（学校無 = RLS 不可視/不存在）/ 500（内部）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 契約 §3.5 の 200 レスポンス形（snake_case）。型は DB 由来 `SchoolHierarchy` から派生（ルール3）。 */
type HierarchyResponse = {
  school_id: SchoolHierarchy["school"]["id"];
  school_name: SchoolHierarchy["school"]["name"];
  prefecture: SchoolHierarchy["school"]["prefecture"];
  code: SchoolHierarchy["school"]["code"];
  hierarchy_mode: SchoolHierarchy["school"]["hierarchyMode"];
  monitors: Array<{
    id: string;
    label: string | null;
    grade_name: string | null;
    department_name: string | null;
    class_name: string | null;
    /** v2 が正本とする稼働ステータス（online / quiet / down / never）。 */
    status: TvLivenessStatus;
    last_seen_at: string | null;
    monitoring_enabled: boolean;
    alert_state: SchoolHierarchyMonitor["alertState"];
  }>;
  generated_at: string;
  source: "live";
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // 1. 共有シークレット検証（ルール5・fail-closed）。未設定 / 不一致 / 欠如は一律 401、本体に到達させない。
  const expected = getConfiguredPartnerSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const provided = partnerKeyFromHeaders(request.headers);
  if (!verifyPartnerSecret(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. パスパラメータ schoolId は UUID 必須（不正形式は 400、DB へ不正値を投げない）。
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_school_id" }, { status: 400 });
  }

  // 3. system_admin context（cross-tenant）で 1 校の階層を読む。降格しない・BYPASSRLS 不使用。
  try {
    const hierarchy = await withTenantContext(
      getDb(),
      { userId: null, schoolId: null, role: "system_admin" },
      (tx: TenantTx) => getSchoolHierarchy(tx, id),
    );
    if (!hierarchy) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(toResponse(hierarchy), {
      status: 200,
      // 認可スコープ付きの読み取りを共有キャッシュへ残さない。
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // 一時的 DB エラー等。詳細は返さず 500（portal はフォールバック表示する）。
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** DB 由来の階層を契約 §3.5 の snake_case JSON 形へ写す（PII/秘匿無し）。稼働ステータスは v2 が判定し正本化する。 */
function toResponse(h: SchoolHierarchy): HierarchyResponse {
  const now = new Date();
  return {
    school_id: h.school.id,
    school_name: h.school.name,
    prefecture: h.school.prefecture,
    code: h.school.code,
    hierarchy_mode: h.school.hierarchyMode,
    monitors: h.monitors.map((m) => ({
      id: m.id,
      label: m.label,
      grade_name: m.gradeName,
      department_name: m.departmentName,
      class_name: m.className,
      status: classifyTvLiveness(m.lastSeenAt, now),
      last_seen_at: m.lastSeenAt ? m.lastSeenAt.toISOString() : null,
      monitoring_enabled: m.monitoringEnabled,
      alert_state: m.alertState,
    })),
    generated_at: now.toISOString(),
    source: "live",
  };
}
