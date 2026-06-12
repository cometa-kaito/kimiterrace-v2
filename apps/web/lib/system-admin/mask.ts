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

/** 識別子としてマスクするキー名のパターン (小文字比較・両端のみ残す)。 */
const SENSITIVE_KEY_RE = /(mac|client|session|token|secret|credential|device_id|uid|user_id)/;

/**
 * 人名・連絡先など「両端を残してはいけない」PII キーのパターン (小文字比較・全伏字)。
 * ISSUE-3: 旧実装は人名系キーを伏字対象にせず audit_log.diff 等で職員/生徒の氏名・メールが
 * verbatim 露出していた。schoolName/className 等の**非 PII は意図的に対象外**(監査の有用性維持)。
 * 注: 任意 jsonb の網羅は不可能なため、これはキー名ヒューリスティック + truncateText のバックストップ。
 * 構造化 payload は発生源側の allowlist で守る (events.payload 参照)。
 */
const NAME_KEY_RE =
  /(display_?name|full_?name|first_?name|last_?name|family_?name|student_?name|parent_?name|guardian_?name|teacher_?name|staff_?name|user_?name|nick_?name|kana|furigana|ruby|^name$|^names$|^students?$|^members?$|^attendees?$|roster|e_?mail|phone|^tel$|mobile|address|^addr|zip|postal|birth)/;

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

/**
 * 人名 (生徒/保護者/教職員の displayName 等) の表示マスク。`maskIdentifier` は 16進識別子用で
 * 短い日本語氏名だと姓 (や 2 文字氏名の全体) が露出する (ISSUE-2) ため、人名は**文字も長さも
 * 一切残さず**固定の伏字にする。行の突合はマスク済み userId 側で行う (membership-list の doc 参照)。
 */
export function maskPersonName(value: string | null | undefined): string {
  return value ? "••" : "";
}

/** 自由テキストを表示上限で切り詰める (全文は出さない)。 */
export function truncateText(value: string, limit: number = TEXT_TRUNCATE_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…(全${value.length}文字)`;
}

/** 人名/連絡先キー配下を**全伏字**にする (文字列→••、配列→各要素伏字、ネスト→再帰)。 */
function redactPii(v: unknown, depth: number): unknown {
  if (v == null) return v;
  if (typeof v === "string") return maskPersonName(v);
  if (typeof v === "number" || typeof v === "boolean") return "••";
  if (Array.isArray(v)) {
    const head = v.slice(0, MAX_ARRAY_ITEMS).map((x) => redactPii(x, depth + 1));
    if (v.length > MAX_ARRAY_ITEMS) {
      head.push(`…(他${v.length - MAX_ARRAY_ITEMS}件)`);
    }
    return head;
  }
  if (typeof v === "object" && depth < MAX_DEPTH) {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactPii(vv, depth + 1);
    }
    return out;
  }
  return "••";
}

/**
 * jsonb 値を表示用に再帰変換する。識別子キーは両端マスク、人名/連絡先キーは全伏字、
 * 文字列は切り詰め、ネスト/配列は打ち切り。返り値は JSON.stringify 可能。
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
      const lk = key.toLowerCase();
      if (NAME_KEY_RE.test(lk)) {
        // 人名/連絡先キー: 文字列も配列(名簿)も数値も全伏字 (両端残し禁止)。
        out[key] = redactPii(v, depth);
      } else if ((typeof v === "string" || typeof v === "number") && SENSITIVE_KEY_RE.test(lk)) {
        // 識別子キー: 数値 id も含め両端のみ残す。
        out[key] = maskIdentifier(String(v));
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
