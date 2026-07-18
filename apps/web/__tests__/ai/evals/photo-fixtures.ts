/**
 * P1 写真取込 eval 用の **合成画像フィクスチャ**（設計 D8・PII ゼロ）。
 *
 * `packages/ai/src/extract/__tests__/fixtures/build-fixtures.ts` と同じ哲学 — commit 済み binary
 * ではなく**レビュー可能なプログラム生成**（HTML ソースが下にそのまま見える）。教員が実際に撮る
 * 「紙のプリント」3 類型（学年通信風・時間割変更風・持ち物連絡風）を HTML で組み、Playwright
 * （既存 devDependency）の headless Chromium で PNG にレンダリングする。
 *
 * - **PII ゼロ（ルール4）**: 氏名・電話・メール・住所を一切含めない（実 Vertex に送る評価素材のため。
 *   `photo-fixtures.test.ts` が本番と同じ検出器で常時回帰検査する）。学校名・組は架空。
 * - **日付は決定的**: 既存 eval の基準日 {@link "./cases-assistant".FIXED_NOW_MS}（2026-07-06 月）を
 *   前提に、system プロンプトの 14 日対応表（jstUpcomingDateTable）内の実在日付だけを使う。
 * - レンダリングは RUN_AI_EVAL ゲート内でのみ実行される（CI はブラウザ不要）。Playwright の import は
 *   遅延にして、ケース定義の収集（vitest collection）でブラウザ依存を持ち込まない。
 * - 限界: クリーンなレンダリング画像であり、実写真の歪み・影・ボケは含まない（v1 はパイプライン精度の
 *   計測が目的。実写 robustness は実機検証で別途見る）。
 */

export type PhotoFixtureId = "grade-newsletter" | "timetable-change" | "belongings-notice";

/** 3 類型共通の紙面スタイル（A4 縦・明朝/ゴシック混在の学校プリント風）。 */
const SHEET_STYLE = `
  <style>
    body { margin: 0; background: #f2f0eb; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", sans-serif; }
    .sheet { width: 760px; margin: 24px auto; padding: 48px 56px; background: #fff; color: #1a1a1a; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
    h1 { font-size: 28px; text-align: center; margin: 0 0 4px; letter-spacing: .1em; }
    .meta { display: flex; justify-content: space-between; font-size: 13px; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; margin-bottom: 20px; }
    h2 { font-size: 18px; margin: 24px 0 8px; padding: 2px 8px; border-left: 6px solid #444; }
    p, li { font-size: 15px; line-height: 1.9; }
    table { border-collapse: collapse; width: 100%; font-size: 15px; }
    th, td { border: 1px solid #333; padding: 8px 10px; text-align: left; }
    th { background: #e8e8e8; font-weight: 600; }
    .note { font-size: 13px; margin-top: 20px; }
  </style>`;

/**
 * 各フィクスチャの HTML（= 画像の中身の正本。ここを読めば期待値の根拠が全部わかる）。
 * 期待値（cases-photo-extraction.ts）と 1:1 で対応させ、期待に写像されない飾り情報を足さない
 * （余計な行は「余計な項目が無い」チェックのノイズになる）。
 */
export const PHOTO_FIXTURES: Record<PhotoFixtureId, { title: string; html: string }> = {
  // ── 類型1: 学年通信風（来週の予定 = 複数日 → days 振り分けを測る） ──
  "grade-newsletter": {
    title: "学年通信（来週の予定・複数日）",
    html: `${SHEET_STYLE}
      <div class="sheet">
        <h1>２学年 学年通信</h1>
        <div class="meta"><span>第14号　2026年7月6日発行</span><span>みなみ野高校 ２学年</span></div>
        <h2>来週の主な予定</h2>
        <table>
          <tr><th>日付</th><th>予定</th></tr>
          <tr><td>7月13日（月）</td><td>実力テスト（1限 国語・2限 数学・3限 英語）</td></tr>
          <tr><td>7月15日（水）</td><td>体育祭予行。体操服を持参してください。</td></tr>
          <tr><td>7月17日（金）</td><td>三者懇談のため午前授業となります。</td></tr>
        </table>
        <p class="note">※予定は変更になる場合があります。</p>
      </div>`,
  },

  // ── 類型2: 時間割変更風（明日 1 日ぶんの時限表 → 別日 days + 時限抽出を測る） ──
  "timetable-change": {
    title: "時間割変更のお知らせ（明日・6 時限）",
    html: `${SHEET_STYLE}
      <div class="sheet">
        <h1>時間割変更のお知らせ</h1>
        <div class="meta"><span>2026年7月6日</span><span>みなみ野高校 ２年１組</span></div>
        <p>7月7日（火）の時間割は、次のとおり変更になります。</p>
        <h2>変更後の時間割（7月7日・火曜日）</h2>
        <table>
          <tr><th>時限</th><th>教科</th><th>場所</th></tr>
          <tr><td>1限</td><td>体育</td><td>体育館</td></tr>
          <tr><td>2限</td><td>国語</td><td>教室</td></tr>
          <tr><td>3限</td><td>理科</td><td>理科室</td></tr>
          <tr><td>4限</td><td>英語</td><td>教室</td></tr>
          <tr><td>5限</td><td>音楽</td><td>音楽室</td></tr>
          <tr><td>6限</td><td>総合</td><td>教室</td></tr>
        </table>
        <p class="note">※1限に体育があるため、体操服を忘れずに持ってきてください。</p>
      </div>`,
  },

  // ── 類型3: 持ち物連絡風（特定日の校外学習 → 連絡 1 件への集約を測る） ──
  "belongings-notice": {
    title: "校外学習の持ち物連絡（特定日）",
    html: `${SHEET_STYLE}
      <div class="sheet">
        <h1>校外学習のお知らせ</h1>
        <div class="meta"><span>2026年7月6日</span><span>みなみ野高校 ２年１組</span></div>
        <p>7月8日（水）に科学館へ校外学習に行きます。当日は 8時30分 に昇降口前に集合してください。</p>
        <h2>持ち物</h2>
        <ul>
          <li>弁当</li>
          <li>水筒</li>
          <li>雨具</li>
          <li>筆記用具</li>
        </ul>
        <p class="note">※雨天決行です。</p>
      </div>`,
  },
};

/**
 * HTML から可視テキストを取り出す（PII 回帰検査・レビュー用。style/タグを落とすだけの素朴実装）。
 * ⚠ HTML エンティティ（&amp;amp; 等）は復号しない。フィクスチャ本文にエンティティ表記を使うと
 * PII 検査対象のテキストが画像の見た目と食い違うため、フィクスチャは生文字で書くこと。
 */
export function photoFixtureText(id: PhotoFixtureId): string {
  return PHOTO_FIXTURES[id].html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** フィクスチャを PNG レンダリングするハンドル（1 ブラウザを全ケースで使い回す）。 */
export interface PhotoFixtureRenderer {
  render(id: PhotoFixtureId): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Playwright Chromium を起動してレンダラを返す（RUN_AI_EVAL ゲート内でのみ呼ぶこと）。
 * `@playwright/test` は遅延 import（vitest のケース収集時にブラウザ依存を読み込まない）。
 * deviceScaleFactor=2 で実写真相当の解像度（約 1700px 幅）を確保する（OCR の入力条件を現実に寄せる）。
 */
export async function createPhotoFixtureRenderer(): Promise<PhotoFixtureRenderer> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 860, height: 1200 },
    deviceScaleFactor: 2,
  });
  return {
    async render(id: PhotoFixtureId): Promise<Uint8Array> {
      await page.setContent(PHOTO_FIXTURES[id].html, { waitUntil: "load" });
      return new Uint8Array(await page.screenshot({ type: "png", fullPage: true }));
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}
