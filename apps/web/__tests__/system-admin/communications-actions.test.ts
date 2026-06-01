import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): createCommunicationAction の配線テスト。next/cache・guard・db を mock。fakeTx は
 * communications の insert().values().returning() と audit の insert().values() を提供する。
 * 検証失敗・認可 (system_admin)・監査 (school_id/actor NULL, table=communications, op=insert,
 * occurred_at ISO)・FK 違反 (存在しない広告主/契約) → not_found を確認する。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createCommunicationAction } from "../../lib/system-admin/communications-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COMM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

let commValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
let returningRows: { id: string }[];
let fkViolation: boolean;

function fakeTx() {
  return {
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) {
          auditValues = v;
          return Promise.resolve(undefined);
        }
        commValues = v;
        return {
          returning: () =>
            fkViolation ? Promise.reject({ code: "23503" }) : Promise.resolve(returningRows),
        };
      },
    }),
  };
}

function validRaw(over: Record<string, unknown> = {}) {
  return {
    advertiserId: ADV_ID,
    contractId: CONTRACT_ID,
    channel: "meeting",
    occurredAt: "2026-04-01T09:00:00+09:00",
    subject: "初回商談",
    bodyMd: "# 議事録",
    attachments: ["bucket/minutes.pdf"],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  commValues = null;
  auditValues = null;
  returningRows = [{ id: COMM_ID }];
  fkViolation = false;
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("createCommunicationAction", () => {
  it("検証失敗 (channel 不正) は invalid を返し、認可も DB も走らせない", async () => {
    const res = await createCommunicationAction(validRaw({ channel: "fax" }));
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await createCommunicationAction(validRaw());
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("成功: communications に正しい値で INSERT し id を返す", async () => {
    const res = await createCommunicationAction(validRaw());
    expect(res).toEqual({ ok: true, data: { id: COMM_ID } });
    expect(commValues).toMatchObject({
      advertiserId: ADV_ID,
      contractId: CONTRACT_ID,
      channel: "meeting",
      subject: "初回商談",
      bodyMd: "# 議事録",
      attachmentsJson: ["bucket/minutes.pdf"],
      // system_admin は users 行でないため actor は NULL (ルール1)。
      createdBy: null,
      updatedBy: null,
    });
    // offset 付き入力が UTC instant に正規化されている。
    expect((commValues?.occurredAt as Date).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/admin/system/advertisers/${ADV_ID}/edit`);
  });

  it("監査: table=communications / op=insert / school_id・actor NULL / occurred_at は ISO", async () => {
    await createCommunicationAction(validRaw());
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: null,
      tableName: "communications",
      recordId: COMM_ID,
      operation: "insert",
      createdBy: null,
      updatedBy: null,
    });
    const after = (auditValues?.diff as { after: Record<string, unknown> }).after;
    expect(after.occurredAt).toBe("2026-04-01T00:00:00.000Z");
    expect(after.contractId).toBe(CONTRACT_ID);
    expect(after.channel).toBe("meeting");
  });

  it("存在しない広告主/契約 (FK 23503) は not_found を返す", async () => {
    fkViolation = true;
    const res = await createCommunicationAction(validRaw());
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
