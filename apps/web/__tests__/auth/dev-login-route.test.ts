import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/dev-login の多層防御を route レベルで固定する（staging 限定 dev-login）。
 *
 * - env!=='staging' → 404（prod を含むすべての非 staging で機能しない）
 * - 秘密キー不一致 / 欠如 → 404
 * - 指定 role 以外（任意ロール）→ 404
 * - すべて揃ったときだけ session cookie を発行してリダイレクト
 *
 * IdP / DB に到達しないよう、dev-login（サインイン + 監査）と session（cookie 発行 / 検証）をモックする。
 */

// 監査 / DB / IdP を叩かないようモック。idToken 取得とセッション発行のみ制御する。
vi.mock("../../lib/auth/dev-login", () => ({
  devLoginSignIn: vi.fn(async () => "fake-id-token"),
  recordDevLoginAudit: vi.fn(async () => {}),
}));
vi.mock("../../lib/auth/session", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/auth/session")>("../../lib/auth/session");
  return {
    ...actual,
    createSessionCookie: vi.fn(async () => "fake-session-cookie"),
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

import { GET } from "../../app/api/dev-login/route";
import { devLoginSignIn, recordDevLoginAudit } from "../../lib/auth/dev-login";

const SECRET = "super-long-staging-only-secret-value";
const CONFIG = JSON.stringify({
  secret: SECRET,
  teacher: { email: "dev-teacher@teacher.kimiterrace.invalid", password: "tpw" },
  admin: { email: "dev-admin@example.invalid", password: "apw" },
});

const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_CONFIG = process.env.DEV_LOGIN_CONFIG;

function req(query: string): Request {
  return new Request(`https://staging.school-signage.net/api/dev-login${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
  if (ORIGINAL_CONFIG === undefined) delete process.env.DEV_LOGIN_CONFIG;
  else process.env.DEV_LOGIN_CONFIG = ORIGINAL_CONFIG;
});

describe("GET /api/dev-login — env ゲート", () => {
  it("APP_ENV!=='staging' (prod) → 404、サインインに進まない", async () => {
    process.env.APP_ENV = "prod";
    process.env.DEV_LOGIN_CONFIG = CONFIG; // 万一 prod に config があっても env ゲートで落ちる
    const res = await GET(req(`?role=teacher&key=${SECRET}`));
    expect(res.status).toBe(404);
    expect(devLoginSignIn).not.toHaveBeenCalled();
  });

  it("APP_ENV 未設定 → 404 (fail-closed)", async () => {
    delete process.env.APP_ENV;
    process.env.DEV_LOGIN_CONFIG = CONFIG;
    const res = await GET(req(`?role=teacher&key=${SECRET}`));
    expect(res.status).toBe(404);
    expect(devLoginSignIn).not.toHaveBeenCalled();
  });
});

describe("GET /api/dev-login — 秘密キーゲート (staging)", () => {
  beforeEach(() => {
    process.env.APP_ENV = "staging";
    process.env.DEV_LOGIN_CONFIG = CONFIG;
  });

  it("キー不一致 → 404、サインインに進まない", async () => {
    const res = await GET(req("?role=teacher&key=wrong"));
    expect(res.status).toBe(404);
    expect(devLoginSignIn).not.toHaveBeenCalled();
  });

  it("キー欠如 → 404", async () => {
    const res = await GET(req("?role=teacher"));
    expect(res.status).toBe(404);
    expect(devLoginSignIn).not.toHaveBeenCalled();
  });

  it("config 不在 (staging でも secret 未投入) → 404", async () => {
    delete process.env.DEV_LOGIN_CONFIG;
    const res = await GET(req(`?role=teacher&key=${SECRET}`));
    expect(res.status).toBe(404);
    expect(devLoginSignIn).not.toHaveBeenCalled();
  });
});

describe("GET /api/dev-login — ロール allowlist (staging + 正キー)", () => {
  beforeEach(() => {
    process.env.APP_ENV = "staging";
    process.env.DEV_LOGIN_CONFIG = CONFIG;
  });

  it("指定 role 以外 (system_admin) → 404、サインインに進まない", async () => {
    const res = await GET(req(`?role=system_admin&key=${SECRET}`));
    expect(res.status).toBe(404);
    expect(devLoginSignIn).not.toHaveBeenCalled();
  });

  it("任意の不正 role → 404", async () => {
    const res = await GET(req(`?role=root&key=${SECRET}`));
    expect(res.status).toBe(404);
    expect(devLoginSignIn).not.toHaveBeenCalled();
  });

  it("role 欠如 → 404", async () => {
    const res = await GET(req(`?key=${SECRET}`));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/dev-login — 成功経路 (staging + 正キー + 正 role)", () => {
  beforeEach(() => {
    process.env.APP_ENV = "staging";
    process.env.DEV_LOGIN_CONFIG = CONFIG;
  });

  it("teacher → 303 リダイレクト + __session cookie + 監査記録", async () => {
    const res = await GET(req(`?role=teacher&key=${SECRET}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://staging.school-signage.net/");
    const cookie = res.cookies.get("__session");
    expect(cookie?.value).toBe("fake-session-cookie");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/");
    expect(devLoginSignIn).toHaveBeenCalledWith("teacher");
    expect(recordDevLoginAudit).toHaveBeenCalledTimes(1);
  });

  it("admin → 303 + cookie + 監査", async () => {
    const res = await GET(req(`?role=admin&key=${SECRET}`));
    expect(res.status).toBe(303);
    expect(res.cookies.get("__session")?.value).toBe("fake-session-cookie");
    expect(devLoginSignIn).toHaveBeenCalledWith("admin");
  });

  it("サインイン失敗 (idToken null) → 404、cookie を発行しない", async () => {
    vi.mocked(devLoginSignIn).mockResolvedValueOnce(null);
    const res = await GET(req(`?role=teacher&key=${SECRET}`));
    expect(res.status).toBe(404);
    expect(res.cookies.get("__session")).toBeUndefined();
    expect(recordDevLoginAudit).not.toHaveBeenCalled();
  });
});
