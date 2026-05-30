import type { MaskOptions, MaskResult, PiiCategory, PiiEntry } from "./types.js";

/**
 * F03 / CLAUDE.md ルール4: Vertex AI へ送信する前に PII をトークン化する。
 *
 * 設計方針:
 * - **送信前トークン化 → 応答後逆変換**。生 PII はプロンプト・モデルログ・キャッシュに
 *   一切残さない（LLM への送信は事実上の外部委託、ルール4 の理由）。
 * - 確実な PII（生徒・保護者・職員氏名）は呼び出し側がロスター由来の `PiiEntry[]` として渡す。
 *   推測に頼らず「学校が保持する正確な氏名」を確定マスクするのが最も漏れにくい。表記揺れは
 *   `aliases` に列挙すると同一トークンへ集約され、逆変換で正規表記に戻る。
 * - 加えて電話・メールなど**書式が決まった PII** を正規表現で機械検出する（無効化可能）。
 * - 同一の値は同一トークンに割り当てる（文脈の一貫性を保ち、LLM の解釈精度を落とさない）。
 *
 * トークン書式は `{{CATEGORY_NNN}}`（例 `{{STUDENT_001}}`）。JSON 文字列にそのまま埋め込んでも
 * 壊れない ASCII のみで構成し、逆変換はトークン文字列の単純置換で完了する。
 */

// 書式が決まった PII の検出パターン。
// 電話: 区切りあり（市外局番/携帯） or 区切りなし 10〜11 桁。
const PHONE_RE = /0\d{1,4}-\d{1,4}-\d{3,4}|0\d{9,10}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function makeToken(category: string, n: number): string {
  return `{{${category}_${String(n).padStart(3, "0")}}}`;
}

/** 正規表現リテラルをエスケープ（値をリテラル文字列として検索するため）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Surface {
  surface: string;
  token: string;
  value: string;
}

/**
 * テキスト中の PII をトークンに置換する。
 *
 * @param text     マスク対象の自由入力。
 * @param entries  名簿由来の確実な PII。配列順にカテゴリ別連番のトークンを割り当てる。
 * @param options  パターン検出の ON/OFF（既定で電話・メール検出）。
 * @returns        マスク済みテキストと逆変換辞書（token → 正規表記）。
 */
export function maskPII(
  text: string,
  entries: readonly PiiEntry[],
  options: MaskOptions = {},
): MaskResult {
  const dictionary: Record<string, string> = {};
  const counters: Record<string, number> = {};
  const nextToken = (category: string): string => {
    counters[category] = (counters[category] ?? 0) + 1;
    return makeToken(category, counters[category]);
  };

  // 1) 名簿エントリへ配列順にトークンを割り当て、全表層形（value + aliases）を収集する。
  //    番号は配列順で確定し、置換は最長一致優先で行う（部分一致の取りこぼし防止）。
  const surfaces: Surface[] = [];
  for (const entry of entries) {
    if (!entry.value || entry.value.length === 0) continue;
    const token = nextToken(entry.category);
    for (const surface of [entry.value, ...(entry.aliases ?? [])]) {
      if (surface && surface.length > 0) surfaces.push({ surface, token, value: entry.value });
    }
  }
  surfaces.sort((a, b) => b.surface.length - a.surface.length);

  let masked = text;
  for (const { surface, token, value } of surfaces) {
    const re = new RegExp(escapeRegExp(surface), "g");
    let hit = false;
    masked = masked.replace(re, () => {
      hit = true;
      return token;
    });
    // 実際に置換が起きたエントリのみ辞書へ載せる（未出現エントリは番号だけ消費し辞書に残さない）。
    if (hit) dictionary[token] = value;
  }

  // 2) 書式が決まった PII を機械検出（既定 ON）。トークン内の短い数字列は誤検出しない。
  const assignPattern = (re: RegExp, category: PiiCategory | "PHONE" | "EMAIL") => {
    const seen = new Map<string, string>();
    masked = masked.replace(re, (m) => {
      const existing = seen.get(m);
      if (existing) return existing;
      const token = nextToken(category);
      seen.set(m, token);
      dictionary[token] = m;
      return token;
    });
  };
  if (options.detectPhones !== false) assignPattern(PHONE_RE, "PHONE");
  if (options.detectEmails !== false) assignPattern(EMAIL_RE, "EMAIL");

  return { masked, dictionary };
}

/**
 * `maskPII` のトークンを正規表記へ逆変換する。
 *
 * モデル応答（構造化 JSON を含む任意の文字列）に使う。長いトークンを優先して置換し、
 * 前方一致の誤爆を防ぐ（トークンは `}}` で閉じるため衝突しないが、多層防御として並べ替える）。
 */
export function unmaskPII(text: string, dictionary: Record<string, string>): string {
  let out = text;
  const tokens = Object.keys(dictionary).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    out = out.split(token).join(dictionary[token] ?? token);
  }
  return out;
}

/**
 * オブジェクト中の文字列に含まれるトークンを再帰的に逆変換する。
 * JSON 直列化 → 文字列置換 → 復元で実装（トークンは JSON セーフな ASCII のため安全）。
 */
export function unmaskDeep<T>(value: T, dictionary: Record<string, string>): T {
  return JSON.parse(unmaskPII(JSON.stringify(value), dictionary)) as T;
}

/**
 * fail-closed 検証: マスク後テキストに PII が残っていないか走査する。
 *
 * 名簿値（および別名）の残存と、電話・メールのパターン残存を検出して配列で返す。空配列なら
 * 「漏れなし」。送信直前にこれを呼び、非空なら送信を中止する運用で、マスク漏れを構造的に塞ぐ。
 */
export function findUnmaskedPii(text: string, entries: readonly PiiEntry[]): string[] {
  const leaks = new Set<string>();
  for (const entry of entries) {
    for (const surface of [entry.value, ...(entry.aliases ?? [])]) {
      if (surface && surface.length > 0 && text.includes(surface)) leaks.add(entry.value);
    }
  }
  for (const m of text.match(PHONE_RE) ?? []) leaks.add(m);
  for (const m of text.match(EMAIL_RE) ?? []) leaks.add(m);
  return [...leaks];
}
