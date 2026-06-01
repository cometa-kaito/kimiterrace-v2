import type { EffectCommentStats, ModelRequest, ModelResponse } from "@kimiterrace/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../lib/auth/session";

/**
 * F08 (#44, slice 2): `generateEffectComment` action の配線検証。
 *
 * 実 DB / 実 Vertex を使わず、`lib/db` の `withSession` (RLS context + role 第一層ガード)・
 * `@kimiterrace/db` の `auditLog`・`@kimiterrace/observability` を mock し、
 * 「role ゲート → 集計 → **PII マスク (Vertex 送信前)** → builder → Gemini → 応答 unmask →
 * audit_log INSERT」の配線とセキュリティ不変条件を突く。集計 (`loadStats`) と model は `deps` 注入で
 * 差し替える。**`@kimiterrace/ai` は実物**を使い (maskPII/buildEffectCommentPrompt/unmaskPII)、マスクが
 * 実際に Vertex へ渡るプロンプトに効くことを assert する。
 *
 * RLS / 監査 hash chain の実挙動は packages/db の RLS テスト + CI 実 PG で担保する。
 */

const mocks = vi.hoisted(() => {
  class UnauthenticatedError extends Error {
    constructor() {
      super("unauth");
      this.name = "UnauthenticatedError";
    }
  }
  class ForbiddenError extends Error {
    constructor() {
      super("forbidden");
      this.name = "ForbiddenError";
    }
  }
  return {
    currentUser: { value: null as AuthUser | null },
    auditRows: [] as Record<string, unknown>[],
    UnauthenticatedError,
    ForbiddenError,
    logError: vi.fn(),
  };
});

// withSession: 認証 (currentUser) + role 第一層ガード (allowedRoles) を mock 内で再現し、fake tx で fn を実行。
vi.mock("../../lib/db", () => ({
  UnauthenticatedError: mocks.UnauthenticatedError,
  ForbiddenError: mocks.ForbiddenError,
  withSession: async (
    fn: (tx: unknown, user: AuthUser) => Promise<unknown>,
    options?: { allowedRoles?: readonly string[] },
  ) => {
    const user = mocks.currentUser.value;
    if (!user) throw new mocks.UnauthenticatedError();
    if (options?.allowedRoles && !options.allowedRoles.includes(user.role)) {
      throw new mocks.ForbiddenError();
    }
    const tx = {
      // select は本テストでは使わない (loadStats を deps で差し替えるため)。
      select: () => {
        throw new Error("tx.select should not be called (loadStats is injected)");
      },
      insert: (_table: unknown) => ({
        values: (v: Record<string, unknown>) => {
          mocks.auditRows.push(v);
          return Promise.resolve(undefined);
        },
      }),
    };
    return fn(tx, user);
  },
}));

vi.mock("@kimiterrace/db", () => ({ auditLog: { __table: "audit_log" } }));
vi.mock("@kimiterrace/observability", () => ({
  createLogger: () => ({ warn: vi.fn(), error: mocks.logError }),
}));

import { generateEffectComment } from "../../lib/dashboard/effect-comment-action";

const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const TEACHER: AuthUser = {
  uid: "11111111-1111-4111-8111-111111111111",
  role: "teacher",
  schoolId: SCHOOL_ID,
};

/** 直近に Gemini へ渡されたプロンプト。 */
function makeModel(responseText: string) {
  const calls: ModelRequest[] = [];
  const model = {
    generate: async (req: ModelRequest): Promise<ModelResponse> => {
      calls.push(req);
      return {
        text: responseText,
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        modelVersion: "gemini-test",
      };
    },
  };
  return { model, calls };
}

function statsFixture(overrides: Partial<EffectCommentStats> = {}): EffectCommentStats {
  return {
    month: "2026-06",
    metrics: [
      { label: "閲覧", current: 100, previous: 80 },
      { label: "タップ", current: 30, previous: 20 },
      { label: "Q&A", current: 7, previous: 3 },
    ],
    topContent: [{ title: "体育祭のお知らせ", reactions: 130 }],
    ...overrides,
  };
}

/** 直近に記録された audit_log 行 (存在を assert して narrow)。 */
function lastAuditRow(): Record<string, unknown> {
  const row = mocks.auditRows.at(-1);
  if (!row) throw new Error("audit_log に行が記録されていない");
  return row;
}

/** 直近に Gemini へ渡された ModelRequest (存在を assert して narrow)。 */
function lastCall(calls: ModelRequest[]): ModelRequest {
  const call = calls.at(-1);
  if (!call) throw new Error("model.generate が呼ばれていない");
  return call;
}

afterEach(() => {
  mocks.currentUser.value = null;
  mocks.auditRows.length = 0;
  mocks.logError.mockClear();
});

describe("generateEffectComment", () => {
  it("成功: コメントを返し、audit_log に LLM 呼び出しを 1 行記録する (ルール4/1)", async () => {
    mocks.currentUser.value = TEACHER;
    const { model, calls } = makeModel("今月は閲覧が前月比で増加しました。");

    const result = await generateEffectComment({ loadStats: async () => statsFixture(), model });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.month).toBe("2026-06");
      expect(result.comment).toBe("今月は閲覧が前月比で増加しました。");
    }
    expect(calls).toHaveLength(1);

    // audit_log: 1 行・who/when・table/operation・生 PII / 生プロンプト非記録。
    expect(mocks.auditRows).toHaveLength(1);
    const row = lastAuditRow();
    expect(row.actorUserId).toBe(TEACHER.uid);
    expect(row.schoolId).toBe(SCHOOL_ID);
    expect(row.createdBy).toBe(TEACHER.uid);
    expect(row.operation).toBe("insert");
    expect(row.rowHash).toBe(""); // hash chain は DB トリガが計算
    const diff = row.diff as Record<string, unknown>;
    expect(diff.action).toBe("generate_effect_comment");
    expect(diff.modelVersion).toBe("gemini-test");
    expect(diff.usage).toEqual({ promptTokens: 50, completionTokens: 20, totalTokens: 70 });
    // 監査 diff に生プロンプト・生タイトル・応答本文を残さない (ルール4)。
    const diffStr = JSON.stringify(diff);
    expect(diffStr).not.toContain("体育祭");
    expect(diffStr).not.toContain("今月は閲覧");
    expect(diffStr).not.toContain("<stats>");
  });

  it("PII マスク: タイトル中の電話番号は Vertex 送信前にトークン化される (ルール4)", async () => {
    mocks.currentUser.value = TEACHER;
    const { model, calls } = makeModel("コメント");
    const stats = statsFixture({
      topContent: [{ title: "連絡先 090-1234-5678 体育祭", reactions: 10 }],
    });

    const result = await generateEffectComment({ loadStats: async () => stats, model });

    expect(result.ok).toBe(true);
    // Vertex へ渡る user プロンプトに生電話が残っておらず、プレースホルダになっている。
    const sentUser = lastCall(calls).user;
    expect(sentUser).not.toContain("090-1234-5678");
    expect(sentUser).toContain("PHONE"); // {{t0_PHONE_001}}
    // 監査にも生電話は残さない。
    expect(JSON.stringify(lastAuditRow().diff)).not.toContain("090-1234-5678");
  });

  it("マスク後の応答 unmask: トークンが復元され応答に生 PII が現れない", async () => {
    mocks.currentUser.value = TEACHER;
    // model がプロンプト中のプレースホルダをそのままエコーしても、unmask で辞書復元される。
    // ここでは応答にトークンを含めず、unmask が応答を壊さない (no-op) ことを確認する。
    const { model } = makeModel("先月比で閲覧が増えました。");
    const stats = statsFixture({
      topContent: [{ title: "連絡 03-1234-5678", reactions: 5 }],
    });
    const result = await generateEffectComment({ loadStats: async () => stats, model });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.comment).toBe("先月比で閲覧が増えました。");
    // 監査 diff に生電話が無い (送信前マスク + 監査は集計値のみ)。
    expect(JSON.stringify(lastAuditRow().diff)).not.toContain("03-1234-5678");
  });

  it("空 topContent: マスク対象なしでも生成・監査される", async () => {
    mocks.currentUser.value = TEACHER;
    const { model, calls } = makeModel("対象期間の反応データはまだありません。");
    const stats = statsFixture({ topContent: [] });

    const result = await generateEffectComment({ loadStats: async () => stats, model });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(mocks.auditRows).toHaveLength(1);
    expect((lastAuditRow().diff as Record<string, unknown>).topContentCount).toBe(0);
  });

  it("Vertex 障害: typed error result に畳み (500 leak 回避)、監査は残さない", async () => {
    mocks.currentUser.value = TEACHER;
    const model = {
      generate: async (): Promise<ModelResponse> => {
        throw new Error("vertex 5xx");
      },
    };

    const result = await generateEffectComment({ loadStats: async () => statsFixture(), model });

    expect(result).toEqual({ ok: false, reason: "error" });
    expect(mocks.auditRows).toHaveLength(0);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("未認証: UnauthenticatedError を伝播し、集計も Vertex も監査もしない", async () => {
    mocks.currentUser.value = null;
    const { model, calls } = makeModel("x");
    const loadStats = vi.fn(async () => statsFixture());

    await expect(generateEffectComment({ loadStats, model })).rejects.toBeInstanceOf(
      mocks.UnauthenticatedError,
    );
    expect(loadStats).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(mocks.auditRows).toHaveLength(0);
  });

  it("role ゲート: PUBLISHER_ROLES 外 (student) は ForbiddenError、Vertex quota を消費しない", async () => {
    mocks.currentUser.value = { ...TEACHER, role: "student" };
    const { model, calls } = makeModel("x");
    const loadStats = vi.fn(async () => statsFixture());

    await expect(generateEffectComment({ loadStats, model })).rejects.toBeInstanceOf(
      mocks.ForbiddenError,
    );
    expect(loadStats).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(mocks.auditRows).toHaveLength(0);
  });

  it("school_admin も許可される (PUBLISHER_ROLES)", async () => {
    mocks.currentUser.value = { ...TEACHER, role: "school_admin" };
    const { model } = makeModel("コメント");
    const result = await generateEffectComment({ loadStats: async () => statsFixture(), model });
    expect(result.ok).toBe(true);
  });
});
