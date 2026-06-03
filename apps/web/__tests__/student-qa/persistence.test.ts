import type { TenantTx } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  appendAssistantMessage,
  appendUserMessage,
  findOrCreateSession,
  findOrCreateSessionForUser,
} from "../../lib/student-qa/persistence";

/**
 * F06 (#42 第2スライス, #373): 永続化層の値マッピング検証。
 *
 * 実 DB 不使用 (ADR-012)。Drizzle のクエリビルダを **チェイン可能な薄いフェイク tx** で差し替え、
 * `insert().values()` / `update().set()` に渡る値オブジェクトを捕捉して検証する。RLS / 監査列の
 * 実 PG 挙動 (school_id 強制・created_by null) は `packages/db/__tests__/rls/` の実 PG 結合テストが
 * 担う領域なので、ここでは **アプリ層が何を INSERT しようとするか** (role / マスク済本文 / evidence
 * 形 / bump) のみを決定的に固める。
 */

type Row = Record<string, unknown>;

/** select 結果列 / insert returning 結果列を順に返し、values/set を記録するフェイク tx。 */
function makeTx(config: { selects?: Row[][]; inserts?: Row[][] }) {
  const calls = {
    insertValues: [] as Row[],
    updateSets: [] as Row[],
  };
  let selectI = 0;
  let insertI = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];

  function chain(result: unknown) {
    const p = Promise.resolve(result);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") return p.then.bind(p);
        if (prop === "catch") return p.catch.bind(p);
        if (prop === "finally") return p.finally.bind(p);
        return (...args: unknown[]) => {
          if (prop === "values") calls.insertValues.push(args[0] as Row);
          if (prop === "set") calls.updateSets.push(args[0] as Row);
          return proxy;
        };
      },
    });
    return proxy;
  }

  const tx = {
    select: () => chain(selects[selectI++] ?? []),
    insert: () => chain(inserts[insertI++] ?? [{ id: "fallback" }]),
    update: () => chain([]),
  } as unknown as TenantTx;

  return { tx, calls };
}

describe("findOrCreateSession", () => {
  it("active セッションがあれば再利用し、INSERT しない", async () => {
    const existing = {
      id: "sess-existing",
      schoolId: "s1",
      magicLinkId: "ml1",
      classId: "c1",
    };
    const { tx, calls } = makeTx({ selects: [[existing]] });
    const got = await findOrCreateSession(tx, {
      schoolId: "s1",
      magicLinkId: "ml1",
      classId: "c1",
    });
    expect(got).toEqual(existing);
    expect(calls.insertValues).toHaveLength(0);
  });

  it("無ければ (school_id, magic_link_id, class_id) で新規作成する", async () => {
    const created = { id: "sess-new", schoolId: "s1", magicLinkId: "ml1", classId: "c1" };
    const { tx, calls } = makeTx({ selects: [[]], inserts: [[created]] });
    const got = await findOrCreateSession(tx, {
      schoolId: "s1",
      magicLinkId: "ml1",
      classId: "c1",
    });
    expect(got).toEqual(created);
    expect(calls.insertValues[0]).toEqual({ schoolId: "s1", magicLinkId: "ml1", classId: "c1" });
  });
});

describe("findOrCreateSessionForUser (#370 教員経路)", () => {
  it("active な user セッションがあれば再利用し、INSERT しない", async () => {
    const existing = {
      id: "sess-existing",
      schoolId: "s1",
      magicLinkId: null,
      userId: "u1",
      classId: null,
    };
    const { tx, calls } = makeTx({ selects: [[existing]] });
    const got = await findOrCreateSessionForUser(tx, { schoolId: "s1", userId: "u1" });
    expect(got).toEqual(existing);
    expect(calls.insertValues).toHaveLength(0);
  });

  it("無ければ user_id + created_by で新規作成する (magic_link/class は null, 監査=教員 actor)", async () => {
    const created = {
      id: "sess-new",
      schoolId: "s1",
      magicLinkId: null,
      userId: "u1",
      classId: null,
    };
    const { tx, calls } = makeTx({ selects: [[]], inserts: [[created]] });
    const got = await findOrCreateSessionForUser(tx, { schoolId: "s1", userId: "u1" });
    expect(got).toEqual(created);
    // 教員は認証済みアクター: created_by を立てる (ルール1)。magic_link_id/class_id は渡さない (XOR)。
    expect(calls.insertValues[0]).toEqual({
      schoolId: "s1",
      userId: "u1",
      createdBy: "u1",
    });
  });
});

describe("appendUserMessage", () => {
  it("role=user・マスク済本文で INSERT し、session を bump する", async () => {
    const { tx, calls } = makeTx({ inserts: [[{ id: "umsg-1" }]] });
    const row = await appendUserMessage(tx, {
      schoolId: "s1",
      sessionId: "sess-1",
      maskedText: "{{STUDENT_001}}さんの質問",
      tokenCount: 3,
    });
    expect(row).toEqual({ id: "umsg-1" });
    expect(calls.insertValues[0]).toEqual({
      schoolId: "s1",
      sessionId: "sess-1",
      role: "user",
      contentText: "{{STUDENT_001}}さんの質問",
      tokenCount: 3,
    });
    // bumpSession: message_count / last_message_at を 1 回更新する。
    expect(calls.updateSets).toHaveLength(1);
    expect(calls.updateSets[0]).toHaveProperty("messageCount");
    expect(calls.updateSets[0]).toHaveProperty("lastMessageAt");
  });
});

describe("appendAssistantMessage", () => {
  it("role=assistant・evidence は素の配列・confidence/model_version 込みで INSERT する", async () => {
    const { tx, calls } = makeTx({ inserts: [[{ id: "amsg-1" }]] });
    const row = await appendAssistantMessage(tx, {
      schoolId: "s1",
      sessionId: "sess-1",
      maskedText: "掲示物によると 6/10 です",
      modelVersion: "gemini-test-001",
      evidence: [{ contentId: "c1", title: "体育祭" }],
      confidenceScore: 0.4,
      tokenCount: 12,
    });
    expect(row).toEqual({ id: "amsg-1" });
    const v = calls.insertValues[0];
    expect(v).toMatchObject({
      schoolId: "s1",
      sessionId: "sess-1",
      role: "assistant",
      contentText: "掲示物によると 6/10 です",
      modelVersion: "gemini-test-001",
      confidenceScore: 0.4,
      tokenCount: 12,
    });
    // evidence は readonly 入力をコピーした素の配列 (ルール3: キャストせず jsonb=unknown へ渡す)。
    expect(Array.isArray(v?.evidence)).toBe(true);
    expect(v?.evidence).toEqual([{ contentId: "c1", title: "体育祭" }]);
    expect(calls.updateSets).toHaveLength(1);
  });
});
