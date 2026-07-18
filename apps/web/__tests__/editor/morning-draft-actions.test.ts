import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * confirmMorningDraftAction（朝ドラフト確定・PR-Z2）のセキュリティ配線テスト。next/cache・guard・db を mock
 * （`@kimiterrace/db` は mock しない＝withSession を mock するので tx は実行されない・copy-restore-action.test と
 * 同作法）。合成ロジック自体の正しさは buildMorningDraft の純関数ユニット（morning-draft-core.test）が担う。
 *
 * 重点:
 * - 入力検証（クラス / 日付）は認可・DB より前に弾く（DB も認可も走らせない）。
 * - system_admin は対象校未指定で forbidden（fail-closed・コピー系と同判断）。
 * - tenantScoped 自校スコープを withSession へ伝播（実 RLS/越境封じは packages/db の実 PG テストへ委譲）。
 * - tx 結果 kind（not_found / empty / ok）を正しく ActionResult へ写す。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { confirmMorningDraftAction } from "../../lib/editor/morning-draft-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SYS_UID = "77777777-7777-4777-8777-777777777777";
const DATE = "2026-07-13";
const teacher = { uid: USER_ID, role: "teacher" as const, schoolId: SCHOOL_ID };

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(teacher);
});

describe("confirmMorningDraftAction（朝ドラフト確定）", () => {
  it("クラス指定が不正なら invalid（認可も DB も走らせない）", async () => {
    expect(await confirmMorningDraftAction("not-a-uuid", DATE, [])).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("日付が不正なら invalid（DB 到達前）", async () => {
    expect(await confirmMorningDraftAction(CLASS_ID, "2026-02-30", [])).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("system_admin は対象校未指定で forbidden（fail-closed・DB 到達前）", async () => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
    expect(await confirmMorningDraftAction(CLASS_ID, DATE, [])).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("正常系（teacher）: 自校 tenantScoped を withSession へ伝播し、確定結果を写す", async () => {
    const undo = { date: DATE, schedule: [] as unknown[] };
    withSessionMock.mockResolvedValue({
      kind: "ok",
      sections: [{ block: "schedule", label: "予定", count: 3 }],
      undo,
    });
    const res = await confirmMorningDraftAction(CLASS_ID, DATE, ["schedules:event:x"]);
    expect(res).toEqual({
      ok: true,
      data: { date: DATE, sections: [{ block: "schedule", label: "予定", count: 3 }], undo },
    });
    const call = withSessionMock.mock.calls[0] as unknown as [unknown, unknown];
    expect(call[1]).toEqual({ tenantScoped: true, schoolId: SCHOOL_ID });
  });

  it("クラス不可視（tx not_found）は invalid へ写す", async () => {
    withSessionMock.mockResolvedValue({ kind: "not_found" });
    expect(await confirmMorningDraftAction(CLASS_ID, DATE, [])).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("合成が空（tx empty・既入力/休日/全除外）は invalid へ写す", async () => {
    withSessionMock.mockResolvedValue({ kind: "empty" });
    expect(await confirmMorningDraftAction(CLASS_ID, DATE, [])).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("excluded が配列でなくても落ちない（string 以外は無視して確定に進む）", async () => {
    withSessionMock.mockResolvedValue({
      kind: "ok",
      sections: [{ block: "notice", label: "連絡", count: 1 }],
      undo: { date: DATE, notice: [] },
    });
    const res = await confirmMorningDraftAction(CLASS_ID, DATE, "not-an-array");
    expect(res).toMatchObject({ ok: true });
    expect(withSessionMock).toHaveBeenCalledTimes(1);
  });
});
