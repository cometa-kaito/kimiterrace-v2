import { isRoleAllowed } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { respondWithAssistantChat } from "@/lib/editor/assistant-chat-sse";
import {
  resolveAllowedSections,
  resolveManualSectionLabels,
} from "@/lib/editor/assistant-sections";
import { EDITOR_ROLES, parseEditorTarget, toEditorActor } from "@/lib/editor/schedule-core";
import { resolveDesignPattern } from "@/lib/signage/design-pattern";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";
import { type TenantContext, getClassSignageUrl, withTenantContext } from "@kimiterrace/db";

/**
 * 会話型 AI アシスタント（finding 2b）の **SSE route** `POST /api/editor/assistant/chat`。
 *
 * ボディ `{messages, draft?, acknowledgePii?}`（会話履歴 + 現在の下書き）→ AI が「会話応答 + 構造化下書き」を
 * 1 ターン分ストリーミングで返す。編集対象は **クエリ** `?scope=class&targetId=<uuid>`。SSE/HTTP 配線・PII・
 * 監査は {@link respondWithAssistantChat} に委譲し、本 route は **認証 + role gate + target 解決 +
 * 許可セクション解決**に徹する（notice-draft route と同方針）。
 *
 * ## 設計（CLAUDE.md ルール2/4/5）
 * - 認証は `getCurrentUser`（page の `requireRole` は redirect ゆえ API では使わない）: 未認証 401 / role 不足 403 /
 *   target 不正 400 を **JSON で**返す（200 SSE を開く前）。許可 role は {@link EDITOR_ROLES}（teacher / school_admin）。
 * - actor/context はセッション由来（confused-deputy 防止）。許可セクションも**サーバが解決**しクライアントを信用しない。
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return jsonError(401, "unauthenticated");
  }
  if (!isRoleAllowed(user.role, EDITOR_ROLES)) {
    return jsonError(403, "forbidden");
  }
  const actor = toEditorActor(user);
  if (!actor) {
    // schoolId 無し（壊れたアカウント）。自校スコープが成立しないので deny-by-default。
    return jsonError(403, "forbidden");
  }

  const url = new URL(request.url);
  const target = parseEditorTarget(url.searchParams.get("scope"), url.searchParams.get("targetId"));
  if (!target) {
    return jsonError(400, "invalid_target");
  }

  const tenantContext: TenantContext = {
    userId: user.uid,
    schoolId: actor.schoolId,
    role: user.role,
  };

  // パターン準拠の許可セクション解決（finding①）。**端末別 ?design > 学校レベル既定 > pattern1** の二段解決で、
  // 盤面エディタ（[classId]/page.tsx）と同じ実効パターンを使う。class scope は当該クラスの実機 TV の
  // `signage_url`（?design）を優先解決し（#1093 が read 側で確立した二段解決をチャット経路にも適用）、端末に
  // 紐づかない school/department/grade scope は学校既定を使う。これで AI が下書きできるセクションが「その端末が
  // 実際に表示するパターン」と一致し、pattern2/3/4 端末で「AI で作って反映したのに盤面に出ない／許可外
  // セクションが保存される」ズレを解消する。其他レーンの**単一ソース `PATTERN_BLOCKS`** を consume して下書き
  // 可能セクション（pattern2 なら [schedules]）＋手入力誘導セクション（来校者/呼び出し）を導く。**AI レーンで
  // 独自の pattern→セクション表は定義しない**（二重化＝ドリフト回避・調整ポイント1）。
  const pattern = await withTenantContext(getDb(), tenantContext, async (tx) => {
    const schoolDefault = await getSignageDesignPattern(tx);
    if (target.scope !== "class") {
      return schoolDefault;
    }
    // class scope: 当該クラスの実機端末の signage_url から端末別パターンを解決（盤面 page.tsx と同一規約）。
    const liveSignageUrl = await getClassSignageUrl(tx, target.classId);
    return resolveDesignPattern(liveSignageUrl, schoolDefault);
  });
  const allowedSections = resolveAllowedSections(pattern);
  const manualSectionLabels = resolveManualSectionLabels(pattern);

  return respondWithAssistantChat(
    { target, actor, tenantContext, allowedSections, pattern, manualSectionLabels },
    request,
  );
}

/** request-level の拒否を JSON で返す（200 SSE を開く前の 401/403/400 用）。 */
function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
