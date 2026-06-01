import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdReachByAd, MonthlySchoolSummary } from "@kimiterrace/db";
import PDFDocument from "pdfkit";

/**
 * F09 (#45): 月次レポート **PDF レンダラ** (第1スライス: データ → PDF Buffer の純関数)。
 *
 * F07 (#43) が `events` に記録した行動ログを F08/F09 の集計層 (`getMonthlySchoolSummary` /
 * `getMonthlyAdReach`) が **JST 暦月**で畳んだ read モデルを、pdfkit で 1 校 1 か月分の PDF へ描画する。
 * 既存の CSV シリアライザ (`apps/web/lib/reports/csv.ts` の `monthlySummaryToCsv`) と**同じ入力**
 * (`MonthlySchoolSummary` + `AdReachByAd[]`) を取り、紙/対面配布に向く版面 (見出し・期間・指標サマリー・
 * コンテンツ反応ランキング・広告別 到達数) を作る。F09 受け入れ条件「PDF テンプレートは pdfkit」に対応。
 *
 * ## スコープ (この第1スライス)
 * **純関数 (データ → Buffer) のみ**。Cloud Storage 保存・90 日コールド移送・Cloud Run Job entrypoint・
 * 校列挙ドライバ (system_admin 列挙 → school_admin 降格)・`monthly_reports` 履歴記録・Terraform/月初
 * スケジュール・apps/web の DL 導線は後続スライス (follow-up)。本モジュールは DB / I/O / 認可を持たず、
 * 集計済みデータと (任意で) フォント Buffer だけを受け取る。
 *
 * ## 型の単一ソース (ルール3)
 * 入力型 `MonthlyReportPdfData` は手書きの二重定義をせず、`@kimiterrace/db` がスキーマ/クエリ戻り型
 * (`InferSelectModel` 派生) からエクスポートする `MonthlySchoolSummary` (totals/ranking/activeDays) と
 * `AdReachByAd[]` (広告別 到達数 + caption) を**合成**して定義する。集計の形が変われば DB 型経由で
 * ここにも伝播する。`schoolName` のみ呼び出し側 (校列挙ドライバ) が `schools.name` から渡す。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 入力は件数 (整数)・content タイトル・稼働日数・広告 caption のみで、`events.payload` の匿名 clientId 等を
 * 含まない (集計層がそう作る)。PDF も同じ粒度しか描画せず、個人を再識別しうる値は出さない。校名・content
 * タイトル・広告 caption は同一 school の信頼ドメイン内の値だが、いずれもページに文字列として埋め込むだけで
 * 数式評価のような副作用はない (PDF は CSV と異なり formula injection の面は持たない)。
 *
 * ## 指標の意味 (ADR-025)
 * 「延べ表示数 (engagement)」(`totals.view` = `count(*)`) と「到達数 (reach)」(`(client_id, ad_id, JST 分)`
 * で集計時 minute-dedup 済) は**別指標**。広告別の値は到達数 (reach) を出し、延べ件数を到達数として出さない。
 *
 * ## 日本語フォント
 * pdfkit 既定の Helvetica は CJK グリフを持たない。Noto Sans JP (SIL OFL 1.1、再配布可) Regular を
 * `apps/jobs/assets/fonts/NotoSansJP-Regular.otf` に同梱し `doc.registerFont` で埋め込む。テスト容易性の
 * ため、フォントは `opts.font` で**注入**でき、未指定時のみ同梱アセットを `loadDefaultJpFont()` で読む。
 */

/** PDF 1 枚分の入力 (集計済み read モデル + 表示メタ)。DB 型から合成 (ルール3)。 */
export type MonthlyReportPdfData = {
  /** 学校名 (`schools.name`)。校列挙ドライバが RLS スコープで解決して渡す。 */
  schoolName: string;
  /** 学校別 月次サマリー (対象年月・view/tap/ask 総数・content ランキング・稼働日数)。 */
  summary: MonthlySchoolSummary;
  /** 広告別 到達数 (reach、minute-dedup) + caption ラベル。空配列可。 */
  adReach: AdReachByAd[];
};

/** `renderMonthlyReportPdf` の任意オプション。 */
export type RenderMonthlyReportPdfOptions = {
  /**
   * 埋め込む日本語フォント (TTF/OTF) の Buffer。未指定なら同梱の Noto Sans JP を `loadDefaultJpFont()`
   * で読む。テストや差し替え用に注入できる。CJK を含まない ASCII 専用フォントを渡すと日本語が
   * 描画できないため、本番では同梱フォント (既定) か CJK 対応フォントを使うこと。
   */
  font?: Buffer;
};

/** caption 未設定 / 削除済 広告の表示名 (CSV / 画面 `/admin/reports` と揃える)。 */
const UNTITLED_AD_LABEL = "（無題の広告）";

/** pdfkit に登録するフォント名 (内部参照用の論理名)。 */
const JP_FONT_NAME = "NotoSansJP";

/** A4・本文の基本サイズ (pt)。 */
const PAGE_MARGIN = 50;
const TITLE_SIZE = 22;
const SECTION_SIZE = 14;
const BODY_SIZE = 11;

/**
 * 同梱の Noto Sans JP (Regular, OTF) を Buffer で読む。
 *
 * バンドル後 (Turbopack / Cloud Run Job) でもアセットを見失わないよう、まず `import.meta.url` 起点の
 * 相対解決を試し、解決できなければ `process.cwd()` 起点 (`apps/jobs/...`) にフォールバックする
 * ([[bundled-runtime-asset-resolution]])。どちらでも見つからなければ明示的に投げる (サイレント空 PDF や
 * 文字化けを避け、follow-up のアセット配置漏れを早期に検出する)。
 */
export function loadDefaultJpFont(): Buffer {
  const rel = ["assets", "fonts", "NotoSansJP-Regular.otf"];
  const candidates = [
    // import.meta.url 起点: src/reports/pdf.ts → apps/jobs ルートへ 2 段上がる。
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...rel),
    // cwd 起点フォールバック (Cloud Run Job の実行ディレクトリが apps/jobs のとき)。
    join(process.cwd(), ...rel),
    // monorepo ルートから実行された場合。
    join(process.cwd(), "apps", "jobs", ...rel),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path);
    }
  }
  throw new Error(
    `Noto Sans JP font not found. Looked in: ${candidates.join(", ")}. ` +
      "Ensure apps/jobs/assets/fonts/NotoSansJP-Regular.otf is shipped, or pass opts.font.",
  );
}

/** 広告 caption を表示ラベルへ (未設定 / 削除済 null は無題ラベル)。 */
function adLabel(caption: string | null): string {
  return caption ?? UNTITLED_AD_LABEL;
}

/**
 * 月次レポート (1 校 1 か月分) を pdfkit で描画し PDF を Buffer で返す純関数。
 *
 * 版面は「見出し (校名 + 対象月) → 集計基準 → 指標サマリー (延べ表示/タップ/Q&A/稼働日数) →
 * コンテンツ反応ランキング → 広告別 到達数」。ランキング・到達数が空でも見出しは描き、版面構造を一定に
 * 保つ。数値は半角でラベル付きで描く (色のみに依存しない / NFR05)。
 *
 * @param data 集計済みデータ + 校名 (`MonthlyReportPdfData`)。
 * @param opts.font 埋め込む日本語フォント Buffer (未指定なら同梱 Noto Sans JP)。
 * @returns 先頭 `%PDF-` の有効な PDF バイト列。
 */
export function renderMonthlyReportPdf(
  data: MonthlyReportPdfData,
  opts: RenderMonthlyReportPdfOptions = {},
): Promise<Buffer> {
  const font = opts.font ?? loadDefaultJpFont();
  const { schoolName, summary, adReach } = data;

  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    info: { Title: `月次レポート ${summary.year}年${summary.month}月`, Author: "キミテラス" },
  });
  // 既定 Helvetica は CJK 不可。最初に日本語フォントを登録し本文フォントに据える。
  doc.registerFont(JP_FONT_NAME, font);
  doc.font(JP_FONT_NAME);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // --- 見出し ---
  doc.fontSize(TITLE_SIZE).text("月次レポート");
  doc.moveDown(0.3);
  doc.fontSize(BODY_SIZE).text(schoolName);
  doc.text(`対象月: ${summary.year}年${summary.month}月`);
  doc.text("集計基準: 日本時間(JST) 暦月");
  doc.moveDown();

  // --- 指標サマリー ---
  doc.fontSize(SECTION_SIZE).text("活動サマリー");
  doc.moveDown(0.3);
  doc.fontSize(BODY_SIZE);
  doc.text(`延べ表示数 (engagement): ${summary.totals.view}`);
  doc.text(`タップ (tap): ${summary.totals.tap}`);
  doc.text(`Q&A (ask): ${summary.totals.ask}`);
  doc.text(`稼働日数: ${summary.activeDays}`);
  doc.moveDown();

  // --- コンテンツ反応ランキング ---
  doc.fontSize(SECTION_SIZE).text("コンテンツ反応ランキング");
  doc.moveDown(0.3);
  doc.fontSize(BODY_SIZE);
  if (summary.ranking.length === 0) {
    doc.text("（対象月の反応はありません）");
  } else {
    summary.ranking.forEach((row, i) => {
      doc.text(
        `${i + 1}. ${row.title}  —  表示 ${row.views} / タップ ${row.taps} / 合計 ${row.total}`,
      );
    });
  }
  doc.moveDown();

  // --- 広告別 到達数 (reach) ---
  doc.fontSize(SECTION_SIZE).text("広告別 到達数 (reach)");
  doc.moveDown(0.3);
  doc.fontSize(BODY_SIZE);
  if (adReach.length === 0) {
    doc.text("（対象月の広告到達はありません）");
  } else {
    for (const ad of adReach) {
      doc.text(`${adLabel(ad.caption)}: ${ad.reach}`);
    }
  }

  doc.end();
  return done;
}
