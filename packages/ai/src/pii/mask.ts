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
// すべて量化子を上限付き ({n,m}) にして線形時間で評価する（untrusted な教員/生徒入力に毎回適用する
// ため ReDoS を構造的に排除）。F06 の多言語チャットボットでは外国人保護者・生徒の国際番号も届くので、
// 電話は国別フォーマットの列挙ではなく次の 3 系統で「主要外国語共通」に機械検出する:
//   ① 国際 E.164（先頭 `+` 国番号 + 国内番号）。桁間の区切り（空白/ハイフン/ドット/括弧/スラッシュ）は
//      0〜2 文字まで許容し（スラッシュは独語圏の `+49 30/12345678` 表記）、総桁数を 7〜15 に bound する
//      （E.164 上限 15 桁。住所番地・年号の誤検出を抑える）。旧来の +81 もこの一般枝が内包する。
//   ② 国内（日本）ハイフン区切り（市外局番/携帯） ③ 国内 区切りなし 10〜11 桁。
// 区切り文字クラスと数字クラスは素集合なので分割位置が一意に定まり、バックトラック爆発は起きない
// （① の {0,2} / {6,14} も bound 済み）。国際番号の検出により外国籍家庭の番号が Vertex へ素通りしない。
//
// 全角(CJK)対応 (#383, ルール4): 日本語 IME では電話・メールが全角で入力されがちで、半角前提だと
// 全角の電話・メールが Vertex へ素通りする。全角数字 `０-９` / 全角プラス `＋` / 全角ハイフン `－` /
// 全角ドット `．` / 全角括弧・スラッシュ / 全角＠ `＠` / 全角英字 TLD も半角と同様に受理する。半角 ASCII
// のセマンティクス（E.164 桁数 bound・素集合 = ReDoS 不能）は不変で、文字クラスを全角バリアントの
// 上位集合に広げるだけ。検出表層は原文のまま辞書化するので逆変換でラウンドトリップする。
const DIGIT = "[0-9\\uFF10-\\uFF19]"; // 半角 + 全角数字
const ZERO = "[0\\uFF10]"; // 国内番号の先頭 0（全角 ０ 含む）
const PLUS = "[+\\uFF0B]"; // 半角 + 全角プラス
const HYPHEN = "[-\\uFF0D]"; // 半角 + 全角ハイフン（国内区切り）
const PSEP = "[-.\\s()/\\uFF0D\\uFF0E\\u3000\\uFF08\\uFF09\\uFF0F]"; // 国際番号の桁間区切り（半角 + 全角）
const AT = "[@\\uFF20]"; // 半角 + 全角アット
const DOT = "[.\\uFF0E]"; // 半角 + 全角ドット（メール TLD 直前）
const ALPHA = "[A-Za-z\\uFF21-\\uFF3A\\uFF41-\\uFF5A]"; // 半角 + 全角英字（TLD）
const PHONE_RE = new RegExp(
  `${PLUS}${DIGIT}(?:${PSEP}{0,2}${DIGIT}){6,14}` +
    `|${ZERO}${DIGIT}{1,4}${HYPHEN}${DIGIT}{1,4}${HYPHEN}${DIGIT}{3,4}` +
    `|${ZERO}${DIGIT}{9,10}`,
  "g",
);
// メール: ローカル/ドメイン/TLD を RFC 上限内に bound（局所バックトラックを定数化）。全角＠・全角ドット・
// 全角英字 TLD も許容（CJK 全角入力での漏れを塞ぐ）。
const EMAIL_RE = new RegExp(
  `[^\\s@\\uFF20]{1,64}${AT}[^\\s@\\uFF20]{1,252}${DOT}${ALPHA}{2,24}`,
  "g",
);

function makeToken(category: string, n: number): string {
  return `{{${category}_${String(n).padStart(3, "0")}}}`;
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
    // 値はリテラル文字列として置換する（`new RegExp` を使わず ReDoS / 正規表現インジェクションを排除）。
    if (!masked.includes(surface)) continue;
    masked = masked.replaceAll(surface, token);
    // 実際に置換が起きたエントリのみ辞書へ載せる（未出現エントリは番号だけ消費し辞書に残さない）。
    dictionary[token] = value;
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
