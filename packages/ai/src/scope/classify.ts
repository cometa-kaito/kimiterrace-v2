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
  // `勉強` は原則 study とするが、掲示物起源の文脈だけ negative lookahead で除外する:
  //   - `勉強会`（学習イベント名）
  //   - `勉強の(予定|日程|場所|会場|集合|時間|範囲|持ち物|スケジュール)`（イベントの予定/所在 Q&A）
  // これにより `勉強会の集合場所` / `テスト勉強の予定` は in_scope に保ちつつ（#389 Reviewer M-1）、
  // `勉強したい` / `勉強について教えて` / `数学の勉強で困っている` のような素朴な学習依頼は
  // 取りこぼさない（#397 Reviewer Low-1: bare 限定だと recall が後退する）。`勉強の仕方` 等の
  // 学習依頼は除外語に含めないので引き続き study。ひらがな `べんきょう` は別パターンで bare のまま
  // （やさしい日本語は表記ゆれが大きく、既存の `べんきょうの しかた`（分かち書き）を取りこぼさないため）。
  /勉強(?!会|の(?:予定|日程|スケジュール|場所|会場|集合|時間|範囲|持ち物))/,
  /宿題/,
  /自習/,
  /解き方/,
  /解いて/,
  /答えを教え/,
  /問題を解/,
  /教科書/,
  // やさしい日本語 / ひらがな
  // `べんきょう`（ひらがな）は kanji `勉強` と同様、掲示物文脈（勉強会 / 勉強の予定・場所等）だけを
  // negative lookahead で除外し対称化する（#401-2: kanji/hiragana 非対称の解消）。やさしい日本語の
  // 分かち書き（`べんきょうの よてい`）を吸収するため助詞 `の` 前後の空白を許容する。NFKC で全角空白は
  // 半角化済。`べんきょうの しかた`（学習依頼）は除外語に無いので引き続き study。
  /べんきょう(?!かい|\s*の\s*(?:よてい|にってい|ばしょ|かいじょう|しゅうごう|じかん|はんい|もちもの))/,
  /しゅくだい/,
  /こたえをおしえ/,
  // 英語
  /\bstudy\b/i,
  /\bstudying\b/i,
  /\bhomework\b/i,
  // `solve` は学習目的語（equation/exercise/homework 等）に束縛する。`solve my issue with the
  // printer` のような非学習の依頼を study 扱いしないため（#389 Reviewer M-2）。equation/homework は
  // 下の単独パターンでも捕捉される。変数解法 `solve for x` のみ別途許容。
  /\bsolve (?:this |that |these |the |my |your )?(?:equation|exercise|inequality|integral|worksheet|homework)\b/i,
  /\bsolve for [a-z]\b/i,
  /\bteach me (?:how|the|math|english|science|to solve)/i,
  // 教科語 + 学習名詞の共起で study とする。教科語で束縛するので `social studies`（社会科）や
  // `science fair`（掲示物イベント）は noun 側に無く誤検出しない（#401-1: 英語 recall を新偽陽性なしで拡張）。
  // `solve this chemistry problem` 等は `solve` 単独パターンに無くても本パターンで拾える。
  /\b(?:math|maths|algebra|geometry|calculus|physics|chemistry|biology|science|english|japanese|history|geography) (?:problem|question|exercise|worksheet)\b/i,
  // `assignment` は「席替え/部屋割り」(seating/room assignment = 掲示物) と曖昧。学習依頼を示す動詞
  // （do/finish/complete/help with）の直後に assignment が来る形だけ study にする。`the seating assignment`
  // は動詞直後に assignment が来ないので除外。締切質問 `when is the assignment due` も動詞非該当で in_scope（#401-1）。
  /\b(?:do|finish|complete|help (?:me )?with) (?:my |the |this |that |our )?assignment\b/i,
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
