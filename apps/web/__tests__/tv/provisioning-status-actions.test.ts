import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C方式 TV プロビジョニング ライブ進捗 Server Action `getProvisioningJobStatusAction` の配線テスト。
 * guard / db / `@kimiterrace/db` の `getProvisioningJob` を mock し、認可 → UUID 検証 → 取得 → 最小射影返却
 * （秘密非格納）を検証する。実 RLS は packages/db で担保。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

// vi.mock factory が参照する mock は vi.hoisted で先に初期化（top-level const 直接参照は TDZ load 失敗）。
const { getProvisioningJob } = vi.hoisted(() => ({ getProvisioningJob: vi.fn() }));
vi.mock("@kimiterrace/db", () => ({
  getProvisioningJob: (...args: unknown[]) => getProvisioningJob(...args),
}));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { getProvisioningJobStatusAction } from "../../lib/tv/provisioning-status-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const JOB = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({ uid: "sysadmin", role: "system_admin", schoolId: null });
  getProvisioningJob.mockResolvedValue({
    status: "preflight",
    currentStep: "県Wi-Fi設定キャプチャ",
    stepsJson: [{ name: "preflight", status: "ok" }],
    error: null,
    signageUrl: "https://app.school-signage.net/signage/tok",
    deviceId: "dev-1",
  });
  withSessionMock.mockImplementation(((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({}))) as typeof withSession);
});

describe("getProvisioningJobStatusAction", () => {
  it("system_admin を認可し、進捗の最小射影を返す（秘密非格納）", async () => {
    const res = await getProvisioningJobStatusAction(JOB);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
    expect(res).toMatchObject({
      status: "preflight",
      currentStep: "県Wi-Fi設定キャプチャ",
      deviceId: "dev-1",
      signageUrl: "https://app.school-signage.net/signage/tok",
    });
    expect(Array.isArray((res as { steps: unknown }).steps)).toBe(true);
  });

  it("jobId が UUID でなければ DB に到達せず null（認可は通す）", async () => {
    const res = await getProvisioningJobStatusAction("not-a-uuid");
    expect(res).toBeNull();
    expect(requireRoleMock).toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不可視 / 不存在（getProvisioningJob が null）→ null", async () => {
    getProvisioningJob.mockResolvedValue(null);
    const res = await getProvisioningJobStatusAction(JOB);
    expect(res).toBeNull();
  });
});
