/**
 * F06 / ルール4 / ADR-030: 掲示物 authoring 時の **ロスター無し PII（生徒・保護者氏名）** 検出ヒューリスティック。
 *
 * ## 背景（#426 / ADR-030）
 * 生徒・保護者は匿名設計（ADR-003 / ADR-016 / #289）のため「学校が保持する正規氏名 roster」の源泉が
 * 構造的に無く、掲示物本文に生で書かれた生徒氏名は `maskPII` の確定マスク（roster 由来）にも
 * `findUnmaskedPii` の書式検出（電話・メール）にも掛からず、マスクされず Vertex に渡って embedding に
 * 焼き込まれうる。embedding は永続するため回収困難（{@link ./mask.ts}）。
 *
 * 本モジュールは ADR-030 が採用した **候補 B = 決定論ヒューリスティック soft-gate** の検出器（slice 1）。
 * authoring の Server Action がこれを呼び、検出時は **warn + 明示 override + 監査**（hard-block しない）を
 * 行う想定（soft-gate の配線は後続スライス）。下流の embedding バッチ fail-closed を置換せず、その**上流の
 * 追加層**である。
 *
 * ## 設計方針
 * - **高 precision を優先**（ADR-030: warn 自体の偽陽性を低く保つ。誤検出で正当な掲示を warn 連発すると
 *   投稿者が override を機械的に押し統制が形骸化する）。recall は意図的に部分的で、敬称無しの生氏名や
 *   単漢字姓は取りこぼす（ADR-030 が Low 残存リスクとして受容、運用ポリシー C4 で補完）。
 * - **敬称連接パターン**に限定: 氏名らしき 2〜4 文字の **漢字／カタカナ**連続トークン + 個人敬称
 *   （さん・くん・ちゃん・君・様・氏・先輩）。「お母さん」「皆さん」「神様」等は氏名部が 1 文字
 *   （お/皆/神 の直後が敬称、ひらがな `お` は連続トークンを分断）になるため {2,4} 制約で自然に除外される。
 * - **役職・組織語の除外**: 「店員さん」「サッカー部さん」「三年さん」のような 2 文字以上の一般語は、
 *   明示除外集合 + 末尾が組織/集団を示す字（部・組・年・会・室…）の語を弾く。除外集合は curate して拡張する。
 * - **決定論・ReDoS 不能**: NFKC 正規化 + 上限付き量化子（`{2,4}`）+ 素な文字クラスのみ。untrusted な
 *   authoring 入力に毎回適用するため、`maskPII` と同じ ReDoS 排除規律（{@link ./mask.ts}）に従う。
 * - **多言語拡張余地**（ADR-028 / ADR-030）: 初期カバレッジは日本語敬称。主要外国語の呼称は後続スライスで
 *   `HONORIFICS` を拡張する構成（言語別パターンは別途確定）。
 *
 * 本検出器は **掲示物本文の生氏名を warn する**ためのもの。roster 由来の確実な PII は `maskPII` が確定
 * マスクし、書式 PII は `findUnmaskedPii` が fail-closed で止める（責務分離）。
 */

/** 個人敬称（高確信）。氏名直後に付くと「特定個人の指名」を強く示す。役職敬称「先生」は staff/役割語との
 * 曖昧さ（roster マスク済 or 一般役割）が大きいため初期セットから除外する。 */
const HONORIFICS = ["さん", "くん", "ちゃん", "君", "様", "氏", "先輩"] as const;

/**
 * 氏名らしき連続トークン: 漢字（CJK 統合漢字）/ カタカナ（長音符含む）2〜4 文字。
 * - ひらがなを含めない: 「おばあさん」「おにいさん」等のひらがな親族語の偽陽性を構造的に避ける
 *   （ひらがな単独の与え名は取りこぼすが warn 級では許容、ADR-030）。
 * - {2,4}: 単漢字の一般語（神・皆・客・母…）+ 敬称の偽陽性を除外（単漢字姓も取りこぼすが Low）。
 */
const NAME_TOKEN = "[\\u4E00-\\u9FFF\\u30A0-\\u30FF\\u30FC]{2,4}";

/** `(氏名)(敬称)` を機械検出する線形時間パターン（上限付き量化子 + 素集合 = ReDoS 不能）。 */
const HONORIFIC_NAME_RE = new RegExp(`(${NAME_TOKEN})(${HONORIFICS.join("|")})`, "g");

/**
 * 氏名部が一致しても氏名でない一般語（役職・職業・呼称）。氏名部の完全一致で除外する。
 * 2 文字以上で {2,4} を通過してしまうものを curate（単漢字語は {2,4} 制約で既に除外済）。
 */
const COMMON_NON_NAME = new Set<string>([
  // 職業・役職
  "店員",
  "駅員",
  "係員",
  "店長",
  "社長",
  "部長",
  "課長",
  "係長",
  "校長",
  "教頭",
  "主任",
  "顧問",
  "監督",
  "選手",
  "警官",
  "隊長",
  "班長",
  "会長",
  // 集団・関係語
  "皆様", // 念のため（皆 は 1 文字だが将来 {1,4} 化に備える）
  "生徒",
  "児童",
  "保護者",
  "友達",
  "仲間",
  "相手",
  "本人",
  "各位",
  "全員",
  // カタカナ一般語
  "コーチ",
  "ドクター",
  "スタッフ",
  "メンバー",
  "チーム",
  "リーダー",
]);

/**
 * 氏名部の **末尾字** がこれらなら組織/集団/数量の参照とみなし除外する
 * （「サッカー部さん」「三年さん」「一組さん」「実行委さん」等）。
 */
const ORG_TAIL = new Set<string>([
  "部",
  "組",
  "年",
  "会",
  "室",
  "課",
  "係",
  "号",
  "番",
  "階",
  "店",
  "館",
  "校",
  "園",
  "隊",
  "班",
  "委",
  "組合",
  // 「員」で終わる職業・所属語（会員・社員・職員・議員・部員…）。氏名で「員」終わりは実質皆無なので安全。
  "員",
]);

/** 検出された 1 件。warn UI でのハイライトに使えるよう表層・氏名部・敬称・位置を返す。 */
export interface HonorificNameDetection {
  /** マッチした氏名+敬称の表層形（例 `田中さん`）。 */
  surface: string;
  /** 氏名部（例 `田中`）。 */
  name: string;
  /** 敬称（例 `さん`）。 */
  honorific: string;
  /** NFKC 正規化後テキストでの開始位置（warn のハイライト用）。 */
  index: number;
}

/**
 * 掲示物本文から **敬称連接の氏名らしき表層** を検出する（決定論・高 precision）。
 *
 * roster に無い生徒/保護者氏名を authoring 時に warn するための soft-gate 検出器。空配列なら
 * 「高確信の氏名は検出されず」（= 敬称無しの生氏名等は取りこぼしうる、ADR-030 の Low 残存リスク）。
 *
 * @param input authoring 中の掲示物本文（マスキング前後どちらでも判定可能）。
 * @returns 検出配列（出現順、重複表層も位置ごとに列挙）。
 */
export function findHonorificNames(input: string): HonorificNameDetection[] {
  // NFKC: 全角英数字・記号を正規化（漢字・かなは不変）。全角偽装での回避を塞ぎ mask.ts と挙動を揃える。
  const normalized = input.normalize("NFKC");

  const detections: HonorificNameDetection[] = [];
  HONORIFIC_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null = HONORIFIC_NAME_RE.exec(normalized);
  while (m !== null) {
    const [surface, name, honorific] = m as unknown as [string, string, string];
    if (!isExcluded(name)) {
      detections.push({ surface, name, honorific, index: m.index });
    }
    m = HONORIFIC_NAME_RE.exec(normalized);
  }
  return detections;
}

/** 氏名部が一般語（職業/役職/集団/組織参照）なら true。高 precision のための偽陽性フィルタ。 */
function isExcluded(name: string): boolean {
  if (COMMON_NON_NAME.has(name)) return true;
  // 末尾字が組織/集団/数量参照（「〜部」「〜組」「〜年」…）なら氏名でない。
  const tail1 = name.slice(-1);
  const tail2 = name.slice(-2);
  return ORG_TAIL.has(tail1) || ORG_TAIL.has(tail2);
}
