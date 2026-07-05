import { describe, expect, it } from "vitest";
import { caseScore, scoreAssistantTurn, scoreExtraction } from "./score";

/**
 * eval 採点器（score.ts）の**常時実行**ユニットテスト。実 Vertex は叩かない（ランナーは
 * assistant-eval.test.ts の RUN_AI_EVAL gate 側）。採点器自体の誤判定は eval 全体を無意味に
 * するため、マッチ意味論（any-of/all-of・厳密一致・余剰減点）をここで固定する。
 */

describe("scoreAssistantTurn", () => {
  it("予定: period 厳密一致 + subject 代替語含有で match し、余剰は減点する", () => {
    const checks = scoreAssistantTurn(
      { schedules: [{ period: 2, subject: ["英語"] }] },
      {
        reply: "",
        draft: {
          schedules: [
            { period: 2, subject: "英語コミュニケーション" },
            { period: 3, subject: "数学" }, // 期待外の余剰
          ],
          notices: [],
          assignments: [],
        },
      },
    );
    expect(checks.find((c) => c.name.includes("2限=英語"))?.pass).toBe(true);
    expect(checks.find((c) => c.name.includes("余計な項目"))?.pass).toBe(false);
  });

  it("連絡: キーワード全グループが同一 text 内に必要・isHighlight 指定時は一致必須", () => {
    const draft = {
      schedules: [],
      notices: [{ text: "こまめに水分補給をしましょう" }],
      assignments: [],
    };
    const miss = scoreAssistantTurn(
      { notices: [{ keywords: [["水分"]], isHighlight: true }] },
      { reply: "", draft },
    );
    expect(miss.find((c) => c.name.includes("連絡"))?.pass).toBe(false);
    const hit = scoreAssistantTurn({ notices: [{ keywords: [["水分"]] }] }, { reply: "", draft });
    expect(hit.find((c) => c.name.includes("連絡"))?.pass).toBe(true);
  });

  it("days: date 厳密一致・期待外日付は減点・欠落日は配下チェックも fail に数える", () => {
    const checks = scoreAssistantTurn(
      {
        days: [
          { date: "2026-07-13", schedules: [{ period: 1, subject: ["数学"] }] },
          { date: "2026-07-14", schedules: [{ period: 1, subject: ["テスト"] }] },
        ],
      },
      {
        reply: "",
        draft: {
          schedules: [],
          notices: [],
          assignments: [],
          days: [
            {
              date: "2026-07-13",
              schedules: [{ period: 1, subject: "数学" }],
              notices: [],
              assignments: [],
            },
            {
              date: "2026-07-20", // 期待外
              schedules: [{ period: 1, subject: "数学" }],
              notices: [],
              assignments: [],
            },
          ],
        },
      },
    );
    expect(checks.find((c) => c.name === "days 2026-07-13 が存在")?.pass).toBe(true);
    expect(checks.find((c) => c.name === "days 2026-07-14 が存在")?.pass).toBe(false);
    // 欠落日の配下（1限=テスト）も fail として数えられる。
    expect(checks.find((c) => c.name.includes("2026-07-14: 予定"))?.pass).toBe(false);
    expect(checks.find((c) => c.name === "days に期待外の日付が無い")?.pass).toBe(false);
  });

  it("emptySections / noDays / replyIncludesAny（NFKC・大小・空白揺れを吸収）", () => {
    const checks = scoreAssistantTurn(
      {
        emptySections: ["notices"],
        noDays: true,
        replyIncludesAny: [["？", "?"]],
      },
      {
        reply: "期限はいつにしますか?",
        draft: { schedules: [], notices: [{ text: "余剰" }], assignments: [] },
      },
    );
    expect(checks.find((c) => c.name === "notices が空")?.pass).toBe(false);
    expect(checks.find((c) => c.name === "days を使わない")?.pass).toBe(true);
    expect(checks.find((c) => c.name.includes("reply"))?.pass).toBe(true);
  });

  it("提出物: deadline 厳密一致 + taskKeywords 含有", () => {
    const checks = scoreAssistantTurn(
      {
        assignments: [{ deadline: "2026-07-10", subject: ["数学"], taskKeywords: [["ドリル"]] }],
      },
      {
        reply: "",
        draft: {
          schedules: [],
          notices: [],
          assignments: [{ deadline: "2026-07-10", subject: "数学", task: "ドリルp10" }],
        },
      },
    );
    expect(checks.find((c) => c.name.includes("提出物"))?.pass).toBe(true);
  });
});

describe("scoreExtraction / caseScore", () => {
  it("schedule entries の recall と confidence 下限を採点する", () => {
    const checks = scoreExtraction(
      {
        scheduleEntries: [
          { period: 1, subject: ["国語"] },
          { period: 2, subject: ["算数"] },
        ],
        minConfidence: 0.5,
      },
      {
        status: "success",
        extraction: {
          kind: "schedule",
          data: {
            entries: [{ period: 1, subject: "国語" }],
          },
          confidenceScore: 0.9,
          evidence: [],
        },
        confidenceScore: 0.9,
      },
    );
    expect(checks.find((c) => c.name === "status=success")?.pass).toBe(true);
    expect(checks.find((c) => c.name.includes("1限=国語"))?.pass).toBe(true);
    expect(checks.find((c) => c.name.includes("2限=算数"))?.pass).toBe(false);
    expect(caseScore(checks)).toBeCloseTo(3 / 4);
  });

  it("失敗結果（extraction=null）は項目チェックが全て fail になる", () => {
    const checks = scoreExtraction(
      { tagsAny: [["体育祭"]] },
      { status: "failed", extraction: null, confidenceScore: null },
    );
    expect(checks.every((c) => !c.pass)).toBe(true);
  });
});
