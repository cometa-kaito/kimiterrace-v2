import { type Page, expect, test } from "@playwright/test";
import {
  SCHOOL_ADMIN_STORAGE_STATE,
  SEED,
  SYSTEM_ADMIN_STORAGE_STATE,
  TEACHER_STORAGE_STATE,
  isSignageDbAvailable,
} from "./global-setup";

/**
 * 認可マトリクス e2e (Phase 検証 #243 トラック① role-boundary / ③ authz-matrix)。
 *
 * `requireRole` (lib/auth/guard.ts) + 各 API route の role gate が **正しいロールを通し誤ったロールを
 * 弾く**ことを、保護ページ + 主要 API route × ロール の組合せで end-to-end に検証する。これは
 * `admin-auth.spec.ts` (教員 1 経路) を多ロールに拡張し、role 境界を網羅する回帰ガードにするもの。
 *
 * 検証する不変条件:
 * - **ページ**: 許可ロールは目的ページに到達 (認証済みでないと出ない要素で確認)。誤ロールは
 *   `/forbidden` に redirect、未認証は `/login` に redirect (middleware → requireRole の二段防衛)。
 * - **API route**: 許可ロールは 2xx 相当、誤ロール/未認証は **401/403 を JSON で**返す
 *   (200 本体を返す前に弾く)。
 *
 * 認可の**本体は RLS** (ADR-019)。本 spec は「画面/route を見せない・早期に弾く」UX/第一層の検証で、
 * cross-tenant の実データ越境は `cross-tenant-isolation.spec.ts` が RLS レベルで別途検証する。
 *
 * skip 条件は `admin-auth.spec.ts` と同一 (emulator + 実 DB がある時のみ実行、偽 green 回避)。
 */

const authAvailable =
  !!process.env.FIREBASE_AUTH_EMULATOR_HOST && isSignageDbAvailable(process.env.DATABASE_URL);

/** 各ロールの storageState (auth.setup.ts が発行)。未認証は cookie 空。 */
const STATE = {
  system_admin: SYSTEM_ADMIN_STORAGE_STATE,
  school_admin: SCHOOL_ADMIN_STORAGE_STATE,
  teacher: TEACHER_STORAGE_STATE,
} as const;

type RoleKey = keyof typeof STATE;
const ALL_ROLES: readonly RoleKey[] = ["system_admin", "school_admin", "teacher"];

/**
 * 保護ページの認可期待。`path` を各ロールで開き、許可なら `allowUrl` に到達 (redirect 後の URL を許容)、
 * 不許可なら `/forbidden` に倒れることを確認する。`allow` に無いロールは「誤ロール = 403」を期待する。
 *
 * `allowUrl` は到達後 URL の正規表現。requireRole を通過したページは目的 URL に留まる (redirect しない)。
 * ルートインデックス `/admin` は homePathForRole で各ロール別ホームへ redirect するため個別に扱う。
 */
type PageCase = {
  label: string;
  path: string;
  allow: readonly RoleKey[];
  /**
   * 許可ロールで到達したときに満たすべき URL の正規表現 (**必須**)。各ケースが明示的に宣言する。
   * 以前は optional にし expectPageOutcome で `new RegExp(c.path)` へ動的フォールバックしていたが、
   * PAGE_CASES は全件 allowUrl を持つため当該フォールバックは到達不能 (dead branch) であり、
   * 非リテラル `new RegExp(...)` が Semgrep detect-non-literal-regexp の誤検知を生んでいた。
   * 必須化してフォールバックを除去すると、挙動を変えずに検知を解消しつつ「各保護ページは到達後 URL を
   * 明示する」意図を型で強制できる。
   */
  allowUrl: RegExp;
};

const PAGE_CASES: readonly PageCase[] = [
  // /admin index = ADMIN_ROLES (system_admin/school_admin/teacher)。全管理ロール許可。/admin layout/page は
  // PR-3 まで残置し、homePathForRole で各ロール別ホームへ redirect する: school_admin→/app/school・
  // teacher→/app/editor（namespace 改称 §4.1 で /app へ）・system_admin→/ops/schools。いずれも /admin 配下には
  // 着地しないため、allowUrl は新 namespace (/app・/ops) を許容する（/forbidden・/login でないことは別途確認）。
  {
    label: "/admin (ADMIN_ROLES)",
    path: "/admin",
    allow: ALL_ROLES,
    allowUrl: /\/(app|ops)(\/|$)/,
  },
  // /app/editor/[classId] = EDITOR_ROLES (school_admin/teacher)。system_admin は 403。
  // SEED.CLASS_ID は SCHOOL1 のクラス。school_admin/teacher は同一校なので RLS 可視で到達できる。
  {
    label: "/app/editor/[classId] (EDITOR_ROLES; system_admin 403)",
    path: `/app/editor/${SEED.CLASS_ID}`,
    allow: ["school_admin", "teacher"],
    allowUrl: new RegExp(`/app/editor/${SEED.CLASS_ID}`),
  },
  // /app/contents = PUBLISHER_ROLES (school_admin/teacher)。system_admin は 403 (自校用一覧)。
  {
    label: "/app/contents (PUBLISHER_ROLES; system_admin 403)",
    path: "/app/contents",
    allow: ["school_admin", "teacher"],
    allowUrl: /\/app\/contents$/,
  },
  // /ops/schools = SYSTEM_ADMIN_ROLES (system_admin のみ)。school_admin/teacher は 403。
  {
    label: "/ops/schools (system_admin only)",
    path: "/ops/schools",
    allow: ["system_admin"],
    allowUrl: /\/ops\/schools$/,
  },
  // /ops/users = SYSTEM_ADMIN_ROLES (system_admin のみ)。横断ユーザー管理。
  {
    label: "/ops/users (system_admin only)",
    path: "/ops/users",
    allow: ["system_admin"],
    allowUrl: /\/ops\/users$/,
  },
  // /app/school/members（school_admin の自校教職員管理）は教員アカウント概念の撤去（2026-06-10）で
  // ページごと廃止したため、認可マトリクスからも除外（教員は学校共通パスワード=系統A のみでログイン）。
];

/** 認証済みページの到達検証: 許可ロールは allowUrl に留まり、不許可ロールは /forbidden に倒れる。 */
async function expectPageOutcome(page: Page, c: PageCase, role: RoleKey): Promise<void> {
  await page.goto(c.path);
  if (c.allow.includes(role)) {
    // 許可: redirect 後 URL が allowUrl を満たす (requireRole を通過し目的ページに到達)。
    // allowUrl は PageCase で必須なので、動的 RegExp フォールバックは不要 (検知回避 + 意図明確化)。
    await expect(page).toHaveURL(c.allowUrl);
    // /forbidden / /login に飛んでいないことも明示 (allowUrl が緩いケースの保険)。
    await expect(page).not.toHaveURL(/\/forbidden$/);
    await expect(page).not.toHaveURL(/\/login(\?|$)/);
  } else {
    // 誤ロール: requireRole が /forbidden に redirect する (情報露出を避ける汎用 403 画面)。
    await expect(page).toHaveURL(/\/forbidden$/);
    await expect(page.getByRole("heading", { name: "アクセス権限がありません" })).toBeVisible();
  }
}

test.describe("認可マトリクス: 保護ページ × ロール (#243 トラック①/③)", () => {
  test.skip(!authAvailable, "FIREBASE_AUTH_EMULATOR_HOST 未設定 / DATABASE_URL placeholder");

  for (const role of ALL_ROLES) {
    test.describe(`ロール=${role}`, () => {
      test.use({ storageState: STATE[role] });

      for (const c of PAGE_CASES) {
        const verb = c.allow.includes(role) ? "許可→到達" : "拒否→/forbidden";
        test(`${c.label}: ${verb}`, async ({ page }) => {
          await expectPageOutcome(page, c, role);
        });
      }
    });
  }

  // 未認証 (cookie 無し): 保護ページは middleware が /login に弾く (claims 検証前の早期ゲート)。
  test.describe("未認証 (storageState なし)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const c of PAGE_CASES) {
      test(`${c.label}: 未認証→/login`, async ({ page }) => {
        await page.goto(c.path);
        await expect(page).toHaveURL(/\/login(\?|$)/);
      });
    }
  });
});

/**
 * 主要 API route の role gate。許可ロールは 2xx 相当、誤ロール/未認証は 401/403 を JSON で返す。
 *
 * - body 検証 (classId 等) より **先に** 認可を弾く route と、認可後に 400 を返す route があるため、
 *   「許可ロール」は「401/403 でないこと」で表現する (有効/最小ボディを送り、許可なら 2xx〜4xx の
 *   非 401/403、つまり認可は通過したことを確認する)。誤ロールは厳密に 401/403 を要求する。
 */
type ApiCase = {
  label: string;
  method: "POST" | "GET";
  path: string;
  /** 認可後に進む route で 400 を避けるための最小有効ボディ (JSON)。 */
  body?: unknown;
  allow: readonly RoleKey[];
  /** 誤ロール時に期待する拒否ステータス (role 不足は通常 403)。 */
  denyStatus: 401 | 403;
};

const API_CASES: readonly ApiCase[] = [
  // POST /api/magic-links = MAGIC_LINK_ISSUER_ROLES (teacher/school_admin)。system_admin は schoolId 無しで 403。
  // route は **認可 (requireIssuer) をボディ検証より前に評価**する。許可ロールには空ボディを送り、認可
  // 通過後に classId 欠落の 400 で返させる (リンクを実際に発行せず副作用ゼロ・決定的)。誤ロールは 403。
  {
    label: "POST /api/magic-links (issuer roles; system_admin 403)",
    method: "POST",
    path: "/api/magic-links",
    body: {},
    allow: ["school_admin", "teacher"],
    denyStatus: 403,
  },
  // POST /api/teacher/chat = PUBLISHER_ROLES (school_admin/teacher)。system_admin は 403。
  // **認可は SSE を開く前 + ボディ検証より前に評価される** (route 実装: getCurrentUser→role gate→
  // respondWithChatStream のボディ検証)。許可ロールには `question` 欠落ボディを送り、認可通過後に
  // ボディ検証 400 で**即同期 return** させる (SSE/Vertex を起動しない = 決定的・高速)。これで
  // 「許可ロールは認可を超える (401/403 にならない)」を Vertex 環境非依存に確認できる。誤ロールは
  // ボディに到達せず 403。
  {
    label: "POST /api/teacher/chat (PUBLISHER_ROLES; system_admin 403)",
    method: "POST",
    path: "/api/teacher/chat",
    body: { notQuestion: true },
    allow: ["school_admin", "teacher"],
    denyStatus: 403,
  },
  // GET /api/reports/monthly = SYSTEM_ADMIN_ROLES (system_admin のみ)。校務DX原則で月次レポートは
  // 運営専用に締めたため、teacher / school_admin は 403。画面 /admin/reports と整合。
  {
    label: "GET /api/reports/monthly (SYSTEM_ADMIN_ROLES; teacher/school_admin 403)",
    method: "GET",
    path: "/api/reports/monthly",
    allow: ["system_admin"],
    denyStatus: 403,
  },
];

test.describe("認可マトリクス: API route × ロール (#243 トラック①/③)", () => {
  test.skip(!authAvailable, "FIREBASE_AUTH_EMULATOR_HOST 未設定 / DATABASE_URL placeholder");

  for (const role of ALL_ROLES) {
    test.describe(`ロール=${role}`, () => {
      test.use({ storageState: STATE[role] });

      for (const c of API_CASES) {
        const allowed = c.allow.includes(role);
        test(`${c.label}: ${allowed ? "許可(非401/403)" : `拒否(${c.denyStatus})`}`, async ({
          request,
        }) => {
          const res =
            c.method === "POST"
              ? await request.post(c.path, { data: c.body ?? {} })
              : await request.get(c.path);
          if (allowed) {
            // 認可は通過 = 401/403 ではない (本体検証で 400/404 や 200 になりうるが認可は超えた)。
            expect(res.status(), `${c.label} for ${role} は認可通過すべき`).not.toBe(401);
            expect(res.status(), `${c.label} for ${role} は認可通過すべき`).not.toBe(403);
          } else {
            // 誤ロール: 厳密に denyStatus (403)。情報露出しない JSON エラー。
            expect(res.status(), `${c.label} for ${role} は拒否すべき`).toBe(c.denyStatus);
          }
        });
      }
    });
  }

  // 未認証 (cookie 無し): これらの API パスは middleware の matcher 除外**ではない**ため、
  // handler の 401 に到達する前に **middleware が /login へ 307 redirect** する (Edge の早期ゲート、
  // NextResponse.redirect の既定は 307)。これは「未認証アクセスは保護 route に触れさせない」より強い
  // 防御で、middleware.test.ts (#160) が固定する matcher 挙動と整合する。redirect を追わず観測する。
  test.describe("未認証 (storageState なし)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const c of API_CASES) {
      test(`${c.label}: 未認証→/login へ 307 redirect`, async ({ request }) => {
        const res =
          c.method === "POST"
            ? await request.post(c.path, { data: c.body ?? {}, maxRedirects: 0 })
            : await request.get(c.path, { maxRedirects: 0 });
        // middleware が未認証を /login に弾く (307)。location が /login を指すことまで確認。
        expect(res.status(), `${c.label} 未認証は 307 redirect`).toBe(307);
        expect(res.headers().location ?? "").toContain("/login");
      });
    }
  });
});
