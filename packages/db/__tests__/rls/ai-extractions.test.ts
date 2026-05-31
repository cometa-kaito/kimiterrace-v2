import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { insertAiExtraction } from "../../src/queries/ai-extractions.js";
import { aiExtractions } from "../../src/schema/ai-extractions.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F03 (#154 item 1): ai_extractions 永続化層を実 PG (RLS 込み) で検証する。
 *
 * 接続は DATABASE_URL の superuser (BYPASSRLS) なので、appRole で kimiterrace_app に降格してから
 * RLS を効かせる (本番は最初から kimiterrace_app 接続)。raw (BYPASSRLS) は検証用 SELECT に使う。
 */
describeOrSkip("F03 ai_extractions 永続化 (#154 item 1, RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // 各テストを独立させるため抽出行を作り直す。
    await raw`DELETE FROM ai_extractions`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  // fx は beforeAll で代入されるため、関数で遅延読みする (collection 時は undefined)。
  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "teacher" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const });

  /** toAiExtractionInsert 相当の行 (contentId は事前バッチを想定し null)。 */
  function sampleValues(schoolId: string, createdBy: string) {
    return {
      schoolId,
      contentId: null,
      extractionKind: "schedule" as const,
      confidenceScore: 0.85,
      evidence: [{ page: 1, text: "1限 数学" }],
      rawInputHash: "a".repeat(64),
      modelVersion: "gemini-1.5-pro-002",
      status: "success",
      errorMessage: null,
      createdBy,
      updatedBy: createdBy,
    };
  }

  it("school A context で INSERT し、確信度 / モデル / 入力ハッシュ / 根拠 / 種別を記録する", async () => {
    const { id } = await withTenantContext(
      db,
      ctxA(),
      (tx) => insertAiExtraction(tx, sampleValues(fx.schoolA, fx.userA)),
      APP,
    );
    expect(id).toBeTruthy();

    const [row] = await raw<
      {
        school_id: string;
        extraction_kind: string;
        confidence_score: number;
        model_version: string;
        raw_input_hash: string;
        status: string;
        evidence: { page: number; text: string }[];
        created_by: string;
      }[]
    >`
      SELECT school_id, extraction_kind, confidence_score, model_version, raw_input_hash,
             status, evidence, created_by
      FROM ai_extractions WHERE id = ${id}
    `;
    expect(row.school_id).toBe(fx.schoolA);
    expect(row.extraction_kind).toBe("schedule");
    expect(Number(row.confidence_score)).toBeCloseTo(0.85);
    expect(row.model_version).toBe("gemini-1.5-pro-002");
    expect(row.raw_input_hash).toBe("a".repeat(64));
    expect(row.status).toBe("success");
    expect(row.evidence).toEqual([{ page: 1, text: "1限 数学" }]);
    expect(row.created_by).toBe(fx.userA); // 監査カラムに実行者本人 (ルール1)
  });

  it("テナント分離 (read): B コンテキストからは A の抽出行が RLS で見えない", async () => {
    await withTenantContext(
      db,
      ctxA(),
      (tx) => insertAiExtraction(tx, sampleValues(fx.schoolA, fx.userA)),
      APP,
    );
    // B の RLS コンテキストで SELECT すると tenant_isolation policy が A の行を隠す。
    const visibleUnderB = await withTenantContext(
      db,
      ctxB(),
      (tx) => tx.select({ id: aiExtractions.id }).from(aiExtractions),
      APP,
    );
    expect(visibleUnderB.length).toBe(0);
    // BYPASSRLS の raw からは存在する (= 隠れているだけで消えていない)。
    const all = await raw`SELECT id FROM ai_extractions WHERE school_id = ${fx.schoolA}`;
    expect(all.length).toBe(1);
  });

  it("テナント分離 (write): B コンテキストで A の school_id を指定した INSERT は WITH CHECK が弾く", async () => {
    // tenant_isolation policy (FOR ALL の WITH CHECK、migration 0002) が
    // school_id = app.current_school_id を強制するため、越境 INSERT は DB が拒否する。
    await expect(
      withTenantContext(
        db,
        ctxB(),
        (tx) => insertAiExtraction(tx, sampleValues(fx.schoolA, fx.userB)),
        APP,
      ),
    ).rejects.toThrow();

    // B の越境 INSERT は成立していない (A の行は増えていない)。
    const all = await raw`SELECT id FROM ai_extractions WHERE school_id = ${fx.schoolA}`;
    expect(all.length).toBe(0);
  });

  it("失敗抽出 (status=failed, confidence=0) も記録できる (エラー経路の監査、ルール1)", async () => {
    const { id } = await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        insertAiExtraction(tx, {
          ...sampleValues(fx.schoolA, fx.userA),
          status: "failed",
          confidenceScore: 0,
          evidence: [],
          errorMessage: "Zod 検証に 3 回失敗",
        }),
      APP,
    );
    const [row] = await raw<{ status: string; confidence_score: number; error_message: string }[]>`
      SELECT status, confidence_score, error_message FROM ai_extractions WHERE id = ${id}
    `;
    expect(row.status).toBe("failed");
    expect(Number(row.confidence_score)).toBe(0);
    expect(row.error_message).toBe("Zod 検証に 3 回失敗");
  });
});
