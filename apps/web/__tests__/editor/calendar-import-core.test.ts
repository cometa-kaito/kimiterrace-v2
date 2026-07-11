import type { ModelClient, ModelRequest } from "@kimiterrace/ai";
import { describe, expect, it } from "vitest";
import {
  type CalendarImportEvent,
  MAX_FILE_IMPORT_EVENTS,
  buildCalendarImportSystem,
  buildCalendarImportUser,
  fiscalYearWindow,
  parseCalendarImportProposal,
  sanitizeImportedEvents,
} from "../../lib/editor/calendar-import-core";
import {
  CALENDAR_IMPORT_INPUT_MAX,
  CALENDAR_IMPORT_MAX_OUTPUT_TOKENS,
  draftCalendarEventsFromText,
} from "../../lib/editor/calendar-import-draft";

/**
 * ADR-049 PR-B: 年間行事取込コアの純検証（DB/Vertex 非依存）。年度窓の境界・サニタイズの drop 理由別
 * 件数・dedupe・クランプ・Zod 防御と、フェイク ModelClient による JSON→validate→sanitize の結線
 * （マスク往復・fail-closed 含む）を固める。
 */

/** 2026-06-01T12:00 JST（年度 2026 の中日）。 */
const MID_FY2026 = Date.UTC(2026, 5, 1, 3, 0, 0);

const FY2026 = { fiscalYear: 2026, start: "2026-04-01", end: "2027-03-31" };

function ev(over: Partial<CalendarImportEvent> & { summary: string }): CalendarImportEvent {
  return { startDate: "2026-05-10", allDay: true, ...over };
}

describe("fiscalYearWindow", () => {
  it("4/1 JST 00:00 ちょうどから新年度（UTC ではまだ 3/31 でも JST で判定）", () => {
    // 2026-04-01T00:00:00 JST = 2026-03-31T15:00:00Z
    expect(fiscalYearWindow(Date.UTC(2026, 2, 31, 15, 0, 0))).toEqual(FY2026);
  });

  it("3/31 JST 23:59 までは前年度", () => {
    // 2026-03-31T23:59:59 JST = 2026-03-31T14:59:59Z
    expect(fiscalYearWindow(Date.UTC(2026, 2, 31, 14, 59, 59))).toEqual({
      fiscalYear: 2025,
      start: "2025-04-01",
      end: "2026-03-31",
    });
  });

  it("1〜3 月は前年が年度年（2027-01-15 → 年度 2026）", () => {
    expect(fiscalYearWindow(Date.UTC(2027, 0, 15, 3, 0, 0))).toEqual(FY2026);
  });
});

describe("parseCalendarImportProposal（Zod スキーマ防御）", () => {
  it("正常な JSON から events を取り出す（allDay 省略は true・空文字の任意項目は省略扱い）", () => {
    const r = parseCalendarImportProposal(
      JSON.stringify({
        events: [
          { summary: "体育祭", startDate: "2026-05-20", location: "グラウンド" },
          { summary: "中間考査", startDate: "2026-05-25", endDate: "2026-05-28", allDay: true },
          { summary: "終業式", startDate: "2026-07-20", endDate: "", location: " " },
        ],
      }),
    );
    expect(r).toEqual({
      events: [
        { summary: "体育祭", startDate: "2026-05-20", allDay: true, location: "グラウンド" },
        { summary: "中間考査", startDate: "2026-05-25", endDate: "2026-05-28", allDay: true },
        { summary: "終業式", startDate: "2026-07-20", allDay: true },
      ],
      malformed: 0,
    });
  });

  it("```json コードフェンス付きでも取り出す", () => {
    const r = parseCalendarImportProposal(
      '```json\n{"events":[{"summary":"入学式","startDate":"2026-04-08"}]}\n```',
    );
    expect(r?.events).toEqual([{ summary: "入学式", startDate: "2026-04-08", allDay: true }]);
  });

  it("スキーマ不適合の行だけを malformed として drop する（全体は失敗させない）", () => {
    const r = parseCalendarImportProposal(
      JSON.stringify({
        events: [
          { summary: "文化祭", startDate: "2026-10-03" },
          { summary: "", startDate: "2026-10-04" }, // summary 空
          { summary: "遠足", startDate: "10/5" }, // 日付形不正
          { summary: "あ".repeat(201), startDate: "2026-10-06" }, // summary 過長
          { startDate: "2026-10-07" }, // summary 欠落
        ],
      }),
    );
    expect(r?.events).toEqual([{ summary: "文化祭", startDate: "2026-10-03", allDay: true }]);
    expect(r?.malformed).toBe(4);
  });

  it("エンベロープが壊れていれば null（JSON 不正 / 非オブジェクト / events 非配列）", () => {
    expect(parseCalendarImportProposal("行事はありません")).toBeNull();
    expect(parseCalendarImportProposal('"events"')).toBeNull();
    expect(parseCalendarImportProposal('{"events":{}}')).toBeNull();
  });
});

describe("sanitizeImportedEvents", () => {
  it("非実在日（2026-02-30）は invalidDate、年度窓外は outOfWindow として行を drop", () => {
    const r = sanitizeImportedEvents(
      [
        ev({ summary: "球技大会", startDate: "2027-02-30" }), // 形は合うが非実在
        ev({ summary: "旧年度行事", startDate: "2026-03-31" }), // 窓の前日
        ev({ summary: "翌年度行事", startDate: "2027-04-01" }), // 窓の翌日
        ev({ summary: "修了式", startDate: "2027-03-31" }), // 窓の最終日（残る）
        ev({ summary: "入学式", startDate: "2026-04-01" }), // 窓の初日（残る）
      ],
      FY2026,
    );
    expect(r.events.map((e) => e.summary)).toEqual(["修了式", "入学式"]);
    expect(r.dropped).toEqual({
      invalidDate: 1,
      outOfWindow: 2,
      duplicates: 0,
      overCap: 0,
      endDateStripped: 0,
    });
  });

  it("endDate のみ不正（開始日より前 / 非実在 / 窓超過）は endDate を落として単日で残す", () => {
    const r = sanitizeImportedEvents(
      [
        ev({ summary: "修学旅行", startDate: "2026-06-10", endDate: "2026-06-08" }), // 逆転
        ev({ summary: "宿泊研修", startDate: "2026-06-15", endDate: "2026-06-31" }), // 非実在
        ev({ summary: "学年末考査", startDate: "2027-03-29", endDate: "2027-04-02" }), // 窓超過
        ev({ summary: "中間考査", startDate: "2026-05-25", endDate: "2026-05-28" }), // 正常（保持）
      ],
      FY2026,
    );
    expect(r.events).toEqual([
      { summary: "修学旅行", startDate: "2026-06-10", allDay: true, endDate: undefined },
      { summary: "宿泊研修", startDate: "2026-06-15", allDay: true, endDate: undefined },
      { summary: "学年末考査", startDate: "2027-03-29", allDay: true, endDate: undefined },
      { summary: "中間考査", startDate: "2026-05-25", allDay: true, endDate: "2026-05-28" },
    ]);
    expect(r.dropped.endDateStripped).toBe(3);
  });

  it("同一 (summary, startDate) は先勝ちで dedupe（別日/別名は残す）", () => {
    const r = sanitizeImportedEvents(
      [
        ev({ summary: "体育祭", startDate: "2026-05-20", location: "グラウンド" }),
        ev({ summary: "体育祭", startDate: "2026-05-20" }), // 後勝ち分は drop
        ev({ summary: "体育祭", startDate: "2026-05-21" }), // 別日は残す
        ev({ summary: "予行", startDate: "2026-05-20" }), // 別名は残す
      ],
      FY2026,
    );
    expect(r.events).toHaveLength(3);
    expect(r.events[0]?.location).toBe("グラウンド"); // 先勝ち
    expect(r.dropped.duplicates).toBe(1);
  });

  it("上限（MAX_FILE_IMPORT_EVENTS=2000）でクランプし超過数を overCap で返す", () => {
    const many = Array.from({ length: MAX_FILE_IMPORT_EVENTS + 3 }, (_, i) =>
      ev({ summary: `行事${i}`, startDate: "2026-05-10" }),
    );
    const r = sanitizeImportedEvents(many, FY2026);
    expect(r.events).toHaveLength(MAX_FILE_IMPORT_EVENTS);
    expect(r.dropped.overCap).toBe(3);
  });
});

describe("プロンプト（年度文脈の注入）", () => {
  it("system に年度窓と年推定規則（4〜12月→年度年 / 1〜3月→翌年）を明記する", () => {
    const system = buildCalendarImportSystem(FY2026);
    expect(system).toContain("2026-04-01〜2027-03-31");
    expect(system).toContain("4〜12月は 2026 年、1〜3月は 2027 年");
    expect(system).toContain("個人情報は出力に含めない");
    expect(system).toContain("創作しない");
  });

  it("user に対象年度とマスク済みテキストを載せる", () => {
    const user = buildCalendarImportUser("5/20 体育祭", FY2026);
    expect(user).toContain("対象年度: 2026年度");
    expect(user).toContain("5/20 体育祭");
  });
});

/** generate 呼び出しを捕捉して固定応答を返すフェイク ModelClient。 */
function fakeModel(text: string, captured: ModelRequest[] = []): ModelClient {
  return {
    async generate(req) {
      captured.push(req);
      return {
        text,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        modelVersion: "fake-model",
      };
    },
  };
}

describe("draftCalendarEventsFromText", () => {
  it("正常系: マスク済み user プロンプト + maxOutputTokens で生成し sanitize 済み events を返す", async () => {
    const captured: ModelRequest[] = [];
    const model = fakeModel(
      JSON.stringify({
        events: [
          { summary: "体育祭", startDate: "2026-05-20" },
          { summary: "体育祭", startDate: "2026-05-20" }, // dedupe される
          { summary: "旧年度行事", startDate: "2026-03-01" }, // 窓外
        ],
      }),
      captured,
    );
    const r = await draftCalendarEventsFromText(
      "5/20 体育祭ほか年間行事",
      {},
      { model, nowMs: MID_FY2026 },
    );
    expect(r).toEqual({
      ok: true,
      events: [{ summary: "体育祭", startDate: "2026-05-20", allDay: true, endDate: undefined }],
      dropped: {
        malformed: 0,
        invalidDate: 0,
        outOfWindow: 1,
        duplicates: 1,
        overCap: 0,
        endDateStripped: 0,
      },
      window: FY2026,
      suspectedNameCount: 0,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.system).toContain("2026-04-01〜2027-03-31");
    expect(captured[0]?.user).toContain("5/20 体育祭ほか年間行事");
    expect(captured[0]?.maxOutputTokens).toBe(CALENDAR_IMPORT_MAX_OUTPUT_TOKENS);
  });

  it("空入力は empty、上限超過は too_long（silent truncate しない）", async () => {
    const captured: ModelRequest[] = [];
    const model = fakeModel('{"events":[]}', captured);
    expect(await draftCalendarEventsFromText("  ", {}, { model })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      await draftCalendarEventsFromText("あ".repeat(CALENDAR_IMPORT_INPUT_MAX + 1), {}, { model }),
    ).toEqual({ ok: false, reason: "too_long" });
    expect(captured).toHaveLength(0); // いずれもモデルへは送らない
  });

  it("氏名らしき語は未 override なら送信せず pii_warning（override で送信・件数を返す）", async () => {
    const captured: ModelRequest[] = [];
    const model = fakeModel(
      '{"events":[{"summary":"創立記念式典","startDate":"2026-06-05"}]}',
      captured,
    );
    const input = "6/5 創立記念式典（司会: 田中太郎さん）";

    const warned = await draftCalendarEventsFromText(input, {}, { model, nowMs: MID_FY2026 });
    expect(warned).toEqual({
      ok: false,
      reason: "pii_warning",
      suspectedSurfaces: ["田中太郎さん"],
    });
    expect(captured).toHaveLength(0); // 未 override は送信しない

    const acked = await draftCalendarEventsFromText(
      input,
      { acknowledgePii: true },
      { model, nowMs: MID_FY2026 },
    );
    expect(acked.ok).toBe(true);
    if (acked.ok) {
      expect(acked.suspectedNameCount).toBe(1);
    }
  });

  it("書式 PII（電話）はマスクして送信し、モデルが token を返せば逆マスクする（ルール4）", async () => {
    const captured: ModelRequest[] = [];
    const model = fakeModel(
      '{"events":[{"summary":"学校公開（問合せ {{PHONE_001}}）","startDate":"2026-09-12"}]}',
      captured,
    );
    const r = await draftCalendarEventsFromText(
      "9/12 学校公開（問合せ 090-1234-5678）",
      {},
      { model, nowMs: MID_FY2026 },
    );
    // 送信プロンプトに生電話番号が含まれない（マスク済みのみ送信）。
    expect(captured[0]?.user).not.toContain("090-1234-5678");
    expect(captured[0]?.user).toContain("{{PHONE_001}}");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events[0]?.summary).toBe("学校公開（問合せ 090-1234-5678）");
    }
  });

  it("モデル出力に辞書に無い生 PII が現れたら fail-closed（pii_leak）", async () => {
    const model = fakeModel(
      '{"events":[{"summary":"連絡先 080-9999-8888","startDate":"2026-09-12"}]}',
    );
    const r = await draftCalendarEventsFromText("9/12 学校公開", {}, { model, nowMs: MID_FY2026 });
    expect(r).toEqual({ ok: false, reason: "pii_leak" });
  });

  it("応答が JSON でない / events が空なら no_result", async () => {
    expect(
      await draftCalendarEventsFromText(
        "年間行事",
        {},
        { model: fakeModel("行事はありません"), nowMs: MID_FY2026 },
      ),
    ).toEqual({ ok: false, reason: "no_result" });
    expect(
      await draftCalendarEventsFromText(
        "年間行事",
        {},
        { model: fakeModel('{"events":[]}'), nowMs: MID_FY2026 },
      ),
    ).toEqual({ ok: false, reason: "no_result" });
  });

  it("モデル障害（throw）は error に畳む（throw しない）", async () => {
    const model: ModelClient = {
      async generate() {
        throw new Error("vertex unavailable");
      },
    };
    const r = await draftCalendarEventsFromText("年間行事", {}, { model, nowMs: MID_FY2026 });
    expect(r).toEqual({ ok: false, reason: "error" });
  });
});
