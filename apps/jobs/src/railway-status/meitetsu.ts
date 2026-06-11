/**
 * 名鉄（笠松駅）運行情報ページ `https://top.meitetsu.co.jp/em/` の **純粋パーサ**（ADR-035）。HTML 文字列
 * から「運行情報メッセージ + 乱れの有無」を抽出する。ネットワーク非依存・副作用なしで単体テスト可能。
 *
 * ## 方針（heuristic・fail-soft）
 * 名鉄公式は**非公式・無保証**で HTML 構造が変わりうる（ADR-035 §残存リスク）。特定の tag/class に依存せず、
 * **タグを除去したテキスト**から文単位で運行情報文を拾う（構造変化に比較的強い）。優先順:
 *   1. **正常マーカー**（「遅れはございません」「平常運転」等）を含む文があれば **平常**（最も確実）。
 *   2. 無ければ**乱れキーワード**（遅延 / 運転見合わせ / 運休 等）を含む文を **乱れ**として拾う。ただし
 *      「遅延**証明書**」等の誤検出は除外。
 *   3. どちらも無ければ `null`（認識できる運行情報文が無い → 取得 Job は upsert せず last-known を維持）。
 */

export type ParsedTrainStatus = {
  /** 運行に乱れがあるか（false = 平常）。 */
  hasDisruption: boolean;
  /** 運行情報メッセージ本文（盤面に出す。500 文字に丸める）。 */
  statusText: string;
};

/** 平常を示すマーカー（含めば平常運転と判定。最優先）。 */
const NORMAL_MARKERS = ["遅れはございません", "平常運転", "平常どおり", "平常通り", "通常通り運転"];

/**
 * 運行の乱れを示すキーワード。「遅延」は広めに拾うが、「遅延証明書」等は下の DISRUPTION_EXCLUDES で除外する。
 * 平常文（「遅れはございません」等）は NORMAL_MARKERS が**先**に判定するので、ここに乱れ語があっても誤らない。
 */
const DISRUPTION_KEYWORDS = [
  "遅延",
  "遅れが発生",
  "遅れが出",
  "運転を見合わせ",
  "運転見合わせ",
  "見合わせ",
  "運休",
  "直通運転中止",
  "ダイヤが乱れ",
  "ダイヤ乱れ",
  "折返し運転",
  "折り返し運転",
  "運転を再開",
];

/** 乱れキーワードを含んでも運行の乱れではない（誤検出を除外する）語。 */
const DISRUPTION_EXCLUDES = ["証明", "について", "確認方法", "とは"];

const MAX_LEN = 500;

/** HTML 実体参照 → 文字。**1 パス復号**用（`&amp;` を先に戻すと `&amp;lt;` が `<` に二重復号される問題を避ける）。 */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  "#8203": "",
};

/**
 * HTML をプレーンテキスト化する。**各タグを改行に置換**してブロック境界（見出し / 段落）を保ち、見出し
 * 「列車運行情報」等が運行情報本文と 1 文に混ざらないようにする（script/style ブロック除去・実体参照を
 * 1 パス復号・行内空白圧縮・空行圧縮）。
 */
function htmlToText(html: string): string {
  return (
    html
      // script/style はブロックごと除去。閉じタグは `</script >`（空白入り）や大文字も拾う（\b + \s*）。
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "\n")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "\n")
      // 実体参照は 1 パスで復号（二重復号を避ける。`&amp;` を個別に先に戻さない）。
      .replace(/&(amp|lt|gt|nbsp|#8203);/gi, (m, e: string) => HTML_ENTITIES[e.toLowerCase()] ?? m)
      .replace(/[ \t　]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n+/g, "\n")
      .trim()
  );
}

/**
 * テキストを **改行 と 「。」** の両方で分節し（ブロック境界 + 文境界）、いずれかの marker を含み exclude を
 * 含まない最初の分節を返す。
 */
function firstSentenceWith(
  text: string,
  markers: readonly string[],
  excludes: readonly string[] = [],
): string | null {
  for (const raw of text.split(/\n+|(?<=。)/)) {
    const s = raw.trim();
    if (s.length === 0) {
      continue;
    }
    if (markers.some((m) => s.includes(m)) && !excludes.some((e) => s.includes(e))) {
      return s;
    }
  }
  return null;
}

/**
 * 名鉄運行情報ページの HTML から現況を抽出する。認識できる運行情報文が無ければ `null`（Job は skip）。
 */
export function parseMeitetsuStatus(html: string): ParsedTrainStatus | null {
  const text = htmlToText(html);
  if (text.length === 0) {
    return null;
  }
  // 1) 正常マーカー優先（最も確実）。
  const normal = firstSentenceWith(text, NORMAL_MARKERS);
  if (normal) {
    return { hasDisruption: false, statusText: normal.slice(0, MAX_LEN) };
  }
  // 2) 乱れキーワード（遅延証明書 等は除外）。
  const disruption = firstSentenceWith(text, DISRUPTION_KEYWORDS, DISRUPTION_EXCLUDES);
  if (disruption) {
    return { hasDisruption: true, statusText: disruption.slice(0, MAX_LEN) };
  }
  // 3) 認識できる運行情報文が無い → null（呼び出し側が upsert せず last-known を維持）。
  return null;
}
