import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#47, ADR-031): recordMfaEnrollmentAudit の配線テスト。guard / db / IdP 件数 seam を mock。
 *
 * 検証する不変条件:
 * - 入力検証: op は "enroll" | "unenroll" のみ。不正は認可・IdP・DB に到達しない。
 * - 認可: requireRole(MFA_REQUIRED_ROLES=teacher 以上) を呼ぶ (生徒/保護者は redirect)。
 * - actor = target = 自分: uid は session 由来 (requireRole 戻り値)。外部入力の uid を受け取らない。
 * - 件数は IdP 再読 (getEnrolledMfaFactorCount) の authoritative 値で、クライアント申告を信用しない。
 * - 監査: table=users / op=update / actor=自分 / record_id=自分 / diff に op と件数のみ (PII なし)。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withUserSession: vi.fn() }));
vi.mock("../../lib/auth/mfa-admin", () => ({ getEnrolledMfaFactorCount: vi.fn() }));

import { auditLog } from "@kimiterrace/db";
import { requireRole } from "../../lib/auth/guard";
import { getEnrolledMfaFactorCount } from "../../lib/auth/mfa-admin";
import { withUserSession } from "../../lib/db";
import { recordMfaEnrollmentAudit } from "../../lib/mfa/enrollment-actions";

const requireRoleMock = vi.mocked(requireRole);
const withUserSessionMock = vi.mocked(withUserSession);
const factorCountMock = vi.mocked(getEnrolledMfaFactorCount);

const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const TEACHER_UID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SA_UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teacher = { uid: TEACHER_UID, role: "teacher" as const, schoolId: SCHOOL_ID };
const systemAdmin = { uid: SA_UID, role: "system_admin" as const, schoolId: null };

let auditValues: Record<string, unknown> | null;

function fakeTx() {
  return {
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) {
          auditValues = v;
        }
        return Promise.resolve(undefined);
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditValues = null;
  requireRoleMock.mockResolvedValue(teacher);
  factorCountMock.mockResolvedValue(1);
  withUserSessionMock.mockImplementation(((_user: unknown, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx()))) as typeof withUserSession);
});

describe("recordMfaEnrollmentAudit (#47 ADR-031)", () => {
  it("op が不正だと invalid、認可・IdP・DB に到達しない", async () => {
    const res = await recordMfaEnrollmentAudit({ op: "delete" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(factorCountMock).not.toHaveBeenCalled();
    expect(withUserSessionMock).not.toHaveBeenCalled();
  });

  it("op 未指定でも invalid", async () => {
    const res = await recordMfaEnrollmentAudit({});
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withUserSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を MFA_REQUIRED_ROLES (teacher 以上) で呼ぶ", async () => {
    await recordMfaEnrollmentAudit({ op: "enroll" });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin", "school_admin", "teacher"]);
  });

  it("生徒/保護者は requireRole が redirect (throw) し IdP/DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(recordMfaEnrollmentAudit({ op: "enroll" })).rejects.toThrow("NEXT_REDIRECT");
    expect(factorCountMock).not.toHaveBeenCalled();
    expect(withUserSessionMock).not.toHaveBeenCalled();
  });

  it("件数は IdP 再読 (getEnrolledMfaFactorCount) の authoritative 値 — クライアント申告でなく session uid で問い合わせる", async () => {
    factorCountMock.mockResolvedValue(2);
    const res = await recordMfaEnrollmentAudit({ op: "enroll" });
    // 入力に件数は存在しない。返す件数は IdP 由来。
    expect(factorCountMock).toHaveBeenCalledWith(TEACHER_UID);
    expect(res).toEqual({ ok: true, data: { enrolledFactorCount: 2 } });
  });

  it("監査: table=users / op=update / actor=自分 / record_id=自分 / school_id=自校", async () => {
    factorCountMock.mockResolvedValue(1);
    await recordMfaEnrollmentAudit({ op: "enroll" });
    expect(auditValues).toMatchObject({
      actorUserId: TEACHER_UID,
      schoolId: SCHOOL_ID,
      tableName: "users",
      recordId: TEACHER_UID,
      operation: "update",
    });
  });

  it("監査 diff は op と件数のみ — PII (電話番号・factor uid・secret) を残さない (ルール4)", async () => {
    factorCountMock.mockResolvedValue(1);
    await recordMfaEnrollmentAudit({ op: "enroll" });
    expect(auditValues?.diff).toEqual({ mfa: { op: "enroll", enrolledFactorCount: 1 } });
    // diff を JSON 化して PII らしき語が無いことも明示的に pin (非空虚)。
    const serialized = JSON.stringify(auditValues?.diff);
    expect(serialized).not.toMatch(/phone|secret|qr|tel|\+\d/i);
  });

  it("unenroll でも IdP 再読の件数で監査 (解除後の件数を残す)", async () => {
    factorCountMock.mockResolvedValue(0);
    const res = await recordMfaEnrollmentAudit({ op: "unenroll" });
    expect(res).toEqual({ ok: true, data: { enrolledFactorCount: 0 } });
    expect(auditValues?.diff).toEqual({ mfa: { op: "unenroll", enrolledFactorCount: 0 } });
  });

  it("system_admin (school_id=null) でも監査できる (cross-tenant、audit_log は null school_id 許容)", async () => {
    requireRoleMock.mockResolvedValue(systemAdmin);
    factorCountMock.mockResolvedValue(1);
    await recordMfaEnrollmentAudit({ op: "enroll" });
    expect(factorCountMock).toHaveBeenCalledWith(SA_UID);
    expect(auditValues).toMatchObject({ actorUserId: SA_UID, schoolId: null });
  });

  it("withUserSession に解決済み user (自分) を渡す — 自分の context でのみ監査を書く", async () => {
    await recordMfaEnrollmentAudit({ op: "enroll" });
    expect(withUserSessionMock).toHaveBeenCalledTimes(1);
    expect(withUserSessionMock.mock.calls[0]?.[0]).toEqual(teacher);
  });
});
