import { expect, test } from "@playwright/test";
import {
  SCHOOL2_SCHOOL_ADMIN_STORAGE_STATE,
  SCHOOL2_TEACHER_STORAGE_STATE,
  SEED,
  SEED2,
  isSignageDbAvailable,
} from "./global-setup";

/**
 * クロステナント分離 e2e (Phase 検証 #243 トラック① / #213 の延長)。
 *
 * **RLS が DB レベルでテナント越境を止める** ことを、app の role gate を**通過する**経路で実証する。
 * 鍵は「app guard ではなく RLS が止める」ことの証明なので、各経路ごとに **その経路の gate を満たす**
 * SCHOOL2 actor を使う。SCHOOL1 リソースに触れられないのは、`withSession` / `withTenantContext` が張る
 * `app.current_school_id` (=SCHOOL2) のもとで SCHOOL1 行が RLS (`tenant_isolation`, ADR-019) により
 * 不可視になるからである (CLAUDE.md ルール2、多層防御の DB 層)。
 *
 * **actor を 2 つ使う理由 (#865 finding④で gate が分化)**:
 * - **editor 経路** (`/app/editor`) は `requireRole(EDITOR_ROLES = school_admin/teacher)`。SCHOOL2
 *   **教員**で「gate 通過 → RLS 404」を実証する。
 * - **magic link 発行系 API** (revoke/extend/list) は finding④ で `isIssuerRole = school_admin/system_admin`
 *   に再編され **teacher は除外**された。よって teacher だと app gate (403) で弾かれ「RLS が止める」証明に
 *   ならない。SCHOOL2 **学校管理者**で実証する (system_admin は `system_admin_full_access` で越境可なため
 *   RLS 証明に不適格 → school_admin が唯一の適格 issuer)。
 *
 * webServer は `kimiterrace_app` (非 BYPASSRLS) 接続 (playwright.config.ts の `toAppDatabaseUrl`)
 * なので、RLS は実際に効く。superuser 接続なら RLS がバイパスされ本 spec は無意味になる (#213 と同方針)。
 *
 * 対照 (positive): 同じ SCHOOL2 教員が **自校 (SCHOOL2)** のリソースには到達できることも併せて確認し、
 * 「単に全部 404 になっているだけ」ではない (= 分離が一方向に効いている) ことを保証する。
 *
 * skip 条件は他の認証 e2e と同一 (emulator + 実 DB がある時のみ実行、偽 green 回避)。
 */

const authAvailable =
  !!process.env.FIREBASE_AUTH_EMULATOR_HOST && isSignageDbAvailable(process.env.DATABASE_URL);

test.describe("クロステナント分離: SCHOOL2 vs SCHOOL1 リソース (#243/#213)", () => {
  test.skip(!authAvailable, "FIREBASE_AUTH_EMULATOR_HOST 未設定 / DATABASE_URL placeholder");

  // editor 経路 (`requireRole(EDITOR_ROLES = school_admin/teacher)`)。SCHOOL2 **教員**で実行する
  // (auth.setup.ts が発行)。role=teacher なので app の role gate は通過する。越境を止めるのは RLS のみ。
  test.describe("editor 経路 (SCHOOL2 教員・EDITOR_ROLES 通過)", () => {
    test.use({ storageState: SCHOOL2_TEACHER_STORAGE_STATE });

    test("自校 (SCHOOL2) のエディタには到達できる [対照 positive]", async ({ page }) => {
      // SCHOOL2 のクラス。SCHOOL2 教員の school_id = SEED2.SCHOOL_ID と一致するため RLS で可視 → 描画。
      await page.goto(`/app/editor/${SEED2.CLASS_ID}`);
      await expect(page).toHaveURL(new RegExp(`/app/editor/${SEED2.CLASS_ID}`));
      // 自校クラス名 (seedSchool2 の "1組") の見出しが出る = RLS で可視・404 でない。
      await expect(page.getByRole("heading", { name: "1組", level: 1 })).toBeVisible();
      // 越境拒否画面に倒れていないことも明示。
      await expect(page).not.toHaveURL(/\/forbidden$/);
    });

    test("他校 (SCHOOL1) のエディタは RLS で不可視 → 404 (app guard は通過)", async ({ page }) => {
      // SCHOOL1 のクラス id。role gate (EDITOR_ROLES) は teacher を通すが、SCHOOL2 context では
      // SCHOOL1 のクラスが RLS 不可視 → schedule/notices/assignments が null → page が notFound()。
      const res = await page.goto(`/app/editor/${SEED.CLASS_ID}`);
      // Next の notFound() は 404 を返す (not-found UI)。/forbidden には飛ばない (403 ではなく不可視)。
      expect(res?.status(), "他校クラスは RLS 不可視で 404").toBe(404);
      await expect(page).not.toHaveURL(/\/forbidden$/);
      // SCHOOL1 のクラス名 (seed の "1組" 等) が漏れないこと: not-found 画面に他校データを出さない。
      await expect(page.getByRole("heading", { name: "予定" })).toHaveCount(0);
    });
  });

  // magic link 発行系 API (`isIssuerRole = school_admin/system_admin`・teacher 除外 finding④)。SCHOOL2
  // **学校管理者**で実行する。teacher だと app gate で 403 落ちし「RLS が止める」証明にならないため、
  // gate を通過する適格 issuer (school_admin) を使う。越境を止めるのは RLS のみ (system_admin は越境可で不適格)。
  test.describe("magic link 発行系 API (SCHOOL2 学校管理者・isIssuerRole 通過)", () => {
    test.use({ storageState: SCHOOL2_SCHOOL_ADMIN_STORAGE_STATE });

    test("他校 (SCHOOL1) の magic link を revoke しようとしても RLS で 404 (越境拒否・漏洩なし)", async ({
      request,
    }) => {
      // SCHOOL1 の有効 magic link id。SCHOOL2 学校管理者は isIssuerRole を満たす (role=school_admin,
      // schoolId 有り) ため app gate は通過するが、revokeMagicLink は SCHOOL2 RLS context で SCHOOL1 行が
      // 不可視 → undefined → 404。**403 ではなく 404** であることが「存在を漏らさず RLS で止める」証跡。
      const res = await request.post(`/api/magic-links/${SEED.MAGIC_LINK_ID}/revoke`);
      expect(res.status(), "他校 link の revoke は RLS で 404").toBe(404);
      const json = (await res.json()) as { error?: string };
      // エラーは汎用 (存在/失効/他校を区別しない)。攻撃者に他校 link の存在を漏らさない。
      expect(json.error).toBe("not_found_or_already_revoked");
    });

    test("他校 (SCHOOL1) の magic link を extend しようとしても RLS で 404 (越境拒否)", async ({
      request,
    }) => {
      // extend も同型: app gate 通過 → extendMagicLink が SCHOOL2 context で SCHOOL1 行不可視 → 404。
      const res = await request.post(`/api/magic-links/${SEED.MAGIC_LINK_ID}/extend`, {
        data: { expiresInDays: 30 },
      });
      expect(res.status(), "他校 link の extend は RLS で 404").toBe(404);
      const json = (await res.json()) as { error?: string };
      expect(json.error).toBe("not_found_or_revoked");
    });

    test("他校 (SCHOOL1) のクラスの magic link 一覧は RLS で空 (リーク無し)", async ({
      request,
    }) => {
      // GET /api/magic-links?classId=SCHOOL1 の classId。isIssuerRole は通過するが、listClassMagicLinks
      // は SCHOOL2 RLS context で SCHOOL1 の link を 1 件も返さない (越境リーク無し)。200 + 空配列。
      const res = await request.get(`/api/magic-links?classId=${SEED.CLASS_ID}`);
      // classId 自体は UUID 形式なので 400 にはならず、RLS で 0 件の 200 になる。
      expect(res.status(), "他校 classId の一覧は 200 (RLS で空)").toBe(200);
      const json = (await res.json()) as { links: unknown[] };
      expect(Array.isArray(json.links)).toBe(true);
      expect(json.links.length, "他校 link はリークしない").toBe(0);
    });
  });
});
