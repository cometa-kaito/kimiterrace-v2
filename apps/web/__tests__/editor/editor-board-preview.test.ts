import { describe, expect, it } from "vitest";
import {
  type EditorBoardBase,
  type EditorBoardDraft,
  buildEditorPreviewPayload,
} from "@/lib/editor/editor-board-preview";

/**
 * WYSIWYG エディタのデータブリッジ（{@link buildEditorPreviewPayload}）の純ロジック検証。
 *
 * 「編集中の当日下書きを基底スナップショットに上書きして実機 `SignagePayload` を合成する」規約を固定する:
 * - daily の予定/連絡/提出物は編集中 items に差し替わり、source は `class`（継承バッジを出さない）。
 * - quietHours は編集対象外なので基底のまま温存。
 * - scheduleDays は当日列だけ差し替え、他日付（明日以降）は基底のまま残す。
 * - 編集対象外の表示フィールド（広告/天気/クラス文脈/パターン/黒画面）はそのまま通る。
 * 保存ロジックには一切関与しない（本関数は DB に触れない・表示用 payload 合成のみ）。
 */

const TODAY = "2026-06-15";
const TOMORROW = "2026-06-16";

function baseFixture(): EditorBoardBase {
  return {
    date: TODAY,
    designPattern: "pattern1",
    daily: {
      date: TODAY,
      schedules: { items: [{ period: 1, subject: "旧・国語" }], source: "school" },
      notices: { items: [{ text: "旧・連絡" }], source: "grade" },
      assignments: {
        items: [{ deadline: TODAY, subject: "数学", task: "旧・課題" }],
        source: "class",
      },
      quietHours: { items: [{ start: "12:30", end: "13:00" }], source: "class" },
    },
    scheduleDays: [
      { date: TODAY, schedule: { items: [{ period: 1, subject: "旧・国語" }], source: "school" } },
      {
        date: TOMORROW,
        schedule: { items: [{ period: 2, subject: "明日・英語" }], source: "class" },
      },
    ],
    ads: [],
    weather: null,
    classContext: { className: "1年A組", gradeName: "1年", departmentName: "電子工学科" },
    presenceCount: null,
    visitors: null,
    callouts: null,
    trainStatus: null,
    news: null,
    weatherWarnings: null,
    heatAlerts: null,
    blackout: false,
  };
}

const draft: EditorBoardDraft = {
  schedules: [
    { period: 1, subject: "新・国語" },
    { period: 2, subject: "新・数学" },
  ],
  notices: [{ text: "新・連絡", isHighlight: true }],
  assignments: [{ deadline: TOMORROW, subject: "理科", task: "新・課題" }],
};

describe("buildEditorPreviewPayload", () => {
  it("daily の予定/連絡/提出物を編集中 items に差し替え、source は class にする", () => {
    const out = buildEditorPreviewPayload(baseFixture(), draft);
    expect(out.daily.schedules).toEqual({ items: draft.schedules, source: "class" });
    expect(out.daily.notices).toEqual({ items: draft.notices, source: "class" });
    expect(out.daily.assignments).toEqual({ items: draft.assignments, source: "class" });
  });

  it("quietHours は編集対象外なので基底のまま温存する", () => {
    const base = baseFixture();
    const out = buildEditorPreviewPayload(base, draft);
    expect(out.daily.quietHours).toEqual(base.daily.quietHours);
  });

  it("scheduleDays は当日列だけ差し替え、他日付は基底のまま残す", () => {
    const out = buildEditorPreviewPayload(baseFixture(), draft);
    const today = out.scheduleDays.find((d) => d.date === TODAY);
    const tomorrow = out.scheduleDays.find((d) => d.date === TOMORROW);
    expect(today?.schedule).toEqual({ items: draft.schedules, source: "class" });
    // 明日列は基底のまま（編集は当日のみ）。
    expect(tomorrow?.schedule).toEqual({
      items: [{ period: 2, subject: "明日・英語" }],
      source: "class",
    });
  });

  it("編集対象外の表示フィールド（広告/天気/クラス文脈/パターン/黒画面）はそのまま通す", () => {
    const base = baseFixture();
    const out = buildEditorPreviewPayload(base, draft);
    expect(out.date).toBe(TODAY);
    expect(out.designPattern).toBe("pattern1");
    expect(out.ads).toBe(base.ads);
    expect(out.weather).toBe(base.weather);
    expect(out.classContext).toEqual(base.classContext);
    expect(out.blackout).toBe(false);
  });

  it("基底スナップショットを破壊しない（入力 base.daily を書き換えない）", () => {
    const base = baseFixture();
    buildEditorPreviewPayload(base, draft);
    // 元の base.daily.schedules は旧 items のまま（副作用なし）。
    expect(base.daily.schedules).toEqual({
      items: [{ period: 1, subject: "旧・国語" }],
      source: "school",
    });
    expect(base.scheduleDays[0]?.schedule.items).toEqual([{ period: 1, subject: "旧・国語" }]);
  });
});
