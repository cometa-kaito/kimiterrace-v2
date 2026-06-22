import { afterEach, describe, expect, it } from "vitest";
import { isProdLikeEnv, isStagingEnv } from "../../lib/auth/app-env";
import {
  getDevLoginConfig,
  getDevLoginKeyVersion,
  getDevLoginResolveHint,
  toDevLoginRole,
  verifyDevLoginKey,
} from "../../lib/auth/dev-login-config";

/**
 * staging 限定 dev-login の **多層防御の素**（env ゲート / ゲート鍵突合 / config パース / ロール allowlist）を
 * pure に固定する。route 統合テスト（dev-login-route.test.ts）と合わせて「prod では機能しない」を担保する。
 *
 * **パスワードレス化後**: config は **ゲート鍵（secret）のみ必須**で、teacher/admin の password は持たない
 * （任意の解決ヒント schoolId/uid だけ）。password を required にする旧テストは撤廃した。
 */

const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_CONFIG = process.env.DEV_LOGIN_CONFIG;
const ORIGINAL_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;

// 新・最小 config: secret のみ必須（password 無し）。任意で解決ヒント（schoolId/uid）。
const VALID_CONFIG = JSON.stringify({
  secret: "super-long-staging-only-secret-value",
  keyVersion: "2026-06",
  teacher: { schoolId: "22222222-2222-4222-8222-222222222222" },
  admin: { uid: "33333333-3333-4333-8333-333333333333" },
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

  it("keyVersion 未設定なら null（config は有効のまま・secret だけで足りる）", () => {
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({ secret: "x-very-long-secret" });
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
  it("正しい JSON を解決（secret + 任意ヒント。password は持たない）", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    const config = getDevLoginConfig();
    expect(config?.secret).toBe("super-long-staging-only-secret-value");
    expect(config?.teacher?.schoolId).toBe("22222222-2222-4222-8222-222222222222");
    expect(config?.admin?.uid).toBe("33333333-3333-4333-8333-333333333333");
    // password が残っていても拾わない（型にも存在しない＝秘密を持ち回らない）。
    expect(JSON.stringify(config)).not.toContain("password");
  });

  it("secret のみでも有効（teacher/admin ヒントは任意 → null）", () => {
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({ secret: "only-the-gate-key-value" });
    const config = getDevLoginConfig();
    expect(config?.secret).toBe("only-the-gate-key-value");
    expect(config?.teacher).toBeNull();
    expect(config?.admin).toBeNull();
  });

  it("config に password が混入していても無視する（拾わない）", () => {
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({
      secret: "gate-key",
      teacher: { schoolId: "abc", password: "leak" },
    });
    expect(JSON.stringify(getDevLoginConfig())).not.toContain("leak");
  });

  it("env 未設定 → null (prod 既定)", () => {
    delete process.env.DEV_LOGIN_CONFIG;
    expect(getDevLoginConfig()).toBeNull();
  });

  it("不正 JSON → null", () => {
    process.env.DEV_LOGIN_CONFIG = "{not json";
    expect(getDevLoginConfig()).toBeNull();
  });

  it("secret 欠落 → null（teacher/admin だけでは機能しない）", () => {
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({ teacher: { schoolId: "x" }, admin: {} });
    expect(getDevLoginConfig()).toBeNull();
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({ keyVersion: "2026-06" });
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

describe("getDevLoginResolveHint — 任意の解決ヒント（password は無い）", () => {
  it("ロールに対応するヒント（teacher=schoolId / admin=uid）を返す", () => {
    process.env.DEV_LOGIN_CONFIG = VALID_CONFIG;
    expect(getDevLoginResolveHint("teacher")?.schoolId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(getDevLoginResolveHint("admin")?.uid).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("ヒント未設定（secret のみ）は null（= DB から既存解決 or 冪等作成へ）", () => {
    process.env.DEV_LOGIN_CONFIG = JSON.stringify({ secret: "gate-key-only" });
    expect(getDevLoginResolveHint("teacher")).toBeNull();
    expect(getDevLoginResolveHint("admin")).toBeNull();
  });

  it("config 不在は null", () => {
    delete process.env.DEV_LOGIN_CONFIG;
    expect(getDevLoginResolveHint("teacher")).toBeNull();
  });
});
