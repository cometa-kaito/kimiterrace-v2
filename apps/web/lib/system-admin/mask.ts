/**
 * UIUX-03: 管理ビューアの **表示時マスキング** (pure・テスト可能)。
 *
 * events.payload / audit_log.diff の jsonb を画面に出す際、識別子・自由テキストをそのまま
 * 全文表示しないための表示専用変換。**保存データは変更しない** (表示層のみ)。
 *
 * 方針 (docs/compliance/admin-viewer-policy.md のドラフト値):
 * - 識別子系キー (mac/client/session/token/device 等) → 値の両端のみ残して中間を伏せる
 * - それ以外の文字列 → {@link TEXT_TRUNCATE_LIMIT} 文字で切り詰め (自由テキストに混入した
 *   PII の全文露出を防ぐ。全文が必要な調査は DB 直接アクセス + 別途監査の領分)
 * - 深いネスト/巨大配列は打ち切り (表示崩れ・コンテキスト爆発防止)
 *
 * ai_chat の content_text は **保存時点でマスク済み** (ルール4、{{STUDENT_001}} トークン化) のため
 * 本変換の対象外 — ビューアは逆変換 (トークン→実名) を**絶対にしない**。
 */

/** 識別子としてマスクするキー名のパターン (小文字比較)。 */
const SENSITIVE_KEY_RE = /(mac|client|session|token|secret|credential|device_id|uid|user_id)/;

/** 自由テキストの表示上限 (超過分は文字数表記で畳む)。 */
export const TEXT_TRUNCATE_LIMIT = 120;

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;

/** 識別子の中間部を伏せる: "AA:BB:CC:DD:EE:FF" → "AA:…:FF" / "0123456789abcdef" → "0123…cdef"。 */
export function maskIdentifier(value: string): string {
  if (value.length <= 8) {
    // 短い値は先頭 2 文字だけ残す (全伏せだと突合不能、全表示だと識別子のまま)。
    return `${value.slice(0, 2)}${"•".repeat(Math.max(1, value.length - 2))}`;
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 自由テキストを表示上限で切り詰める (全文は出さない)。 */
export function truncateText(value: string, limit: number = TEXT_TRUNCATE_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…(全${value.length}文字)`;
}

/**
 * jsonb 値を表示用に再帰変換する。識別子キーはマスク、文字列は切り詰め、ネスト/配列は打ち切り。
 * 返り値は JSON.stringify 可能 (画面では整形済み文字列として描画する想定)。
 */
export function maskJsonForDisplay(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateText(value);
  }
  if (depth >= MAX_DEPTH) {
    return "…(省略)";
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((v) => maskJsonForDisplay(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      head.push(`…(他${value.length - MAX_ARRAY_ITEMS}件)`);
    }
    return head;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && SENSITIVE_KEY_RE.test(key.toLowerCase())) {
        out[key] = maskIdentifier(v);
      } else {
        out[key] = maskJsonForDisplay(v, depth + 1);
      }
    }
    return out;
  }
  // bigint / undefined / function 等はそのまま文字列表記 (jsonb 由来では通常出ない)。
  return String(value);
}

/** 表示用: マスク済み jsonb を整形 JSON 文字列にする (一覧セルは 1 行、詳細は pretty)。 */
export function formatMaskedJson(value: unknown, pretty = false): string {
  const masked = maskJsonForDisplay(value);
  return pretty ? JSON.stringify(masked, null, 2) : JSON.stringify(masked);
}
