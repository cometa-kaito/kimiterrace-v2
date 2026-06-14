import { expect, test } from "@playwright/test";
import { SEED, TEACHER_STORAGE_STATE, isSignageDbAvailable } from "./global-setup";

/**
 * 完全 golden-path e2e (F0 #48-O **第 4 増分 = 最終**): ログイン → 教員がエディタで連絡を更新 →
 * 公開サイネージにその更新が反映される、を **1 本の e2e で貫く**。
 *
 * これまでの増分が確立した土台の上に「その間を繋ぐ」最後の一手:
 *   - 増分 3 (PR #224): 教員ログイン到達 (`auth.setup.ts` の認証済み storageState + `/admin` 到達)。
 *   - 増分 2 (signage.spec.ts): 公開サイネージ描画 (`/signage/{token}` の token→RLS→階層マージ→描画)。
 *   - 本増分: **教員のエディタ入力が公開サイネージに反映される**ことを end-to-end で実証。
 *
 * 経路 (app コードは一切変更しない、既存実装をそのまま駆動して検証する):
 *   1. 認証済み教員コンテキスト (storageState) で `/app/editor/{SEED.GOLDEN_CLASS_ID}` を開く。
 *      エディタは既定で **JST 今日**を対象日にする (page.tsx)。signage も今日を表示するため日付一致。
 *      → middleware(cookie) → requireRole(EDITOR_ROLES) → withSession(RLS, school 境界) を通過。
 *      教員の school_id = SEED.SCHOOL_ID、GOLDEN_CLASS_ID は同一校なので編集可。signage.spec.ts と
 *      クラスを分離し、本テストの破壊的 UPDATE が他テストに干渉しないようにする。
 *   2. NoticeEditor を駆動して連絡を **一意な識別文字列**に更新し保存 (`setClassNoticesAction`)。
 *      保存完了の UI 反映 ("保存しました。") を auto-wait で待つ (固定 sleep 禁止)。
 *   3. `/signage/{SEED.KNOWN_TOKEN}` を**新規ナビゲーション**で開く (force-dynamic で最新取得)。
 *      更新した識別文字列が連絡セクションに visible = 教員入力がサイネージに反映された。
 *
 * 堅牢性 (flaky 回避): 一意文字列 + auto-wait のみ (ネットワーク/時刻に依存しない)。
 */

/** この e2e でのみ使う一意な連絡文字列。seed の SEED.NOTICE_TEXT を editor 更新で置換する。 */
const GOLDEN_NOTICE_TEXT = "GOLDEN-PATH-NOTICE-REFLECTED";

// emulator / 実 DB が無いローカル実行では auth.setup が skip され storageState が無いので本 spec も skip。
// CI (emulator + postgres service) では必ず実行される (偽 green 回避: skip 条件を実環境と一致させる)。
const authAvailable =
  !!process.env.FIREBASE_AUTH_EMULATOR_HOST && isSignageDbAvailable(process.env.DATABASE_URL);

test.describe("完全 golden path — 教員エディタ更新 → サイネージ反映", () => {
  test.skip(!authAvailable, "FIREBASE_AUTH_EMULATOR_HOST 未設定 / DATABASE_URL placeholder");

  // admin-auth.spec.ts と同じく認証済み教員の storageState を使う (chromium project に乗る)。
  test.use({ storageState: TEACHER_STORAGE_STATE });

  test("教員がエディタで更新した連絡が公開サイネージに反映される", async ({ page }) => {
    // 1. 認証済み教員で **golden-path 専用クラス**のエディタを開く (既定で JST 今日 = signage と一致)。
    //    専用クラスにするのは、本テストが連絡を破壊的 UPDATE するため signage.spec.ts の共有クラスと
    //    fullyParallel 下で干渉させないため (PR #233 Reviewer Medium-1)。
    await page.goto(`/app/editor/${SEED.GOLDEN_CLASS_ID}`);
    // UI 刷新 (PR #876): クラスエディタはタブ shell になり既定は「AIで作る」(会話型) タブ。盤面の各
    // セクション (連絡/NoticeEditor/保存) は「盤面を編集」タブ配下なので、まず盤面タブへ切り替える。
    await page.getByRole("tab", { name: "盤面を編集" }).click();
    // 連絡セクション見出しが見える = requireRole + withSession(RLS) を通過し自校クラスを描画した証。
    await expect(page.getByRole("heading", { name: "連絡", exact: true })).toBeVisible();

    // 2. 連絡を一意文字列に更新する。エディタは時間割/連絡/提出物の 3 セクションがあり保存ボタンも 3 つ
    //    あるため、連絡セクション (placeholder="連絡事項" を持つ NoticeEditor) に locator をスコープする。
    //    seed は連絡 1 件 (SEED.NOTICE_TEXT) を入れているので、その入力欄を一意文字列に置換する。
    const noticeInput = page.getByPlaceholder("連絡事項").first();
    await expect(noticeInput).toBeVisible();
    await noticeInput.fill(GOLDEN_NOTICE_TEXT);

    // 連絡セクションの保存ボタンに限定する: placeholder="連絡事項" は NoticeEditor 固有 (時間割/提出物の
    // 入力欄は別 placeholder) なので、それを持つ最内 div = NoticeEditor の root grid に locator をスコープ。
    const noticeEditor = page
      .locator("div", { has: page.getByPlaceholder("連絡事項") })
      .filter({ has: page.getByRole("button", { name: "保存" }) })
      .last();
    await noticeEditor.getByRole("button", { name: "保存" }).click();

    // 保存完了 (Server Action setClassNoticesAction が成功) の UI 反映を auto-wait で待つ。
    await expect(noticeEditor.getByText("保存しました。")).toBeVisible();

    // 3. **専用クラスの**公開サイネージを新規ナビゲーションで開く (force-dynamic で最新を取得)。
    await page.goto(`/signage/${SEED.GOLDEN_TOKEN}`);

    // 連絡セクション見出し + 更新した識別文字列が visible = 教員入力がサイネージに反映された。
    await expect(page.getByRole("heading", { name: "連絡", exact: true })).toBeVisible();
    await expect(page.getByText(GOLDEN_NOTICE_TEXT)).toBeVisible();
  });
});
