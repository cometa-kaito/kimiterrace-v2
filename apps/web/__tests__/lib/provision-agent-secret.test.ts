import { afterEach, describe, expect, it } from "vitest";
import {
  getConfiguredProvisionAgentSecret,
  verifyProvisionAgentSecret,
} from "../../lib/tv/provision-agent-secret";

/**
 * C方式 TV プロビジョニング エージェント API 専用シークレット検証の単体テスト
 * （定数時間比較 + fail-closed）。TV_POLL_SECRET とは別の `PROVISION_AGENT_SECRET` を読む。
 */
describe("provision-agent secret 検証", () => {
  const prev = process.env.PROVISION_AGENT_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.PROVISION_AGENT_SECRET;
    else process.env.PROVISION_AGENT_SECRET = prev;
  });

  it("一致で true", () => {
    expect(verifyProvisionAgentSecret("agent-s3cret", "agent-s3cret")).toBe(true);
  });

  it("不一致で false", () => {
    expect(verifyProvisionAgentSecret("wrong", "agent-s3cret")).toBe(false);
  });

  it("長さ違いでも例外を投げず false（SHA-256 固定長比較で定数時間化）", () => {
    expect(verifyProvisionAgentSecret("short", "a-much-longer-agent-secret-value")).toBe(false);
  });

  it("null / undefined / 空文字の provided は false", () => {
    expect(verifyProvisionAgentSecret(null, "s")).toBe(false);
    expect(verifyProvisionAgentSecret(undefined, "s")).toBe(false);
    expect(verifyProvisionAgentSecret("", "s")).toBe(false);
  });

  it("env 未設定で getConfiguredProvisionAgentSecret は null（fail-closed）", () => {
    delete process.env.PROVISION_AGENT_SECRET;
    expect(getConfiguredProvisionAgentSecret()).toBe(null);
  });

  it("env 空文字でも null（fail-closed）", () => {
    process.env.PROVISION_AGENT_SECRET = "";
    expect(getConfiguredProvisionAgentSecret()).toBe(null);
  });

  it("env 設定で getConfiguredProvisionAgentSecret は値", () => {
    process.env.PROVISION_AGENT_SECRET = "abc123";
    expect(getConfiguredProvisionAgentSecret()).toBe("abc123");
  });
});
