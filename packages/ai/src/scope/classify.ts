/**
 * F06 スコープ分類器 (ADR-028, #366)。
 *
 * 役割: Gemini 呼出 **前** に「掲示物 Q&A か否か」を判定し、学習・進路など
 * 掲示物と無関係な話題は out_of_scope として呼出し側で「誘導なし拒否」させる。
 *
 * 設計方針:
 * - LLM 非依存の決定論キーワード分類器（コスト 0 / レイテンシ 0 / 監査可能 /
 *   ADR-028 §2 は「Gemini 呼出前に分類」を要求しており、分類自体に LLM を
 *   使うと拒否前に課金してしまい目的を満たさない）。
 * - 多言語: 日本語 (常用 + やさしい日本語のひらがな表記) / 英語 / ポルトガル語。
 *   ADR-028 §5。Gemini が多言語ネイティブであっても、拒否判定は Gemini を
 *   呼ばずに済ませる必要がある。
 * - インジェクション耐性: 「指示を無視して...」型の攻撃文も、その後段の本文に
 *   学習/進路語が残ればキーワードで検出する（指示文ではなく内容を見る）。
 * - 正規化: NFKC で全角英数字・記号を半角に揃え、日本語 IME 由来の全角混在や
 *   全角偽装（`ｓｏｌｖｅ` 等）を吸収する。半角 → 大文字小文字は regex `i` フラグ
 *   で吸収する。ひらがな/カタカナ/漢字は NFKC で変換されないので別パターンで列挙する。
 * - 偽陽性回避: 掲示物起源の語（テスト / 持ち物 / 予定 / お知らせ / 集合）は
 *   単独では out_of_scope にしない。学習行為・進路相談に固有の表現のみを
 *   拒否トリガにする。
 *
 * 本分類器は **掲示物以外の話題を拒否する** ためのもの。掲示物 Q&A の根拠不足
 * （RAG 非ヒット）は ADR-028 §3 の「ラベル付き一般補足」で別途扱う。
 */

export type ScopeVerdict = "in_scope" | "out_of_scope";
export type OutOfScopeReason = "study" | "career";

export interface ScopeClassification {
  verdict: ScopeVerdict;
  /** out_of_scope のときの拒否カテゴリ。in_scope では null。 */
  reason: OutOfScopeReason | null;
  /** マッチした表層形（監査ログ用、in_scope では null）。 */
  matched: string | null;
}

// 学習（study）トリガ語。「学習行為」「教科の解答補助」を強く示す表現に絞り、
// 掲示物の周辺語（テスト/持ち物/予定/お知らせ）は意図的に除外する。
const STUDY_PATTERNS: readonly RegExp[] = [
  // 日本語（漢字混じり）
  /勉強/,
  /宿題/,
  /自習/,
  /解き方/,
  /解いて/,
  /答えを教え/,
  /問題を解/,
  /教科書/,
  // やさしい日本語 / ひらがな
  /べんきょう/,
  /しゅくだい/,
  /こたえをおしえ/,
  // 英語
  /\bstudy\b/i,
  /\bstudying\b/i,
  /\bhomework\b/i,
  /\bsolve (?:this|the|my|for)\b/i,
  /\bteach me (?:how|the|math|english|science|to solve)/i,
  /\b(?:math|algebra|geometry|calculus|physics) (?:problem|question)/i,
  /\bequation\b/i,
  // ポルトガル語
  /\bdever de casa\b/i,
  /\bli[cç][aã]o de casa\b/i,
  /\btarefa escolar\b/i,
  /\bme ensine\b/i,
  /\bcomo resolver\b/i,
  /\bestudar para\b/i,
];

// 進路（career）トリガ語。受験勉強・大学進学相談・就職活動など掲示物の範囲外。
const CAREER_PATTERNS: readonly RegExp[] = [
  /進路相談/,
  /進路/,
  /受験勉強/,
  /大学受験/,
  /志望校/,
  /推薦入試/,
  /就活/,
  /就職活動/,
  /内定/,
  /履歴書/,
  /偏差値/,
  /将来の夢/,
  // やさしい日本語 / ひらがな
  /しんろ/,
  /しぼうこう/,
  /じゅけんべんきょう/,
  // 英語
  /\bcareer (?:advice|path|counsel|counseling)/i,
  /\bcollege (?:admission|application|essay)/i,
  /\buniversity (?:entrance|admission|application)/i,
  /\bjob (?:hunting|interview|application)\b/i,
  // ポルトガル語
  /\bvestibular\b/i,
  /\bfaculdade\b/i,
  /\bcarreira profissional\b/i,
  /\bfuturo profissional\b/i,
  /\bcurr[ií]culo\b/i,
];

/**
 * 入力テキストをスコープ分類する。
 *
 * 学習・進路に該当するキーワードを含むなら out_of_scope（理由付き）、
 * それ以外は in_scope を返す。career → study の順で評価する（受験勉強等は
 * career 扱いを優先するため）。
 *
 * @param input 生徒の自由入力（PII マスキング前後どちらでも判定可能）。
 */
export function classifyScope(input: string): ScopeClassification {
  // NFKC: 全角英数字・記号を半角に正規化し、全角偽装によるバイパスを塞ぐ。
  const normalized = input.normalize("NFKC");

  for (const re of CAREER_PATTERNS) {
    const m = normalized.match(re);
    if (m) {
      return { verdict: "out_of_scope", reason: "career", matched: m[0] };
    }
  }
  for (const re of STUDY_PATTERNS) {
    const m = normalized.match(re);
    if (m) {
      return { verdict: "out_of_scope", reason: "study", matched: m[0] };
    }
  }
  return { verdict: "in_scope", reason: null, matched: null };
}
