import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_ASSIST_SYSTEM,
  NOTICE_TONE_INSTRUCTIONS,
  SCHEDULE_ASSIST_SYSTEM,
  SECTION_ASSIST_SYSTEM,
  buildNoticeAssistUser,
  buildSectionAssistUser,
  jstDateLabel,
  parseAssignmentProposal,
  parseNoticeProposal,
  parseNoticeTone,
  parseScheduleProposal,
} from "../../lib/editor/assistant-core";

/**
 * 段C: assistant-core の純パース検証（DB/Vertex 非依存）。モデルの生 JSON テキスト → NoticeItem[] の
 * 取り出し（コードフェンス除去・形検証・不正は null）を固める。
 */
describe("parseNoticeProposal", () => {
  it("正常な JSON から notices を取り出す", () => {
    const r = parseNoticeProposal(
      '{"notices":[{"text":"明日は短縮授業","isHighlight":true},{"text":"返却は金曜まで"}]}',
    );
    expect(r).toEqual([{ text: "明日は短縮授業", isHighlight: true }, { text: "返却は金曜まで" }]);
  });

  it("```json コードフェンス付きでも取り出す", () => {
    const r = parseNoticeProposal('```json\n{"notices":[{"text":"連絡A"}]}\n```');
    expect(r).toEqual([{ text: "連絡A" }]);
  });

  it("JSON でない/壊れた応答は null", () => {
    expect(parseNoticeProposal("これは連絡です")).toBeNull();
    expect(parseNoticeProposal('{"notices":')).toBeNull();
  });

  it("notices が空配列なら空配列（呼び出し側が no_result 判定）", () => {
    expect(parseNoticeProposal('{"notices":[]}')).toEqual([]);
  });

  it("有効な text を持つ要素が皆無なら null（呼び出し側が no_result 判定）", () => {
    expect(parseNoticeProposal('{"notices":[{"foo":"x"}]}')).toBeNull();
  });
});

describe("jstDateLabel", () => {
  it("epoch を JST の YYYY年M月D日（曜）に整形する", () => {
    // 2026-06-08T00:00:00Z = JST 2026-06-08 09:00（月）
    expect(jstDateLabel(Date.UTC(2026, 5, 8, 0, 0, 0))).toBe("2026年6月8日（月）");
  });

  it("UTC 夜は翌日の JST 日付になる（タイムゾーン反映）", () => {
    // 2026-06-07T20:00:00Z = JST 2026-06-08 05:00（月）
    expect(jstDateLabel(Date.UTC(2026, 5, 7, 20, 0, 0))).toBe("2026年6月8日（月）");
  });
});

describe("buildNoticeAssistUser", () => {
  it("基準日（今日）とメモを両方含める", () => {
    const u = buildNoticeAssistUser("明日は短縮授業", "2026年6月8日（月）");
    expect(u).toContain("基準日（今日）: 2026年6月8日（月）");
    expect(u).toContain("明日は短縮授業");
  });

  it("adjust 指示があれば【調整の指示】として付す（無ければ付さない）", () => {
    expect(buildNoticeAssistUser("メモ", "2026年6月8日（月）")).not.toContain("【調整の指示】");
    const u = buildNoticeAssistUser("メモ", "2026年6月8日（月）", "短くする。");
    expect(u).toContain("【調整の指示】短くする。");
  });
});

describe("parseScheduleProposal", () => {
  it("正常な JSON から schedules を取り出し period 昇順に正規化する", () => {
    const r = parseScheduleProposal(
      '{"schedules":[{"period":2,"subject":"英語","location":"視聴覚室","targetAudience":"3年"},{"period":1,"subject":"数学"}]}',
    );
    expect(r).toEqual([
      { period: 1, subject: "数学" },
      { period: 2, subject: "英語", location: "視聴覚室", targetAudience: "3年" },
    ]);
  });

  it("period が文字列でも数値に正規化して受理する", () => {
    expect(parseScheduleProposal('{"schedules":[{"period":"3","subject":"理科"}]}')).toEqual([
      { period: 3, subject: "理科" },
    ]);
  });

  it("```json コードフェンス付きでも取り出す", () => {
    expect(
      parseScheduleProposal('```json\n{"schedules":[{"period":1,"subject":"国語"}]}\n```'),
    ).toEqual([{ period: 1, subject: "国語" }]);
  });

  it("JSON でない/壊れた応答は null", () => {
    expect(parseScheduleProposal("1限 数学")).toBeNull();
    expect(parseScheduleProposal('{"schedules":')).toBeNull();
  });

  it("空配列は空配列（呼び出し側が no_result 判定）", () => {
    expect(parseScheduleProposal('{"schedules":[]}')).toEqual([]);
  });

  it("period が範囲外/重複なら検証で全体拒否され null", () => {
    expect(parseScheduleProposal('{"schedules":[{"period":0,"subject":"x"}]}')).toBeNull();
    expect(parseScheduleProposal('{"schedules":[{"period":13,"subject":"x"}]}')).toBeNull();
    expect(
      parseScheduleProposal(
        '{"schedules":[{"period":1,"subject":"a"},{"period":1,"subject":"b"}]}',
      ),
    ).toBeNull();
  });
});

describe("parseAssignmentProposal", () => {
  it("正常な JSON から assignments を取り出す", () => {
    const r = parseAssignmentProposal(
      '{"assignments":[{"deadline":"2026-06-20","subject":"数学","task":"ワークP30"}]}',
    );
    expect(r).toEqual([{ deadline: "2026-06-20", subject: "数学", task: "ワークP30" }]);
  });

  it("```json コードフェンス付きでも取り出す", () => {
    expect(
      parseAssignmentProposal(
        '```json\n{"assignments":[{"deadline":"2026-06-30","subject":"英語","task":"音読"}]}\n```',
      ),
    ).toEqual([{ deadline: "2026-06-30", subject: "英語", task: "音読" }]);
  });

  it("実在しない日付(2026-02-30)は検証で拒否され null", () => {
    expect(
      parseAssignmentProposal(
        '{"assignments":[{"deadline":"2026-02-30","subject":"数学","task":"x"}]}',
      ),
    ).toBeNull();
  });

  it("必須フィールド欠落は null", () => {
    expect(
      parseAssignmentProposal('{"assignments":[{"deadline":"2026-06-20","subject":"数学"}]}'),
    ).toBeNull();
  });

  it("JSON でない/空配列の扱い", () => {
    expect(parseAssignmentProposal("提出物: 数学")).toBeNull();
    expect(parseAssignmentProposal('{"assignments":[]}')).toEqual([]);
  });
});

describe("buildSectionAssistUser", () => {
  it("section に応じて『次のメモから〇〇を作成してください』の和名が変わる", () => {
    const ref = "2026年6月8日（月）";
    expect(buildSectionAssistUser("schedules", "メモ", ref)).toContain(
      "次のメモから予定を作成してください",
    );
    expect(buildSectionAssistUser("notices", "メモ", ref)).toContain(
      "次のメモから連絡を作成してください",
    );
    expect(buildSectionAssistUser("assignments", "メモ", ref)).toContain(
      "次のメモから提出物を作成してください",
    );
  });

  it("基準日とメモを含め、adjust があれば【調整の指示】を付す", () => {
    const u = buildSectionAssistUser(
      "schedules",
      "1限数学",
      "2026年6月8日（月）",
      "場所も入れる。",
    );
    expect(u).toContain("基準日（今日）: 2026年6月8日（月）");
    expect(u).toContain("1限数学");
    expect(u).toContain("【調整の指示】場所も入れる。");
  });

  it("buildNoticeAssistUser は section='notices' のラッパで出力が一致（後方互換）", () => {
    const ref = "2026年6月8日（月）";
    expect(buildNoticeAssistUser("メモ", ref, "短く。")).toBe(
      buildSectionAssistUser("notices", "メモ", ref, "短く。"),
    );
  });
});

describe("SECTION_ASSIST_SYSTEM", () => {
  it("3 セクション全てに非空の system プロンプトがある", () => {
    for (const key of ["schedules", "notices", "assignments"] as const) {
      expect(SECTION_ASSIST_SYSTEM[key].length).toBeGreaterThan(0);
    }
  });

  it("予定は schedules JSON、提出物は YYYY-MM-DD 変換を指示する", () => {
    expect(SCHEDULE_ASSIST_SYSTEM).toContain('"schedules"');
    expect(ASSIGNMENT_ASSIST_SYSTEM).toContain("YYYY-MM-DD");
  });
});

describe("parseNoticeTone / NOTICE_TONE_INSTRUCTIONS", () => {
  it("既知のトーンキーのみ受理し、未知/非文字列は null（外部入力を信用しない）", () => {
    expect(parseNoticeTone("short")).toBe("short");
    expect(parseNoticeTone("polite")).toBe("polite");
    expect(parseNoticeTone("evil")).toBeNull();
    expect(parseNoticeTone(42)).toBeNull();
    expect(parseNoticeTone(undefined)).toBeNull();
  });

  it("全トーンキーに固定指示文が定義されている", () => {
    for (const key of [
      "short",
      "detailed",
      "polite",
      "soft",
      "concise",
      "formal",
      "rephrase",
      "bullet",
      "plain",
    ] as const) {
      expect(NOTICE_TONE_INSTRUCTIONS[key].length).toBeGreaterThan(0);
    }
  });
});
