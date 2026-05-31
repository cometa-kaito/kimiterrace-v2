import { hashToken } from "@/lib/magic-link/token";
import { events, resolveMagicLink, withTenantContext } from "@kimiterrace/db";
import { getDb } from "../db";
import type { ValidatedSignageEvent } from "./event-core";

/**
 * F07: 公開サイネージ表示端末 (`/signage/{classToken}`、匿名) が送る行動ログ (view/tap/dwell) を
 * `events` に取り込む (#43)。`recordStudentAccess` (F05 の view 記録) と同型で、表示端末側の
 * クライアント駆動イベントを担当する。
 *
 * ## RLS コンテキスト (CLAUDE.md ルール2)
 *
 * 端末は教員セッションを持たない匿名経路なので、`getSignageDisplayData` と同じ 2 段で安全に
 * テナント文脈を確立する:
 *  1. `classToken` を `resolveMagicLink` (SECURITY DEFINER、RLS 文脈不要) で `{schoolId, classId}`
 *     に解決。失効/期限切れ/不明トークンは null → 呼出側が 410 に倒す。
 *  2. 解決できた `schoolId` のみを `withTenantContext` に載せ、その文脈で INSERT。**school_id は
 *     必ずトークン由来**でクライアント値は使わない。events の `tenant_isolation` WITH CHECK が
 *     DB レベルで自校に限定するため、別テナントへのイベント注入は構造的に不可能 (手書き条件に依存しない)。
 *
 * **credential 秘匿 (ルール5)**: `classToken` はログ・例外・payload に出さない。
 * **PII (ルール4)**: 表示端末イベントは集計用メタのみ。Vertex AI には送らない。
 */

/** 取込結果。トークン無効 (失効/期限切れ/不明) なら null、有効なら挿入件数。 */
export async function ingestSignageEvents(
  classToken: string,
  validated: ValidatedSignageEvent[],
): Promise<{ inserted: number } | null> {
  const resolved = await resolveMagicLink(getDb(), hashToken(classToken));
  if (!resolved) {
    return null;
  }
  const { schoolId, classId } = resolved;

  await withTenantContext(getDb(), { schoolId }, async (tx) => {
    await tx.insert(events).values(
      validated.map((e) => ({
        schoolId,
        type: e.type,
        contentId: e.contentId,
        // occurredAt 未指定なら列の default now() に委ねる (null を入れない: notNull 列)。
        ...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
        // クライアント payload にサーバ確定のメタ (source / classId) を後置きで上書きする。
        payload: { ...e.payload, source: "signage", classId },
      })),
    );
  });

  return { inserted: validated.length };
}
