import { expect, test } from "@playwright/test";
import { SEED, SEED2, isSignageDbAvailable } from "./global-setup";

/**
 * 公開サイネージ golden-path e2e (F0 #48-O 第 2 増分)。
 *
 * globalSetup (`./global-setup.ts`) が CI Postgres に migrate + seed (1 校 1 学年 1 クラス +
 * 有効 magic link + 当日 daily_data) した状態で、実ブラウザが `/signage/{KNOWN_TOKEN}` を開く。
 * これが #48-E (公開表示) / #48-G (Client Island) / #191 (階層マージ) の
 * token → resolveMagicLink → withTenantContext(RLS) → 階層マージ → 描画 を貫く真の end-to-end 証明。
 *
 * 堅牢性 (flaky 回避):
 *  - 固定 sleep を使わず `toBeVisible()` の auto-wait に委ねる。
 *  - セクションは aria-label (SignageClient の `<section aria-label="...">`) で role 指定 locate。
 *  - 広告ローテーションの **タイミングはアサートしない** (本 seed は広告無しなので対象外)。
 */
test.describe("公開サイネージ /signage/{token}", () => {
  // 実 DB が無い (未設定/placeholder) ローカル実行では globalSetup が seed をスキップするため、
  // 本 describe も skip して /login スモークだけ走らせる。CI は実 URL なので常に実行される。
  test.skip(
    !isSignageDbAvailable(process.env.DATABASE_URL),
    "DATABASE_URL 未設定/placeholder (signage は実 DB 必須)",
  );

  test("有効トークンで時間割/連絡/課題が描画される (golden path)", async ({ page }) => {
    await page.goto(`/signage/${SEED.KNOWN_TOKEN}`);

    // セクション見出し (時間割 / 連絡 / 課題) が出る = token 解決 + RLS + 階層マージが成立。
    await expect(page.getByRole("heading", { name: "時間割" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "連絡" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "課題" })).toBeVisible();

    // seed した識別文字列が各セクションに描画される (itemLabel が JSONB から拾う)。
    await expect(page.getByText(SEED.SCHEDULE_TEXT)).toBeVisible();
    await expect(page.getByText(SEED.NOTICE_TEXT)).toBeVisible();
    await expect(page.getByText(SEED.ASSIGNMENT_TEXT)).toBeVisible();
  });

  test("別校トークンは自校のコンテンツのみ描画する (RLS テナント分離)", async ({ page }) => {
    // webServer は kimiterrace_app (非 BYPASSRLS) 接続で動くため、これは RLS が効いた状態の検証。
    // SCHOOL2 の token → resolveMagicLink が SCHOOL2 に解決 → app.current_school_id=SCHOOL2 →
    // daily_data の tenant_isolation で SCHOOL2 の行のみ可視。
    await page.goto(`/signage/${SEED2.KNOWN_TOKEN}`);

    // SCHOOL2 の連絡は描画される。
    await expect(page.getByText(SEED2.NOTICE_TEXT)).toBeVisible();
    // SCHOOL1 の連絡は **一切出ない** (越境不可)。RLS がバイパスされていれば検知される。
    await expect(page.getByText(SEED.NOTICE_TEXT)).toHaveCount(0);
  });

  test("無効トークンは無効画面になる (コンテンツを出さない)", async ({ page }) => {
    await page.goto("/signage/bogus-invalid-token");

    // 無効画面 (SignageInvalid) の見出しが出る。
    await expect(page.getByRole("heading", { name: "表示できません" })).toBeVisible();
    // seed した識別文字列は無効トークンでは一切出ない (テナント越境・誤表示なし)。
    await expect(page.getByText(SEED.NOTICE_TEXT)).toHaveCount(0);
    // 有効時に必ず出る「時間割」セクション見出しも無効画面には無い。
    await expect(page.getByRole("heading", { name: "時間割" })).toHaveCount(0);
  });
});
