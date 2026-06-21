import { afterEach, describe, expect, it } from "vitest";
import { isStagingEnv } from "../../lib/auth/app-env";
import {
  getDevLoginAccount,
  getDevLoginConfig,
  toDevLoginRole,
  verifyDevLoginKey,
} from "../../lib/auth/dev-login-config";

/**
 * staging 限定 dev-login の **多層防御の素**（env ゲート / 秘密キー突合 / config パース / ロール allowlist）を
 * pure に固定する。route 統合テスト（dev-login-route.test.ts）と合わせて「prod では機能しない」を担保する。
 */

const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_CONFIG = process.env.DEV_LOGIN_CONFIG;

const VALID_CONFIG = JSON.stringify({
  secret: "super-long-staging-only-secret-value",
  teacher: { email: "dev-teacher@teacher.kimiterrace.invalid", password: "tpw-staging" },
  admin: { email: "dev-admin@example.invalid", password: "apw-staging" },
});

afterEach(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
  if (ORIGINAL_CONFIG === undefined) delete process.env.DEV_LOGIN_CONFIG;
  else process.env.DEV_LOGIN_CONFIG = ORIGINAL_CONFIG;
});

describe("isStagingEnv — env ゲート (fail-closed)", () => {
  it("APP_ENV=staging のみ true", () => {
    process.env.APP_ENV = "staging";
    expect(isStagingEnv()).toBe(true);
  });

  it("APP_ENV=prod は false (prod では dev-login が動かない)", () => {
    process.env.APP_ENV = "prod";
    expect(isStagingEnv()).toBe(false);
  });

  it("APP_ENV 未設定は false (fail-closed)", () => {
    delete process.env.APP_ENV;
    expect(isStagingEnv()).toBe(false);
  });

  it("想定外の値は false (fail-closed)", () => {
    process.env.APP_ENV = "Staging"; // 大文字違いも拒否
    expect(isStagingEnv()).toBe(false);
    process.env.APP_ENV = "production";
    expect(isStagingEnv()).toBe(false);
  });
});

describe("toDevLoginRole — ロール allowlist", () => {
  it("teacher / admin のみ受理", () => {
    expect(toDevLoginRole("teacher")).toBe("teacher");
    expect(toDevLoginRole("admin")).toBe("admin");
  });

  it("それ以外は null (system_admin / 任意値 / 空 / null)", () => {
    expect(toDevLoginRole("system_admin")).toBeNull();
    expect(toDevLoginRole("student")).toBeNull();
    expect(toDevLoginRole("")).toBeNull();
    expect(toDevLoginRole(null)).toBeNull();
    expect(toDevLoginRole(undefined)).toBeNull();
  });
});

describe("getDevLoginConfig — fail-closed パース", () => {
  it("正しい JSON を解決", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    const config = getDevLoginConfig();
    expect(config?.secret).toBe("super-long-staging-only-secret-value");
    expect(config?.teacher.email).toBe("dev-teacher@teacher.kimiterrace.invalid");
    expect(config?.admin.password).toBe("apw-staging");
  });

  it("env 未設定 → null (prod 既定)", () => {
    delete process.env.DEV_LOGIN_CONFIG;
    expect(getDevLoginConfig()).toBeNull();
  });

  it("不正 JSON → null", () => {
    process.env.DEV_LOGIN_CONFIG = "{not json";
    expect(getDevLoginConfig()).toBeNull();
  });

  it("必須欠落 (secret / teacher / admin) → null", () => {
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({ teacher: {}, admin: {} });
    expect(getDevLoginConfig()).toBeNull();
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({
      secret: "x",
      admin: { email: "a", password: "b" },
    });
    expect(getDevLoginConfig()).toBeNull();
  });
});

describe("verifyDevLoginKey — 定数時間突合 (fail-closed)", () => {
  it("一致で true", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    expect(verifyDevLoginKey("super-long-staging-only-secret-value")).toBe(true);
  });

  it("不一致で false", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    expect(verifyDevLoginKey("wrong-key")).toBe(false);
  });

  it("config 不在 (prod) では如何なるキーも false", () => {
    delete process.env.DEV_LOGIN_CONFIG;
    expect(verifyDevLoginKey("super-long-staging-only-secret-value")).toBe(false);
    expect(verifyDevLoginKey("")).toBe(false);
    expect(verifyDevLoginKey(null)).toBe(false);
  });

  it("キー欠如 / 空は false", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    expect(verifyDevLoginKey(null)).toBe(false);
    expect(verifyDevLoginKey(undefined)).toBe(false);
    expect(verifyDevLoginKey("")).toBe(false);
  });
});

describe("getDevLoginAccount — config の固定アカウントのみ", () => {
  it("ロールに対応するアカウントを返す", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    expect(getDevLoginAccount("teacher")?.email).toBe("dev-teacher@teacher.kimiterrace.invalid");
    expect(getDevLoginAccount("admin")?.email).toBe("dev-admin@example.invalid");
  });

  it("config 不在は null", () => {
    delete process.env.DEV_LOGIN_CONFIG;
    expect(getDevLoginAccount("teacher")).toBeNull();
  });
});
