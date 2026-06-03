import { PiiLeakError, RateLimitExceededError, type StructureResult } from "@kimiterrace/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtractTeacherInputDeps,
  ExtractTeacherInputResult,
} from "../../lib/ai/extract-teacher-input";
import type { RunAndPersistParams } from "../../lib/ai/run-extraction";

/**
 * F03 (#154): extractTeacherInput トリガの結果マッピング検証。
 *
 * DB / auth は seam (runAndPersistExtraction) と RLS テストが担保するため、本テストは
 * `loadTranscript` / `runAndPersist` を注入し、**transcript ロード → request 組み立て → エラー →
 * UX 結果の写像**だけを突く。lib/db のエラークラスは seam テスト同様 mock で用意し instanceof を成立させる。
 */
const mocks = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  class ForbiddenError extends Error {}
  return { UnauthenticatedError, ForbiddenError };
});

vi.mock("../../lib/db", () => ({
  UnauthenticatedError: mocks.UnauthenticatedError,
  ForbiddenError: mocks.ForbiddenError,
  withUserSession: vi.fn(),
}));
vi.mock("../../lib/auth/session", () => ({ getCurrentUser: vi.fn() }));

import { extractTeacherInput } from "../../lib/ai/extract-teacher-input";

const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";

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

function makeDeps(over: Partial<ExtractTeacherInputDeps> = {}): {
  deps: ExtractTeacherInputDeps;
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const deps: ExtractTeacherInputDeps = {
    loadTranscript: vi.fn(async () => ({ transcript: "1限 数学、2限 英語" })),
    loadStaffPiiEntries: vi.fn(async () => []),
    runAndPersist: vi.fn(async () => structureResult()),
    // biome-ignore lint/suspicious/noExplicitAny: model は runAndPersist 注入で未使用
    model: {} as any,
    rateLimiter: { tryAcquire: () => true },
    logger,
    ...over,
  };
  return { deps, logger };
}

afterEach(() => vi.clearAllMocks());

describe("extractTeacherInput", () => {
  it("成功: transcript を kind 付きで seam に渡し、status / confidence を返す", async () => {
    let captured: RunAndPersistParams | undefined;
    const runAndPersist: ExtractTeacherInputDeps["runAndPersist"] = vi.fn(async (p) => {
      captured = p;
      return structureResult();
    });
    const { deps } = makeDeps({ runAndPersist });
    const res = await extractTeacherInput("input-1", "schedule", deps);

    expect(res).toEqual<ExtractTeacherInputResult>({
      ok: true,
      status: "success",
      confidenceScore: 0.9,
    });
    expect(runAndPersist).toHaveBeenCalledTimes(1);
    expect(captured?.request.kind).toBe("schedule");
    expect(captured?.request.input).toBe("1限 数学、2限 英語");
    // schoolId は seam がセッションから強制するため request には載せない。
    expect("schoolId" in (captured?.request ?? {})).toBe(false);
  });

  it("抽出が公開先・掲示期間を提案したら結果に持ち越す (F01 pre-fill 用)", async () => {
    const { deps } = makeDeps({
      runAndPersist: vi.fn(async () =>
        structureResult({
          extraction: {
            kind: "announcement",
            data: { title: "球技大会", body: "本文" },
            confidenceScore: 0.9,
            evidence: [],
            suggestedPublishScope: "school",
            suggestedPeriod: { start: "2026-06-10", end: "2026-06-20" },
          },
        }),
      ),
    });
    const res = await extractTeacherInput("input-1", "announcement", deps);
    expect(res).toMatchObject({
      ok: true,
      suggestedPublishScope: "school",
      suggestedPeriod: { start: "2026-06-10", end: "2026-06-20" },
    });
  });

  it("提案が無い抽出は suggested* を載せない (任意・従来既定にフォールバック)", async () => {
    const { deps } = makeDeps({ runAndPersist: vi.fn(async () => structureResult()) });
    const res = await extractTeacherInput("input-1", "schedule", deps);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.suggestedPublishScope).toBeUndefined();
      expect(res.suggestedPeriod).toBeUndefined();
    }
  });

  it("職員氏名 roster を piiEntries(category=STAFF) として seam に渡す (#289 ルール4)", async () => {
    let captured: RunAndPersistParams | undefined;
    const runAndPersist: ExtractTeacherInputDeps["runAndPersist"] = vi.fn(async (p) => {
      captured = p;
      return structureResult();
    });
    const { deps } = makeDeps({
      loadStaffPiiEntries: vi.fn(async () => [
        { value: "田中先生", category: "STAFF" as const },
        { value: "佐藤教頭", category: "STAFF" as const },
      ]),
      runAndPersist,
    });
    await extractTeacherInput("input-1", "schedule", deps);
    expect(captured?.request.piiEntries).toEqual([
      { value: "田中先生", category: "STAFF" },
      { value: "佐藤教頭", category: "STAFF" },
    ]);
  });

  it("transcript 不在なら roster を引かない (no_transcript で無駄引きしない)", async () => {
    const loadStaffPiiEntries = vi.fn(async () => []);
    const { deps } = makeDeps({
      loadTranscript: vi.fn(async () => null),
      loadStaffPiiEntries,
    });
    const res = await extractTeacherInput("input-1", "schedule", deps);
    expect(res).toEqual({ ok: false, reason: "no_transcript" });
    expect(loadStaffPiiEntries).not.toHaveBeenCalled();
  });

  it("失敗抽出 (status=failed) も ok:true で返す (監査は seam が実施済)", async () => {
    const { deps } = makeDeps({
      runAndPersist: vi.fn(async () => structureResult({ status: "failed", confidenceScore: 0 })),
    });
    const res = await extractTeacherInput("input-1", "summary", deps);
    expect(res).toEqual({ ok: true, status: "failed", confidenceScore: 0 });
  });

  it("transcript 不在 (他校/未確定) は no_transcript、seam を呼ばない", async () => {
    const runAndPersist = vi.fn(async () => structureResult());
    const { deps } = makeDeps({ loadTranscript: vi.fn(async () => null), runAndPersist });
    const res = await extractTeacherInput("input-1", "schedule", deps);
    expect(res).toEqual({ ok: false, reason: "no_transcript" });
    expect(runAndPersist).not.toHaveBeenCalled();
  });

  it("transcript が空白のみも no_transcript", async () => {
    const { deps } = makeDeps({ loadTranscript: vi.fn(async () => ({ transcript: "   " })) });
    const res = await extractTeacherInput("input-1", "schedule", deps);
    expect(res).toEqual({ ok: false, reason: "no_transcript" });
  });

  it("未認証 (loadTranscript が Unauthenticated) は unauthenticated に畳む", async () => {
    const { deps } = makeDeps({
      loadTranscript: vi.fn(async () => {
        throw new mocks.UnauthenticatedError();
      }),
    });
    const res = await extractTeacherInput("input-1", "schedule", deps);
    expect(res).toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("role 不足 (seam が Forbidden) は forbidden に畳む", async () => {
    const { deps } = makeDeps({
      runAndPersist: vi.fn(async () => {
        throw new mocks.ForbiddenError();
      }),
    });
    const res = await extractTeacherInput("input-1", "schedule", deps);
    expect(res).toEqual({ ok: false, reason: "forbidden" });
  });

  it("RateLimitExceededError は rate_limited に畳む", async () => {
    const { deps } = makeDeps({
      runAndPersist: vi.fn(async () => {
        throw new RateLimitExceededError(SCHOOL_ID);
      }),
    });
    const res = await extractTeacherInput("input-1", "schedule", deps);
    expect(res).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("PiiLeakError は pii_leak に畳み、PII を出さず inputId のみログ", async () => {
    const { deps, logger } = makeDeps({
      runAndPersist: vi.fn(async () => {
        throw new PiiLeakError(2);
      }),
    });
    const res = await extractTeacherInput("input-9", "announcement", deps);
    expect(res).toEqual({ ok: false, reason: "pii_leak" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    // pino API: 第1引数が merging object、第2引数が msg。
    const [obj, msg] = logger.error.mock.calls[0] ?? [];
    expect(obj).toEqual({ inputId: "input-9" }); // transcript / PII は出さない
    expect(String(msg)).not.toContain("数学"); // 本文を漏らさない
  });

  it("想定外エラーは error に畳み、本文を出さない", async () => {
    const { deps, logger } = makeDeps({
      runAndPersist: vi.fn(async () => {
        throw new Error("DB down");
      }),
    });
    const res = await extractTeacherInput("input-1", "tag", deps);
    expect(res).toEqual({ ok: false, reason: "error" });
    expect(logger.error).toHaveBeenCalledWith({ inputId: "input-1" }, "AI 抽出に失敗");
  });
});
