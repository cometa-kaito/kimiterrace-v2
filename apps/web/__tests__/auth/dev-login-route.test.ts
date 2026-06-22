import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/dev-login の多層防御を route レベルで固定する（staging 限定 dev-login）。
 *
 * - prod の痕跡（APP_ENV=prod / prod プロジェクト）→ 404（打消しゲート・最優先）
 * - env!=='staging' → 404（prod を含むすべての非 staging で機能しない）
 * - Authorization Bearer 不一致 / 欠如 → 404（秘密はヘッダ受け＝クエリ露出なし）
 * - 指定 role 以外（任意ロール）→ 404
 * - すべて揃ったときだけ **uid から直接** session cookie を発行（パスワードレス）してリダイレクト + keyVersion を監査へ
 *
 * IdP / DB に到達しないよう、dev-login（uid 解決 + 監査）と session（**uid からの cookie 発行** / 検証）をモックする。
 */

// 監査 / DB / IdP を叩かないようモック。uid 解決とセッション発行のみ制御する。
vi.mock("../../lib/auth/dev-login", () => ({
  resolveDevLoginUid: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
  recordDevLoginAudit: vi.fn(async () => {}),
}));
vi.mock("../../lib/auth/session", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/auth/session")>("../../lib/auth/session");
  return {
    ...actual,
    // パスワードレス発行: uid から直接 session cookie を作る経路をモック。
    createSessionCookieForUid: vi.fn(async () => "fake-session-cookie"),
    verifySessionCookie: vi.fn(async () => ({
      uid: "11111111-1111-4111-8111-111111111111",
      role: "teacher",
      schoolId: "22222222-2222-4222-8222-222222222222",
    })),
  };
});
// next/headers は route 内 audit 用。空ヘッダを返すだけ。
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { POST } from "../../app/api/dev-login/route";
import { recordDevLoginAudit, resolveDevLoginUid } from "../../lib/auth/dev-login";

const SECRET = "super-long-staging-only-secret-value";
const KEY_VERSION = "2026-06";
// 新・最小 config: ゲート鍵のみ（password は持たない）。
const CONFIG = JSON.stringify({ secret: SECRET, keyVersion: KEY_VERSION });

const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_CONFIG = process.env.DEV_LOGIN_CONFIG;
const ORIGINAL_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;

/**
 * POST リクエストを組む。`key` は Authorization Bearer（クエリには絶対に載せない）、`role` は JSON body。
 * `key`/`role` を省略すると当該ヘッダ / body を付けない（欠如ケースの検証用）。
 */
function req(opts: { key?: string; role?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
  const init: RequestInit = { method: "POST", headers };
  if (opts.role !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify({ role: opts.role });
  }
  return new Request("https://staging.school-signage.net/api/dev-login", init);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
  if (ORIGINAL_CONFIG === undefined) delete process.env.DEV_LOGIN_CONFIG;
  else process.env.DEV_LOGIN_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_PROJECT === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
  else process.env.GOOGLE_CLOUD_PROJECT = ORIGINAL_PROJECT;
});

describe("POST /api/dev-login — prod 打消しゲート (最優先)", () => {
  it("APP_ENV=prod → 404、サインインに進まない", async () => {
    process.env.APP_ENV = "prod";
    process.env.DEV_LOGIN_CONFIG = CONFIG; // 万一 prod に config があっても打消しゲートで落ちる
    const res = await POST(req({ key: SECRET, role: "teacher" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });

  it("prod プロジェクト痕跡 (APP_ENV=staging でも) → 404", async () => {
    // 最悪ケース: prod に APP_ENV=staging と config が誤混入。プロジェクト名の prod 痕跡が独立に弾く。
    process.env.APP_ENV = "staging";
    process.env.GOOGLE_CLOUD_PROJECT = "kimiterrace-prod";
    process.env.DEV_LOGIN_CONFIG = CONFIG;
    const res = await POST(req({ key: SECRET, role: "teacher" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });
});

describe("POST /api/dev-login — env ゲート", () => {
  it("APP_ENV 未設定 → 404 (fail-closed)", async () => {
    delete process.env.APP_ENV;
    process.env.DEV_LOGIN_CONFIG = CONFIG;
    const res = await POST(req({ key: SECRET, role: "teacher" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });
});

describe("POST /api/dev-login — 秘密キーゲート (staging・Authorization ヘッダ)", () => {
  beforeEach(() => {
    process.env.APP_ENV = "staging";
    process.env.DEV_LOGIN_CONFIG = CONFIG;
  });

  it("キー不一致 → 404、サインインに進まない", async () => {
    const res = await POST(req({ key: "wrong", role: "teacher" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });

  it("Authorization ヘッダ欠如 → 404", async () => {
    const res = await POST(req({ role: "teacher" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });

  it("config 不在 (staging でも secret 未投入) → 404", async () => {
    delete process.env.DEV_LOGIN_CONFIG;
    const res = await POST(req({ key: SECRET, role: "teacher" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });
});

describe("POST /api/dev-login — ロール allowlist (staging + 正キー)", () => {
  beforeEach(() => {
    process.env.APP_ENV = "staging";
    process.env.DEV_LOGIN_CONFIG = CONFIG;
  });

  it("指定 role 以外 (system_admin) → 404、サインインに進まない", async () => {
    const res = await POST(req({ key: SECRET, role: "system_admin" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });

  it("任意の不正 role → 404", async () => {
    const res = await POST(req({ key: SECRET, role: "root" }));
    expect(res.status).toBe(404);
    expect(resolveDevLoginUid).not.toHaveBeenCalled();
  });

  it("role 欠如 → 404", async () => {
    const res = await POST(req({ key: SECRET }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/dev-login — 成功経路 (staging + 正キー + 正 role)", () => {
  beforeEach(() => {
    process.env.APP_ENV = "staging";
    process.env.DEV_LOGIN_CONFIG = CONFIG;
  });

  it("teacher → 303 リダイレクト + __session cookie + keyVersion 付き監査", async () => {
    const res = await POST(req({ key: SECRET, role: "teacher" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://staging.school-signage.net/");
    const cookie = res.cookies.get("__session");
    expect(cookie?.value).toBe("fake-session-cookie");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/");
    expect(resolveDevLoginUid).toHaveBeenCalledWith("teacher");
    expect(recordDevLoginAudit).toHaveBeenCalledTimes(1);
    // 監査呼び出しに keyVersion（非秘密ラベル）が渡る（user, role, headers, keyVersion の 4 引数）。
    expect(vi.mocked(recordDevLoginAudit).mock.calls[0]?.[3]).toBe(KEY_VERSION);
  });

  it("admin → 303 + cookie + 監査", async () => {
    const res = await POST(req({ key: SECRET, role: "admin" }));
    expect(res.status).toBe(303);
    expect(res.cookies.get("__session")?.value).toBe("fake-session-cookie");
    expect(resolveDevLoginUid).toHaveBeenCalledWith("admin");
  });

  it("role を form-urlencoded で渡しても成功する", async () => {
    const res = await POST(
      new Request("https://staging.school-signage.net/api/dev-login", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "role=teacher",
      }),
    );
    expect(res.status).toBe(303);
    expect(resolveDevLoginUid).toHaveBeenCalledWith("teacher");
  });

  it("サインイン失敗 (idToken null) → 404、cookie を発行しない", async () => {
    vi.mocked(resolveDevLoginUid).mockResolvedValueOnce(null);
    const res = await POST(req({ key: SECRET, role: "teacher" }));
    expect(res.status).toBe(404);
    expect(res.cookies.get("__session")).toBeUndefined();
    expect(recordDevLoginAudit).not.toHaveBeenCalled();
  });
});
