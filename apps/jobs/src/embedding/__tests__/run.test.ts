import { describe, expect, it, vi } from "vitest";
import type { EmbeddingClient } from "@kimiterrace/ai";
import type { EmbeddingBatchPort, PendingVersion } from "../embed-content.js";
import { embedAllSchools, runEmbeddingBatch } from "../run.js";

/**
 * F06 (#398): `embedAllSchools`（全校横断オーケストレーション）をフェイク依存で単体検証する。
 *
 * 実 PG / RLS の振る舞いは packages/db の `embedding-batch.test.ts`（実 PG）でカバーするため、
 * ここでは「全校を順に処理し件数を正しく集計する」「校ごとに新しい port を作る」「各校の名簿を
 * 渡す」というオーケストレーションの不変条件のみを検証する（DB/Vertex 非依存）。
 */

/** versionId→masked text のフェイク port（指定の pending を返し、save を記録する）。 */
function fakePort(pending: PendingVersion[], saved: string[]): EmbeddingBatchPort {
  return {
    listPending: async () => pending,
    saveEmbedding: async (versionId) => {
      saved.push(versionId);
    },
  };
}

/** 入力件数ぶんゼロベクトルを返すフェイク Vertex クライアント。 */
const fakeClient: EmbeddingClient = {
  embed: async (texts) => texts.map(() => [0]),
};

describe("embedAllSchools", () => {
  it("全校を順に処理し scanned/embedded/skipped を集計する", async () => {
    const saved: string[] = [];
    const summary = await embedAllSchools({
      listSchoolIds: async () => ["school-A", "school-B"],
      makePort: (schoolId) =>
        schoolId === "school-A"
          ? fakePort(
              [
                { versionId: "a1", snapshot: { title: "t", body: "b" } },
                { versionId: "a2", snapshot: { title: "", body: "" } }, // 空テキスト → skip
              ],
              saved,
            )
          : fakePort([{ versionId: "b1", snapshot: { title: "t", body: "b" } }], saved),
      client: fakeClient,
    });

    expect(summary.schools).toBe(2);
    expect(summary.scanned).toBe(3); // a1,a2,b1
    expect(summary.embedded).toBe(2); // a1,b1 (a2 は空テキストで skip)
    expect(summary.skippedEmptyText).toBe(1); // a2
    expect(summary.blockedUnmaskedPii).toBe(0);
    expect(summary.perSchool).toEqual([
      { schoolId: "school-A", scanned: 2, embedded: 1, skippedEmptyText: 1, blockedUnmaskedPii: 0 },
      { schoolId: "school-B", scanned: 1, embedded: 1, skippedEmptyText: 0, blockedUnmaskedPii: 0 },
    ]);
    expect(saved).toEqual(["a1", "b1"]);
  });

  it("校ごとに makePort を 1 回ずつ呼ぶ（port を校間で共有しない）", async () => {
    const make = vi.fn((_schoolId: string) => fakePort([], []));
    await embedAllSchools({
      listSchoolIds: async () => ["s1", "s2", "s3"],
      makePort: make,
      client: fakeClient,
    });
    expect(make).toHaveBeenCalledTimes(3);
    expect(make.mock.calls.map((c) => c[0])).toEqual(["s1", "s2", "s3"]);
  });

  it("maskEntriesFor が校ごとに呼ばれ、その校の名簿で embed される", async () => {
    const maskFor = vi.fn(async (schoolId: string) =>
      schoolId === "s1" ? [{ value: "田中太郎", category: "STUDENT" as const }] : [],
    );
    // embed に渡るテキストを捕捉する。
    const captured: string[][] = [];
    const capturingClient: EmbeddingClient = {
      embed: async (texts) => {
        captured.push(texts);
        return texts.map(() => [0]);
      },
    };
    await embedAllSchools({
      listSchoolIds: async () => ["s1"],
      makePort: () => fakePort([{ versionId: "v1", snapshot: { title: "田中太郎の予定" } }], []),
      client: capturingClient,
      maskEntriesFor: maskFor,
    });
    expect(maskFor).toHaveBeenCalledWith("s1");
    // 氏名がトークンに置換されてから embed へ渡る（ルール4: 生 PII を Vertex に送らない）。
    const firstText = captured[0]?.[0] ?? "";
    expect(firstText).not.toContain("田中太郎");
    expect(firstText).toContain("STUDENT_001");
  });

  it("空の学校一覧なら何もせず 0 集計", async () => {
    const summary = await embedAllSchools({
      listSchoolIds: async () => [],
      makePort: () => fakePort([], []),
      client: fakeClient,
    });
    expect(summary).toEqual({
      schools: 0,
      scanned: 0,
      embedded: 0,
      skippedEmptyText: 0,
      blockedUnmaskedPii: 0,
      perSchool: [],
    });
  });
});

/**
 * F06 (#593): embedding バッチの AI_ENABLED kill-switch（ルール4 / ADR-030）。
 *
 * Job は web の入口（PR #592）とは別デプロイ単位で実 Vertex を呼ぶため、`runEmbeddingBatch` 冒頭に
 * 同じ kill-switch を配線した。ここでは「AI 無効時に **DB クライアントも Vertex クライアントも生成せず**
 * （= 実 Vertex を一切呼ばず）`aiDisabled` を返す」ことを、生成ファクトリの spy で検証する。
 * 実 PG / 実 Vertex は使わない（無効経路は接続前に short-circuit するため不要、有効経路は実 PG E2E で別途）。
 */
describe("runEmbeddingBatch AI kill-switch (#593)", () => {
  const BATCH_CONFIG = {
    databaseUrl: "postgres://app:secret@localhost:5432/k",
    project: "kimiterrace-staging",
    location: "asia-northeast1",
  };

  it("AI 無効時は DB / Vertex クライアントを一切生成せず aiDisabled の all-zero を返す", async () => {
    // 呼ばれたら即 throw する spy。無効経路では一度も呼ばれないことを assert する（接続前 short-circuit）。
    const makeDb = vi.fn(() => {
      throw new Error("makeDb must not be called when AI is disabled");
    });
    const makeClient = vi.fn(() => {
      throw new Error("makeClient must not be called when AI is disabled");
    });

    const summary = await runEmbeddingBatch(BATCH_CONFIG, {
      isEnabled: () => false,
      makeDb,
      makeClient,
    });

    expect(makeDb).not.toHaveBeenCalled();
    expect(makeClient).not.toHaveBeenCalled();
    expect(summary).toEqual({
      schools: 0,
      scanned: 0,
      embedded: 0,
      skippedEmptyText: 0,
      blockedUnmaskedPii: 0,
      perSchool: [],
      aiDisabled: true,
    });
  });

  it("AI 有効時は gate を通過し DB 結線へ進む（非空虚の正の対比）", async () => {
    // gate を通過したことの証跡として makeDb で sentinel を投げ、それが伝播することと makeDb 呼出を確認。
    // （makeDb が先に呼ばれるので makeClient は未到達。無効テストと同じ spy 経路で gate の効きを対比する。）
    const makeDb = vi.fn(() => {
      throw new Error("DB_WIRED");
    });
    const makeClient = vi.fn(() => {
      throw new Error("makeClient must not be reached (makeDb threw first)");
    });

    await expect(
      runEmbeddingBatch(BATCH_CONFIG, { isEnabled: () => true, makeDb, makeClient }),
    ).rejects.toThrow("DB_WIRED");
    expect(makeDb).toHaveBeenCalledTimes(1);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("既定（isEnabled 未注入）は process.env.AI_ENABLED を見る（'true' 以外は無効）", async () => {
    const makeDb = vi.fn(() => {
      throw new Error("makeDb must not be called when AI_ENABLED !== 'true'");
    });
    const prev = process.env.AI_ENABLED;
    try {
      process.env.AI_ENABLED = "false";
      const summary = await runEmbeddingBatch(BATCH_CONFIG, { makeDb });
      expect(makeDb).not.toHaveBeenCalled();
      expect(summary.aiDisabled).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.AI_ENABLED;
      } else {
        process.env.AI_ENABLED = prev;
      }
    }
  });
});
