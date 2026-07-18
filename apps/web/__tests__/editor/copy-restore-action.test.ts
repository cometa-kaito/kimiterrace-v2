import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * restoreCopySnapshotAction（コピー「元に戻す」）のセキュリティ配線テスト。next/cache・guard・db を mock
 * （`@kimiterrace/db` は mock しない＝withSession を mock するので tx は実行されない・schedule-actions.test と同作法）。
 *
 * 重点（本 action は client 由来スナップショットを書き戻すため）:
 * - 書込前に**エディタ保存と同じバリデータで再検証**し、不正なら DB に到達せず invalid（`upsertDailySectionForTarget`
 *   は無検証で書くので、この fail-closed 再検証が任意 JSON 注入の唯一の防壁）。認可より前に弾く（DB も認可も走らせない）。
 * - system_admin は対象校未指定で forbidden（fail-closed）。
 * - tenantScoped 自校スコープを withSession へ伝播。実際の RLS/越境封じは packages/db の実 PG テスト（書込コア）に委譲。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { restoreCopySnapshotAction } from "../../lib/editor/copy-day-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SYS_UID = "77777777-7777-4777-8777-777777777777";
const teacher = { uid: USER_ID, role: "teacher" as const, schoolId: SCHOOL_ID };

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(teacher);
  // withSession は tx を実行せず結果だけ返す（配線検証）。実際の書込・RLS は書込コアの実 PG テストに委譲。
  withSessionMock.mockResolvedValue({ kind: "ok", daysRestored: 1 });
});

describe("restoreCopySnapshotAction（元に戻す）", () => {
  it("スナップショットが配列でない / 空 は invalid（認可も DB も走らせない）", async () => {
    expect(await restoreCopySnapshotAction(CLASS_ID, null)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await restoreCopySnapshotAction(CLASS_ID, [])).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不正な日付のスナップショットは invalid（DB 到達前）", async () => {
    const res = await restoreCopySnapshotAction(CLASS_ID, [{ date: "2026-02-30", schedule: [] }]);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不正なブロック内容（空科目の予定）は再検証で弾き、DB に到達しない（任意 JSON 注入の防壁）", async () => {
    const res = await restoreCopySnapshotAction(CLASS_ID, [
      { date: "2026-06-01", schedule: [{ period: 1, subject: "  " }] },
    ]);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("system_admin は対象校未指定で forbidden（fail-closed・書込せず）", async () => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
    const res = await restoreCopySnapshotAction(CLASS_ID, [
      { date: "2026-06-01", schedule: [{ period: 1, subject: "数学" }] },
    ]);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("正常系（teacher・妥当なスナップショット）: 自校 tenantScoped を withSession へ伝播して復元", async () => {
    const res = await restoreCopySnapshotAction(CLASS_ID, [
      { date: "2026-06-01", schedule: [{ period: 1, subject: "数学" }] },
    ]);
    expect(res).toEqual({ ok: true, data: { daysRestored: 1 } });
    const call = withSessionMock.mock.calls[0] as unknown as [unknown, unknown];
    expect(call[1]).toEqual({ tenantScoped: true, schoolId: SCHOOL_ID });
  });
});
