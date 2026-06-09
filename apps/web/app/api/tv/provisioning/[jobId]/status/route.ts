import {
  type TvProvisioningStatus,
  reportProvisioningStatus,
  tvProvisioningStatus,
} from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../../lib/db";
import { clientKeyFromHeaders } from "../../../../../../lib/guide/rate-limit";
import {
  getConfiguredProvisionAgentSecret,
  verifyProvisionAgentSecret,
} from "../../../../../../lib/tv/provision-agent-secret";
import { provisionAgentRateLimiter } from "../../../../../../lib/tv/rate-limit";

/**
 * C方式 TV プロビジョニング: claim したエージェント (PR5) が段階状態・ステップ結果を報告する
 * エンドポイント。`POST /api/tv/provisioning/[jobId]/status`（ADR-008 Route Handler）。
 *
 * `reportProvisioningStatus`（packages/db、system_admin context = cross-tenant、BYPASSRLS 不使用、
 * ルール2）が `(jobId, claimed_by=agentId)` を突き合わせて 1 行を更新する（claim したエージェントのみ
 * 報告可 = 状態詐称防止）。一致行が無ければ 404。
 *
 * 流れ:
 *  1. レート制限（client IP 単位、1 分 30 req）。超過は 429
 *  2. 専用シークレット検証（`x-provision-agent-key`、PROVISION_AGENT_SECRET。未設定/不一致は 401、
 *     fail-closed、ルール5）
 *  3. jobId（route param）+ body `{ agentId, status?, currentStep?, step?, error?, deviceId? }`。
 *     agentId 必須（400）。status は渡されたら enum 値域チェック（tv_provisioning_status の単一ソース
 *     `tvProvisioningStatus.enumValues` と照合、未知値は 400、ルール3）
 *  4. 報告 → `updated`:200 `{ok:true}` / `not_found`:404
 *
 * **runtime='nodejs' / force-dynamic**: claim ルートと同理由（node:crypto 定数時間比較 + 副作用で
 * キャッシュ不可）。本番 secret コンテナ / env 配線は PR6（Terraform 別 PR）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** tv_provisioning_status enum の値域（実行時の単一ソース、ルール3）。手書きで列挙しない。 */
const VALID_STATUSES = new Set<string>(tvProvisioningStatus.enumValues);

function isValidStatus(v: string): v is TvProvisioningStatus {
  return VALID_STATUSES.has(v);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  // 1. レート制限（client IP 単位）。claim ルートと同じ limiter を共有（エージェント API 全体の上限）。
  const ipKey = clientKeyFromHeaders(request.headers);
  if (!provisionAgentRateLimiter.tryAcquire(ipKey, Date.now())) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // 2. 専用シークレット検証（ルール5）。未設定（fail-closed）/ 不一致 / 欠如は 401。
  const expected = getConfiguredProvisionAgentSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const provided = request.headers.get("x-provision-agent-key");
  if (!verifyProvisionAgentSecret(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 3. jobId（route param）+ body。JSON 不正は 400。
  const { jobId } = await params;
  let body: {
    agentId?: unknown;
    status?: unknown;
    currentStep?: unknown;
    step?: unknown;
    error?: unknown;
    deviceId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // agentId 必須（claim 時の値と一致しないと下流で not_found になる認可キー）。
  const agentId = body?.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }

  // status は任意。渡されたら enum 値域チェック（未知値は弾く、ルール3 値域の単一ソース）。
  let status: TvProvisioningStatus | undefined;
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !isValidStatus(body.status)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    status = body.status;
  }

  // 4. 報告。任意フィールドは渡された時のみ反映（クエリ層が undefined を no-op 扱い）。
  //    秘密値は載せない（step.detail / error はエージェント側が非秘密に整形する契約）。
  try {
    const result = await reportProvisioningStatus(getDb(), {
      jobId,
      agentId,
      status,
      currentStep: typeof body.currentStep === "string" ? body.currentStep : undefined,
      step: isProvisioningStep(body.step) ? body.step : undefined,
      error: typeof body.error === "string" ? body.error : undefined,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
    });
    if (result.status === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** steps_json 追記用の 1 ステップか最小検証（name/status 必須、detail/at は任意）。秘密値は載せない契約。 */
function isProvisioningStep(
  v: unknown,
): v is { name: string; status: string; detail?: Record<string, unknown>; at?: string } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.status === "string";
}
