import { claimNextProvisioningJob } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db";
import { clientKeyFromHeaders } from "../../../../../lib/guide/rate-limit";
import {
  getConfiguredProvisionAgentSecret,
  verifyProvisionAgentSecret,
} from "../../../../../lib/tv/provision-agent-secret";
import { provisionAgentRateLimiter } from "../../../../../lib/tv/rate-limit";

/**
 * C方式 TV プロビジョニング: ローカル provision-agent (PR5) が次ジョブを claim するエンドポイント。
 * `POST /api/tv/provisioning/claim`（ADR-008 Route Handler）。
 *
 * 学校 LAN 上のエージェントが数秒間隔でポーリングし、最古の pending ジョブを 1 件 `FOR UPDATE
 * SKIP LOCKED` で原子的に claim する（複数エージェント・二重 claim 競合に安全。実装は packages/db
 * `claimNextProvisioningJob`、system_admin context = cross-tenant、BYPASSRLS 不使用、ルール2）。
 *
 * 流れ:
 *  1. レート制限（client IP 単位、1 分 30 req。鍵検証より先に IP で頭打ち = 総当たりコスト抑制）
 *  2. 専用シークレット検証（`x-provision-agent-key`、PROVISION_AGENT_SECRET。TV_POLL_SECRET とは別の
 *     最小権限鍵。未設定/不一致は 401、fail-closed で本体処理に到達させない、ルール5）
 *  3. body `{ agentId }` 必須チェック（無ければ 400）
 *  4. claim → `200 {job}`（claim できれば非秘密パラメータのみ、鍵は返さない）/ `200 {job:null}`（無し）
 *
 * **runtime='nodejs'**: エージェントからの POST を Server Action CSRF から分離し、node:crypto
 * （定数時間比較）を使うため Edge ではなく Node runtime に固定。`force-dynamic` で都度評価（claim は
 * DB 状態を変える副作用がありキャッシュ不可）。本番 secret コンテナ / env 配線は PR6（Terraform 別 PR）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // 1. レート制限（client IP 単位）。エージェントは数秒間隔で叩くため 1 分 30 req。超過は 429。
  //    鍵検証より前に IP で頭打ちにし、鍵総当たりのコストを上げる。
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

  // 3. body 解析。agentId 必須（以後の status 報告の認可キー）。JSON 不正 / 欠如 / 空は 400。
  let agentId: unknown;
  try {
    const body = (await request.json()) as { agentId?: unknown };
    agentId = body?.agentId;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof agentId !== "string" || agentId.length === 0) {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }

  // 4. claim（最古 pending を SKIP LOCKED で 1 件）。鍵は返さず非秘密パラメータのみ。claim 可なら
  //    {job}、無ければ {job:null}（エージェントは次のポーリングで再試行）。
  try {
    const job = await claimNextProvisioningJob(getDb(), agentId);
    return NextResponse.json({ job }, { status: 200 });
  } catch {
    // 一時的 DB エラー等。詳細は返さず 500（エージェントは次のポーリングで自然回復）。
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
