import { afterEach, describe, expect, it } from "vitest";
import { isProdLikeEnv, isStagingEnv } from "../../lib/auth/app-env";
import {
  getDevLoginAccount,
  getDevLoginConfig,
  getDevLoginKeyVersion,
  toDevLoginRole,
  verifyDevLoginKey,
} from "../../lib/auth/dev-login-config";

/**
 * staging 限定 dev-login の **多層防御の素**（env ゲート / 秘密キー突合 / config パース / ロール allowlist）を
 * pure に固定する。route 統合テスト（dev-login-route.test.ts）と合わせて「prod では機能しない」を担保する。
 */

const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_CONFIG = process.env.DEV_LOGIN_CONFIG;
const ORIGINAL_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;

const VALID_CONFIG = JSON.stringify({
  secret: "super-long-staging-only-secret-value",
  keyVersion: "2026-06",
  teacher: { email: "dev-teacher@teacher.kimiterrace.invalid", password: "tpw-staging" },
  admin: { email: "dev-admin@example.invalid", password: "apw-staging" },
});

afterEach(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
  if (ORIGINAL_CONFIG === undefined) delete process.env.DEV_LOGIN_CONFIG;
  else process.env.DEV_LOGIN_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_PROJECT === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
  else process.env.GOOGLE_CLOUD_PROJECT = ORIGINAL_PROJECT;
});

describe("isProdLikeEnv — prod 打消しゲート (多層防御の第3層)", () => {
  it("APP_ENV=prod / production は true", () => {
    process.env.APP_ENV = "prod";
    expect(isProdLikeEnv()).toBe(true);
    process.env.APP_ENV = "production";
    expect(isProdLikeEnv()).toBe(true);
  });

  it("プロジェクト名に prod が含まれれば true (別プロジェクトで独立に弾く)", () => {
    delete process.env.APP_ENV;
    process.env.GOOGLE_CLOUD_PROJECT = "kimiterrace-prod";
    expect(isProdLikeEnv()).toBe(true);
  });

  it("staging を巻き込まない: APP_ENV=staging + staging プロジェクトは false", () => {
    process.env.APP_ENV = "staging";
    process.env.GOOGLE_CLOUD_PROJECT = "kimiterrace-staging";
    expect(isProdLikeEnv()).toBe(false);
  });

  it("prod 信号が無ければ false (NODE_ENV=production でも判定に使わない)", () => {
    // テスト実行環境では NODE_ENV が production 系のことがあるが、isProdLikeEnv は NODE_ENV を見ない。
    delete process.env.APP_ENV;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    expect(isProdLikeEnv()).toBe(false);
  });
});

describe("getDevLoginKeyVersion — 非秘密ラベルのみ", () => {
  it("config の keyVersion を返す", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    expect(getDevLoginKeyVersion()).toBe("2026-06");
  });

  it("keyVersion 未設定なら null（config は有効のまま）", () => {
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({
      secret: "x-very-long-secret",
      teacher: { email: "a", password: "b" },
      admin: { email: "c", password: "d" },
    });
    expect(getDevLoginConfig()).not.toBeNull();
    expect(getDevLoginKeyVersion()).toBeNull();
  });

  it("config 不在 (prod) なら null", () => {
    delete process.env.DEV_LOGIN_CONFIG;
    expect(getDevLoginKeyVersion()).toBeNull();
  });
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
