import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F02 (#38, FR-08): 教員入力履歴ページの認可配線 + 行マッピングのテスト。
 * guard / db / @kimiterrace/db を mock し、teacher/school_admin 限定 (requireRole) と
 * withSession 経由 listTeacherInputs 呼び出し、transcript 抜粋 (truncate) を固定する。
 * 非 staff の 403 は requireRole の throw 再現で DB 非到達を担保 (RLS 0 件は packages/db が担保)。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("@kimiterrace/db", () => ({ listTeacherInputs: vi.fn() }));

import { listTeacherInputs } from "@kimiterrace/db";
import TeacherInputHistoryPage from "../../app/admin/teacher-input/history/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { TEACHER_INPUT_STAFF_ROLES } from "../../lib/teacher-input/roles";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const listMock = vi.mocked(listTeacherInputs);

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({ uid: "t1", role: "teacher", schoolId: "s1" } as never);
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn({}, { uid: "t1", role: "teacher", schoolId: "s1" }))) as typeof withSession);
});

describe("TeacherInputHistoryPage", () => {
  it("teacher/school_admin 限定 + listTeacherInputs を withSession 経由で呼ぶ", async () => {
    listMock.mockResolvedValue([] as never);
    await TeacherInputHistoryPage();
    expect(requireRoleMock).toHaveBeenCalledWith(TEACHER_INPUT_STAFF_ROLES);
    expect(withSessionMock).toHaveBeenCalledOnce();
    expect(listMock).toHaveBeenCalledOnce();
  });

  it("件数と状態ラベルを描画し、長い transcript は抜粋する", async () => {
    const longText = "あ".repeat(200);
    listMock.mockResolvedValue([
      {
        id: "a",
        inputType: "chat",
        status: "ready",
        transcript: longText,
        submittedAt: null,
        createdAt: new Date("2026-05-31T00:00:00.000Z"),
      },
      {
        id: "b",
        inputType: "voice",
        status: "submitted",
        transcript: null,
        submittedAt: new Date("2026-05-31T02:00:00.000Z"),
        createdAt: new Date("2026-05-31T01:00:00.000Z"),
      },
    ] as never);

    render(await TeacherInputHistoryPage());
    expect(screen.getByText("2 件")).toBeInTheDocument();
    expect(screen.getByText("準備完了")).toBeInTheDocument();
    expect(screen.getByText("送信済み")).toBeInTheDocument();
    // 200 文字は 80 文字 + 省略記号に truncate される。
    const preview = screen.getByText(/^あ+…$/);
    expect(preview.textContent ?? "").toHaveLength(81); // 80 文字 + …
    // transcript が null の行は（本文なし）。
    expect(screen.getByText("（本文なし）")).toBeInTheDocument();
  });
});
