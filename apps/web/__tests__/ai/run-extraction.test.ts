import { PiiLeakError, RateLimitExceededError, type StructureResult } from "@kimiterrace/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../lib/auth/session";

/**
 * F03 (#154 item 2): `runAndPersistExtraction` の配線検証。
 *
 * 教員入力 API 同様、DB は使わず `lib/db` の `withUserSession` と `@kimiterrace/db` の
 * `insertAiExtraction` をモックして「認証 → role ゲート → 抽出 → 監査 INSERT」の配線を突く。
 * RLS / 監査の実挙動は packages/db の RLS テスト（ai-extractions）+ CI 実走（実 PG）で担保する。
 * 抽出本体（LLM）は `runStructuredExtraction` の `deps.structure` 注入で差し替える。
 *
 * モック値は `vi.hoisted` で先に初期化する（vi.mock は import 上にホイストされるため、
 * factory から参照するエラークラス/スパイは hoisted ブロックで用意しないと TDZ になる）。
 */
const mocks = vi.hoisted(() => {
  // lib/db のエラークラス相当（テスト用）。adapter はこれらを throw し、テストも instanceof で突く。
  class UnauthenticatedError extends Error {}
  class ForbiddenError extends Error {}
  return {
    getCurrentUser: vi.fn<() => Promise<AuthUser | null>>(),
    // withUserSession は (user, fn) で fn を fake tx で実行する pass-through。
    withUserSession: vi.fn(async (_user: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __fakeTx: true }),
    ),
    insertAiExtraction: vi.fn(async (_tx: unknown, _row: unknown) => "extraction-id"),
    UnauthenticatedError,
    ForbiddenError,
  };
});

vi.mock("../../lib/auth/session", () => ({ getCurrentUser: () => mocks.getCurrentUser() }));
vi.mock("../../lib/db", () => ({
  withUserSession: (u: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    mocks.withUserSession(u, fn),
  UnauthenticatedError: mocks.UnauthenticatedError,
  ForbiddenError: mocks.ForbiddenError,
}));
vi.mock("@kimiterrace/db", () => ({
  insertAiExtraction: (tx: unknown, row: unknown) => mocks.insertAiExtraction(tx, row),
}));

import { runAndPersistExtraction } from "../../lib/ai/run-extraction";

const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";
const TEACHER: AuthUser = {
  uid: "11111111-1111-1111-1111-111111111111",
  role: "teacher",
  schoolId: SCHOOL_ID,
};

/** 直近に insertAiExtraction へ渡された監査行 (called 済を前提に narrow)。 */
function insertedRow(): Record<string, unknown> {
  const call = mocks.insertAiExtraction.mock.calls.at(-1);
  if (!call) {
    throw new Error("insertAiExtraction was not called");
  }
  return call[1] as Record<string, unknown>;
}

/** テスト用 StructureResult（既定は成功）。`toAiExtractionInsert` が読む列のみ意味を持つ。 */
function structureResult(overrides: Partial<StructureResult> = {}): StructureResult {
  return {
    status: "success",
    kind: "schedule",
    extraction: null,
    confidenceScore: 0.9,
    modelVersion: "gemini-test",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    rawInputHash: "a".repeat(64),
    attempts: 1,
    errorMessage: null,
    ...overrides,
  };
}

/** request は schoolId を含まない（adapter がセッションで上書きする契約）。model はダミー（structure を注入差替）。 */
function baseParams() {
  return {
    request: {
      kind: "schedule" as const,
      input: "1限 数学",
      // biome-ignore lint/suspicious/noExplicitAny: structure を deps で差し替えるため model は未使用
      model: {} as any,
    },
  };
}

afterEach(() => {
  mocks.getCurrentUser.mockReset();
  mocks.withUserSession.mockClear();
  mocks.insertAiExtraction.mockClear();
});

describe("runAndPersistExtraction", () => {
  it("成功抽出: セッションの school_id / 実行者で監査行を INSERT し結果を返す", async () => {
    mocks.getCurrentUser.mockResolvedValue(TEACHER);
    const structure = vi.fn(async () => structureResult());

    const result = await runAndPersistExtraction(baseParams(), { structure });

    expect(result.status).toBe("success");
    expect(mocks.insertAiExtraction).toHaveBeenCalledTimes(1);
    const row = insertedRow();
    expect(row.schoolId).toBe(SCHOOL_ID);
    expect(row.status).toBe("success");
    expect(row.confidenceScore).toBe(0.9);
    expect(row.modelVersion).toBe("gemini-test");
    expect(row.rawInputHash).toBe("a".repeat(64));
    expect(row.createdBy).toBe(TEACHER.uid); // 監査カラムに実行者本人（ルール1）
  });

  it("schoolId はセッション由来で強制: request に渡された値ではなく user.schoolId を使う", async () => {
    mocks.getCurrentUser.mockResolvedValue(TEACHER);
    let capturedSchoolId: string | undefined;
    const structure = vi.fn(async (req: { schoolId?: string }) => {
      capturedSchoolId = req.schoolId;
      return structureResult();
    });

    await runAndPersistExtraction(baseParams(), { structure });

    // structureContent に渡る schoolId（= レート制限キー）も監査 school も user.schoolId に一致。
    expect(capturedSchoolId).toBe(SCHOOL_ID);
    expect(insertedRow().schoolId).toBe(SCHOOL_ID);
  });

  it("失敗抽出 (status=failed) も監査記録する（エラー経路の監査、ルール1）", async () => {
    mocks.getCurrentUser.mockResolvedValue(TEACHER);
    const structure = vi.fn(async () =>
      structureResult({ status: "failed", confidenceScore: 0, errorMessage: "Zod 検証に失敗" }),
    );

    const result = await runAndPersistExtraction(baseParams(), { structure });

    expect(result.status).toBe("failed");
    expect(mocks.insertAiExtraction).toHaveBeenCalledTimes(1);
    const row = insertedRow();
    expect(row.status).toBe("failed");
    expect(row.confidenceScore).toBe(0); // confidence は NOT NULL、失敗時 0
  });

  it("未認証は UnauthenticatedError、抽出も INSERT もしない", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const structure = vi.fn(async () => structureResult());

    await expect(runAndPersistExtraction(baseParams(), { structure })).rejects.toBeInstanceOf(
      mocks.UnauthenticatedError,
    );
    expect(structure).not.toHaveBeenCalled();
    expect(mocks.insertAiExtraction).not.toHaveBeenCalled();
  });

  it("抽出作者でない role は ForbiddenError、LLM quota を消費しない（ゲートは LLM より前）", async () => {
    mocks.getCurrentUser.mockResolvedValue({ ...TEACHER, role: "student" });
    const structure = vi.fn(async () => structureResult());

    await expect(runAndPersistExtraction(baseParams(), { structure })).rejects.toBeInstanceOf(
      mocks.ForbiddenError,
    );
    expect(structure).not.toHaveBeenCalled();
    expect(mocks.insertAiExtraction).not.toHaveBeenCalled();
  });

  it("RateLimitExceededError は伝播し、ai_extractions に空行を残さない", async () => {
    mocks.getCurrentUser.mockResolvedValue(TEACHER);
    const structure = vi.fn(async () => {
      throw new RateLimitExceededError(SCHOOL_ID);
    });

    await expect(runAndPersistExtraction(baseParams(), { structure })).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    expect(mocks.insertAiExtraction).not.toHaveBeenCalled();
  });

  it("PiiLeakError は伝播し、ai_extractions に空行を残さない（fail-closed）", async () => {
    mocks.getCurrentUser.mockResolvedValue(TEACHER);
    const structure = vi.fn(async () => {
      throw new PiiLeakError(2);
    });

    await expect(runAndPersistExtraction(baseParams(), { structure })).rejects.toBeInstanceOf(
      PiiLeakError,
    );
    expect(mocks.insertAiExtraction).not.toHaveBeenCalled();
  });
});
