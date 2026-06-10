import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324, ADR-026): setStaffActiveAction (system_admin 全校横断 無効化/再有効化) の配線テスト。
 * next/cache・guard・db・IdP seam を mock。
 *
 * 教員アカウント概念の撤去 (2026-06-10): 対象は school_admin のみ。教員 (共通PW・系統A) は個別アカウントを
 * 持たないためこの汎用トグルの対象外 (not_staff/forbidden)。ロール変更 (changeStaffRoleAction) は撤去済。
 *
 * 検証する不変条件:
 * - 入力検証 (uuid / boolean) は IdP / DB に到達しない。
 * - 学校管理者以外 (teacher/student/guardian) は forbidden。
 * - **last-admin ガード**: 学校で唯一の有効な school_admin の無効化は conflict (IdP を呼ばない)。
 *   有効管理者が複数なら通る。再有効化はガード対象外。
 * - **last-admin TOCTOU 根治 (#355 Low-2)**: gate を通過しても mirror tx の FOR UPDATE 再カウントが
 *   最後の 1 人を検出したら、IdP を補償 (再有効化) して conflict を返し、DB mirror は未更新。
 * - **IdP-first 順序** (ADR-026): IdP が失敗したら DB mirror に到達しない。
 * - 監査: table=users / op=update / **school_id=対象校** / **actor NULL (system_admin)** / diff before-after。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/auth/admin-mutations", () => ({
  deactivateIdpUser: vi.fn(),
  reactivateIdpUser: vi.fn(),
}));

// #395 L1: race パスの構造化ログ (logger.warn) を spy する。createLogger はモジュール import 時に 1 回
// 呼ばれるため warnMock を hoisted で先に確保し、その同一参照を返す。
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("@kimiterrace/observability", () => ({
  createLogger: () => ({
    warn: warnMock,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }),
  redactPii: (p: unknown) => p,
  initTracer: vi.fn(),
  withSpan: (_n: unknown, fn: () => unknown) => fn(),
  buildLoggerOptions: vi.fn(),
}));

import { auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { deactivateIdpUser, reactivateIdpUser } from "../../lib/auth/admin-mutations";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { setStaffActiveAction } from "../../lib/system-admin/users-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);
const deactivateMock = vi.mocked(deactivateIdpUser);
const reactivateMock = vi.mocked(reactivateIdpUser);

const SYS_UID = "99999999-9999-4999-8999-999999999999";
const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const TEACHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

// fakeTx の振る舞いを各テストで差し替える状態。
let targetRow: { role: string; isActive: boolean; schoolId: string } | undefined;
let activeAdminCount: number; // gate の last-admin count(*) 戻り値 (lock 無し)
let lockedAdminCount: number | null; // mirror tx の FOR UPDATE 再カウント (#355)。null なら activeAdminCount を流用。
let updateRows: { id: string }[];
let updateValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
// #395 L2: mirror UPDATE の `returning()` を reject させて DB トリガの KT001 を模す (null なら正常解決)。
let updateError: unknown;

function fakeTx() {
  return {
    // where() の戻り値を 3 つの呼び出し形に同時対応させる (drizzle の thenable query builder を模す):
    //  - gate の last-admin count: select({n}).from().where() を直接 await → [{ n: activeAdminCount }]
    //  - 対象取得: select({...}).from().where().limit(1) → [targetRow]
    //  - mirror tx の TOCTOU 再カウント: select({id}).from().where().for("update") → lockedAdminCount 行
    select: () => ({
      from: () => ({
        where: (..._a: unknown[]) =>
          Object.assign(Promise.resolve([{ n: activeAdminCount }]), {
            limit: () => Promise.resolve(targetRow ? [targetRow] : []),
            for: (..._f: unknown[]) =>
              Promise.resolve(
                Array.from({ length: lockedAdminCount ?? activeAdminCount }, (_v, i) => ({
                  id: `admin-${i}`,
                })),
              ),
          }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateValues = v;
        return {
          where: () => ({
            returning: () =>
              updateError ? Promise.reject(updateError) : Promise.resolve(updateRows),
          }),
        };
      },
    }),
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
  requireRoleMock.mockResolvedValue(sysAdmin);
  deactivateMock.mockResolvedValue(undefined);
  reactivateMock.mockResolvedValue(undefined);
  // 既定は有効な school_admin が複数いる学校の管理者 (last-admin ガードを通過する正常系の土台)。
  targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
  activeAdminCount = 2;
  lockedAdminCount = null;
  updateRows = [{ id: TEACHER_ID }];
  updateValues = null;
  auditValues = null;
  updateError = undefined;
  // 各 withSession 呼び出しに新しい fakeTx を渡す (read tx と write tx で select カウンタを分ける)。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("setStaffActiveAction (#324 system_admin 全校無効化)", () => {
  it("userId が UUID でないと invalid、認可も IdP も DB も走らせない", async () => {
    const res = await setStaffActiveAction({ userId: "nope", isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("isActive が boolean でないと invalid", async () => {
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: 1 });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が redirect (throw) し DB/IdP に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(setStaffActiveAction({ userId: TEACHER_ID, isActive: false })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象が見つからないと not_found、IdP を呼ばない", async () => {
    targetRow = undefined;
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("対象が学校管理者以外 (student) は forbidden、IdP を呼ばない", async () => {
    targetRow = { role: "student", isActive: true, schoolId: SCHOOL_ID };
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("対象が教員 (共通PW・系統A) は forbidden、IdP を呼ばない (教員アカウント概念の撤去で汎用トグル対象外)", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("last-admin ガード: 学校で唯一の有効な school_admin の無効化は conflict、IdP を呼ばない", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 1; // 自分しか有効な管理者がいない
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("有効な school_admin が複数なら無効化できる (last-admin ガード通過)", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 2;
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toEqual({ ok: true, data: { id: ADMIN_ID, isActive: false } });
    expect(deactivateMock).toHaveBeenCalledWith(ADMIN_ID);
  });

  it("TOCTOU レース (#355 Low-2): gate 通過後 mirror tx の FOR UPDATE 再カウントが最後の 1 人を検出 → IdP 補償 + conflict", async () => {
    // gate は lock 無し count=2 で通過するが、並行無効化が間に commit され mirror tx の FOR UPDATE
    // 再カウントは 1 を返す (= この無効化で学校が管理者ゼロになる)。
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 2;
    lockedAdminCount = 1;
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    // IdP revoke は ADR-026 IdP-first ゆえ確定済 → 補償で再有効化される。
    expect(deactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    expect(reactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    // mirror tx は番兵でロールバック: UPDATE / 監査に到達せず revalidate もしない。
    expect(updateValues).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
    // #395 L1: race パスは audit に残らないため IdP 往復を構造化ログで 1 件記録する。
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "last_admin_race_detected",
        action: "deactivate",
        detectedBy: "app_recount",
        schoolId: SCHOOL_ID,
        targetUserId: ADMIN_ID,
        compensation: "reactivate_idp_user",
      }),
      expect.any(String),
    );
  });

  it("DB トリガ (#395 L2): app 再カウント通過後に UPDATE が KT001 → seam バイパス検出として補償 + conflict (detectedBy=db_trigger_kt001)", async () => {
    // gate も app 層 FOR UPDATE 再カウント (lockedAdminCount=2) も通過するが、UPDATE 自体を DB トリガが
    // KT001 で弾く = seam をバイパスする経路 (直 SQL/バッチ) が DB の最終砦に捕まった状況。drizzle は pg
    // エラーを DrizzleQueryError でラップし SQLSTATE を `.cause.code` に入れるため、その形で投げる。
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 2;
    lockedAdminCount = 2; // app 層の番兵は発火しない (= LastAdminRaceError 経路でない)
    updateError = Object.assign(new Error("DrizzleQueryError"), { cause: { code: "KT001" } });
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    // IdP-first revoke は確定済 → 補償で再有効化 (app_recount 経路と同じ補償に合流)。
    expect(deactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    expect(reactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    // mirror tx は KT001 でロールバック: 監査未到達・revalidate しない。
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
    // L1 ログは app_recount でなく db_trigger_kt001 と記録する (seam バイパスの異常シグナル)。
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "last_admin_race_detected",
        action: "deactivate",
        detectedBy: "db_trigger_kt001",
        schoolId: SCHOOL_ID,
        targetUserId: ADMIN_ID,
        compensation: "reactivate_idp_user",
      }),
      expect.any(String),
    );
  });

  it("school_admin の再有効化は last-admin ガード対象外 (count を見ずに通る)", async () => {
    targetRow = { role: "school_admin", isActive: false, schoolId: SCHOOL_ID };
    activeAdminCount = 0;
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: true });
    expect(res).toEqual({ ok: true, data: { id: ADMIN_ID, isActive: true } });
    expect(reactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("正常系 無効化: IdP deactivate → DB mirror is_active=false + updated_at 明示 → revalidate", async () => {
    // 有効な school_admin が複数 (activeAdminCount=2) の学校管理者を無効化する (last-admin ガード通過)。
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toEqual({ ok: true, data: { id: ADMIN_ID, isActive: false } });
    expect(deactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    expect(updateValues).toMatchObject({ isActive: false, updatedBy: null });
    expect(updateValues?.updatedAt).toBeInstanceOf(Date);
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/system/users");
    // #395 L1: 正常系では race ログを出さない (race パス専用)。
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("監査: table=users / op=update / school_id=対象校 / actor NULL (system_admin) / diff before-after", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: SCHOOL_ID,
      createdBy: null,
      updatedBy: null,
      tableName: "users",
      recordId: ADMIN_ID,
      operation: "update",
    });
    expect(auditValues?.diff).toEqual({ before: { isActive: true }, after: { isActive: false } });
  });

  it("ADR-026 順序: IdP が失敗したら DB mirror に到達しない (安全側)", async () => {
    deactivateMock.mockRejectedValue(new Error("idp down"));
    await expect(setStaffActiveAction({ userId: ADMIN_ID, isActive: false })).rejects.toThrow(
      "idp down",
    );
    expect(updateValues).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
