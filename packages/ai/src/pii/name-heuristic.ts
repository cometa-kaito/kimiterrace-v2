/**
 * F06 / #426 / ADR-030: 掲示物 authoring 時の「ロスター無し PII」(= 生徒/保護者の生氏名) 検出ガード
 * 用の**決定論ヒューリスティック検出器**。純関数・ReDoS 不能・推測のみ (確定マスクではない)。
 *
 * ## なぜ必要か (ADR-030 文脈)
 * 生徒/保護者は匿名設計 (ADR-003 / ADR-016 / #289) で「学校が保持する正規氏名 roster」の源泉が
 * 構造的に無い。そのため本文に**生で書かれた**生徒/保護者氏名 (例「田中さんが県大会で優勝」) は:
 * - `maskPII` の確定マスク対象外 (roster に無い)
 * - `findUnmaskedPii` の書式 PII (電話/メール) 検出にも掛からない
 * → マスクされず Vertex へ渡り embedding に焼き込まれうる (ルール4 の残存リスク)。
 *
 * ## 役割と限界
 * 本器は authoring 経路 (掲示物 publish の Server Action) の**上流 soft-gate** の検出部のみを担う。
 * ADR-030 の決定は **warn + 明示 override + 監査** (hard-block しない: FP で正当な掲示を阻害し回避策を
 * 誘発するため)。よって本器は「高確信・低 FP のパターンだけ」を抽出し、UI 警告/override/監査の配線は
 * 呼び出し側 (別スライス) が行う。完全な PII 排除は保証しない (= ADR-030 の Low 残存リスク)。
 *
 * ## 検出スコープ (slice 1: 高精度・低 FP を優先)
 * - 敬称は**ひらがな敬称** `さん` / `くん` / `ちゃん` に限定する。これらは学校掲示で生徒氏名に最も多く
 *   連接する高確信シグナルで、FP は少数の一般語に閉じる ({@link EXCLUDED_BASE} で抑制)。
 * - **漢字敬称 `君` / `様` は本スライスでは対象外 (deferred)**。漢字敬称は漢語複合語の接尾辞と衝突する
 *   (`諸君`/`暴君`、`模様`/`同様`/`仕様`/`市松模様`…)。氏名らしき部分を貪欲一致で取ると複合語の一部を
 *   掴むため、単純な除外辞書では曖昧性を解けない。これは ADR-030 が候補 C (ML-NER) を「FP/コスト計測後の
 *   follow-up」とした理由そのもの。漢字敬称の検出は辞書 or NER を持つ後続スライスで扱う。
 * - 氏名らしき部分は**漢字/カタカナに限定**。ひらがな名 (「さくらさん」) は「みなさん/おかあさん」等の
 *   一般語と決定論的に区別できず FP 源になるため意図的に対象外 (warn-only なので FN は掲示を壊さない)。
 *
 * ## 設計 (`mask.ts` と同じ防御規律)
 * - すべて**上限付き量化子 + 素な文字クラス**で線形時間評価 (untrusted な教員入力に毎回適用、ReDoS 排除)。
 * - 敬称は多言語拡張余地を残し定数化 (ADR-028 多言語化)。初期カバレッジは日本語ひらがな敬称。
 */

/**
 * 氏名らしき部分を構成しうる文字クラス。漢字 (CJK 統合漢字) + カタカナ + 反復記号 (々) +
 * 長音 (ー) + 小書きヶ。ひらがなは含めない (FP 抑制、上記設計参照)。
 */
const NAME_CHAR = "[\\u4E00-\\u9FFF\\u30A0-\\u30FF\\u3005\\u30FC\\u30F6]";

/**
 * 個人を指す高確信の敬称 (連接で氏名を示唆)。**ひらがな敬称のみ** (漢字敬称 `君`/`様` は複合語衝突の
 * ため deferred、上記スコープ参照)。長いもの優先で並べる (`ちゃん` を先頭)。多言語拡張時はここに
 * 各言語の呼称を足す。
 */
export const HONORIFICS = ["ちゃん", "さん", "くん"] as const;

/**
 * 敬称連接でも個人名でない一般語の「氏名相当部分」。検出ヒットの氏名部分がこの集合にあれば除外する。
 * **非網羅で構わない** (warn-only、ADR-030)。最頻出の親族・集合・学校集合語のみを抑える。残る職業 +
 * さん 等の少数 FP は warn を override 可能なため許容し、ADR-030 の再検討トリガ「override 件数監視」で
 * 調整する。
 */
export const EXCLUDED_BASE: ReadonlySet<string> = new Set([
  // 親族・呼称 (お母さん/赤ちゃん/兄ちゃん/坊ちゃん 等。「お」はひらがなで NAME_CHAR 外のため氏名部分は
  // 単漢字に縮む)
  "母",
  "父",
  "兄",
  "姉",
  "坊",
  "赤",
  // 集合・敬称一般 (皆さん/神さん/仏さん/お客さん)
  "皆",
  "神",
  "仏",
  "客",
  // 学校文脈の集合語 (生徒さん/児童/学生 等。個人名ではない)
  "生徒",
  "児童",
  "学生",
  "新入生",
  "卒業生",
  "在校生",
]);

/** 名前らしき部分の最大文字数 (姓 + 名の連結を許容しつつ、前方の漢語を巻き込む FP を抑える上限)。 */
const MAX_NAME_LEN = 5;

/**
 * 検出された「氏名らしき箇所」1 件。
 */
export interface SuspectedName {
  /** 原文での検出表層 (例 `"田中さん"`)。warn UI のハイライト用。 */
  surface: string;
  /** 氏名らしき部分 (敬称を除く、例 `"田中"`)。 */
  name: string;
  /** 連接した敬称 (例 `"さん"`)。 */
  honorific: string;
  /** 原文中の開始 index (UTF-16 オフセット)。 */
  index: number;
}

/**
 * 「氏名らしき部分 (漢字/カタカナ) + ひらがな敬称」を高確信パターンとして抽出する正規表現。
 *
 * - `(?<!NAME_CHAR)`: 氏名部分の途中から開始しない (語境界を担保し、前方の名前文字を巻き込まない)。
 * - `(NAME_CHAR{1,5})`: 氏名らしき部分 (上限付き = ReDoS 不能)。
 * - `(HONORIFICS)`: 固定のひらがな文字列の交替 (長いもの優先)。ひらがな敬称は NAME_CHAR と素なので
 *   氏名部分との境界が一意に定まる。
 */
const SUSPECT_RE = new RegExp(
  `(?<!${NAME_CHAR})(${NAME_CHAR}{1,${MAX_NAME_LEN}})(${HONORIFICS.join("|")})`,
  "g",
);

/**
 * テキスト中の「氏名 + 敬称」の高確信箇所を返す。確定ではなく**警告候補**である点に注意 (ADR-030)。
 * 一般語は {@link EXCLUDED_BASE} で除外する。検出ゼロなら空配列。
 *
 * @param text 掲示物本文などの自由入力。
 */
export function findSuspectedPersonalNames(text: string): SuspectedName[] {
  const out: SuspectedName[] = [];
  for (const m of text.matchAll(SUSPECT_RE)) {
    const [surface, name, honorific] = m;
    // 2 つのキャプチャグループは一致時に必ず存在するが、noUncheckedIndexedAccess 下では
    // `string | undefined` になるため明示ガードで絞る (as / ! を使わない、ルール3)。
    if (
      surface === undefined ||
      name === undefined ||
      honorific === undefined ||
      m.index === undefined
    ) {
      continue;
    }
    if (EXCLUDED_BASE.has(name)) continue;
    out.push({ surface, name, honorific, index: m.index });
  }
  return out;
}

/**
 * 警告候補が 1 件でもあれば `true`。soft-gate の発火判定用 (件数列挙が不要な場合の軽量版)。
 */
export function hasSuspectedPersonalName(text: string): boolean {
  // 最初の非除外ヒットで打ち切る。
  for (const m of text.matchAll(SUSPECT_RE)) {
    const name = m[1];
    if (name !== undefined && !EXCLUDED_BASE.has(name)) return true;
  }
  return false;
}

/**
 * 検出した「氏名 + 敬称」の**氏名部分のみ**を伏字 (●●) にし敬称は残す (例 `"田中さん"`→`"●●さん"`)。
 * ADR-030 の warn-only ヒューリスティックを「表示 / Vertex 送信前の best-effort 伏字」として使う薄い
 * ラッパ。**確定マスクではない**（漢字敬称 `君`/`様`・ひらがな名は対象外）＝保証ではなく**低減**。
 * 純関数・ReDoS 不能（{@link findSuspectedPersonalNames} 同様）。後方から置換し index ずれを防ぐ。
 */
export function redactSuspectedNames(text: string): string {
  let out = text;
  for (const s of [...findSuspectedPersonalNames(text)].sort((a, b) => b.index - a.index)) {
    out = `${out.slice(0, s.index)}●●${s.honorific}${out.slice(s.index + s.surface.length)}`;
  }
  return out;
}
