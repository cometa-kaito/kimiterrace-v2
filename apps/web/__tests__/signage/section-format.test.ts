import {
  type SignageSectionKind,
  formatSignageItem,
  parseAssignmentRow,
  parseScheduleRow,
} from "@/lib/signage/section-format";
import { describe, expect, it } from "vitest";

/**
 * `formatSignageItem` の網羅テスト (#48-E1/#48-E2 共有整形)。
 *
 * 確定スキーマ (#48-H/#48-I/#48-J-2) の rich 表示と、opaque JSONB に対する fail-soft フォールバックを
 * 突く。旧 `itemLabel` が捨てていた period/deadline/task/isHighlight、および生 JSON が露出していた
 * quiet_hours を、回帰しないよう固定する。
 */
describe("formatSignageItem", () => {
  describe("schedules", () => {
    it("時限を冠して 'N限 科目' を出す (旧実装が捨てていた period)", () => {
      expect(formatSignageItem("schedules", { period: 1, subject: "数学" })).toEqual({
        text: "1限 数学",
      });
    });

    it("補足 note があれば括弧で添える", () => {
      expect(
        formatSignageItem("schedules", { period: 3, subject: "理科", note: "小テスト" }),
      ).toEqual({ text: "3限 理科（小テスト）" });
    });

    it("period が無ければ科目のみ (防御的)", () => {
      expect(formatSignageItem("schedules", { subject: "国語" })).toEqual({ text: "国語" });
    });

    it("subject 欠落は汎用フォールバック", () => {
      expect(formatSignageItem("schedules", { period: 2 })).toEqual({ text: '{"period":2}' });
    });
  });

  describe("notices", () => {
    it("本文を出す", () => {
      expect(formatSignageItem("notices", { text: "今日は短縮授業です" })).toEqual({
        text: "今日は短縮授業です",
      });
    });

    it("isHighlight=true で emphasis を立てる (旧実装が捨てていた重要マーク)", () => {
      expect(formatSignageItem("notices", { text: "避難訓練", isHighlight: true })).toEqual({
        text: "避難訓練",
        emphasis: true,
      });
    });

    it("isHighlight が true 以外 (文字列等) は emphasis を立てない", () => {
      expect(formatSignageItem("notices", { text: "連絡", isHighlight: "true" })).toEqual({
        text: "連絡",
      });
    });
  });

  describe("assignments", () => {
    it("科目・内容・期限を 'M/D' で出す (旧実装は subject だけ)", () => {
      expect(
        formatSignageItem("assignments", {
          deadline: "2026-06-05",
          subject: "数学",
          task: "プリント p.12〜14",
        }),
      ).toEqual({ text: "数学：プリント p.12〜14（〆6/5）" });
    });

    it("deadline 欠落でも科目・内容は出す", () => {
      expect(formatSignageItem("assignments", { subject: "英語", task: "音読" })).toEqual({
        text: "英語：音読",
      });
    });

    it("task 欠落は汎用フォールバック (subject を拾う)", () => {
      expect(formatSignageItem("assignments", { deadline: "2026-06-05", subject: "社会" })).toEqual(
        { text: "社会" },
      );
    });
  });

  describe("quietHours", () => {
    it("'開始–終了' を出す (旧実装は生 JSON を露出していた)", () => {
      const line = formatSignageItem("quietHours", { start: "12:30", end: "13:00" });
      expect(line).toEqual({ text: "12:30–13:00" });
      // 生 JSON が混入していないことを明示的に固定 (回帰防止)。
      expect(line.text).not.toContain("{");
    });

    it("start/end 欠落は汎用フォールバック", () => {
      expect(formatSignageItem("quietHours", { start: "12:30" })).toEqual({
        text: '{"start":"12:30"}',
      });
    });
  });

  describe("fail-soft フォールバック (opaque / 旧データ)", () => {
    it("文字列要素はそのまま", () => {
      expect(formatSignageItem("notices", "そのまま表示")).toEqual({ text: "そのまま表示" });
    });

    it("汎用オブジェクトは代表キーの先頭ヒット (title)", () => {
      expect(formatSignageItem("schedules", { title: "全校集会", extra: 1 })).toEqual({
        text: "全校集会",
      });
    });

    it("代表キーを持たないオブジェクトは JSON 文字列 (最終手段)", () => {
      expect(formatSignageItem("notices", { foo: "bar" })).toEqual({ text: '{"foo":"bar"}' });
    });

    it("配列要素は汎用扱い (kind formatter を通さない)", () => {
      expect(formatSignageItem("schedules", ["a", "b"])).toEqual({ text: '["a","b"]' });
    });
  });

  it("全 kind を受け付ける (型網羅)", () => {
    const kinds: SignageSectionKind[] = ["schedules", "notices", "assignments", "quietHours"];
    for (const kind of kinds) {
      expect(typeof formatSignageItem(kind, {}).text).toBe("string");
    }
  });

  it("SignageSectionKind は EffectiveDailyData のセクション名から派生し縮まない (型結合の回帰ピン)", () => {
    // `satisfies Record<SignageSectionKind, true>` は SignageSectionKind の全メンバを
    // 過不足なく要求する → EffectiveDailyData 側でセクションを改名/増減すると、
    // section-format.ts の Pick / FORMATTERS と併せてここがコンパイルエラーになる。
    // (#247 / PR #238 Reviewer M-1: 型の単一ソースを typecheck で機械強制)
    const cover = {
      schedules: true,
      notices: true,
      assignments: true,
      quietHours: true,
    } satisfies Record<SignageSectionKind, true>;
    expect(Object.keys(cover).sort()).toEqual([
      "assignments",
      "notices",
      "quietHours",
      "schedules",
    ]);
  });
});

describe("parseScheduleRow (予定グリッドの時限 + 内容 分割)", () => {
  it("時限ラベルと内容 (科目 + 補足) に分ける", () => {
    expect(parseScheduleRow({ period: 3, subject: "理科", note: "実験室" })).toEqual({
      periodLabel: "3限",
      content: "理科（実験室）",
    });
  });

  it("note 無しは科目のみ", () => {
    expect(parseScheduleRow({ period: 2, subject: "英語" })).toEqual({
      periodLabel: "2限",
      content: "英語",
    });
  });

  it("period 欠損/非正は時限ラベル空", () => {
    expect(parseScheduleRow({ subject: "数学" })).toEqual({ periodLabel: "", content: "数学" });
    expect(parseScheduleRow({ period: 0, subject: "数学" })).toEqual({
      periodLabel: "",
      content: "数学",
    });
  });

  it("確定スキーマ外は時限空 + 汎用ラベルにフォールバック (表示を壊さない)", () => {
    expect(parseScheduleRow("自由テキスト")).toEqual({ periodLabel: "", content: "自由テキスト" });
  });
});

describe("parseAssignmentRow (提出物テーブルの列 + 残日数)", () => {
  const TODAY = "2026-06-06";

  it("subject/task/期限短縮 + 残日数 (あとN日) を返す", () => {
    expect(
      parseAssignmentRow({ deadline: "2026-06-13", subject: "数学", task: "ワーク" }, TODAY),
    ).toEqual({
      subject: "数学",
      task: "ワーク",
      deadlineShort: "6/13",
      daysLeft: "あと7日",
      isOverdue: false,
      isUrgent: false,
    });
  });

  it("当日締切は『今日』で緊急", () => {
    const row = parseAssignmentRow({ deadline: TODAY, subject: "国語", task: "音読" }, TODAY);
    expect(row).toMatchObject({ daysLeft: "今日", isUrgent: true, isOverdue: false });
  });

  it("翌日締切は『明日』で緊急", () => {
    const row = parseAssignmentRow(
      { deadline: "2026-06-07", subject: "英語", task: "単語" },
      TODAY,
    );
    expect(row).toMatchObject({ daysLeft: "明日", isUrgent: true, isOverdue: false });
  });

  it("期限超過は『N日超過』で overdue", () => {
    const row = parseAssignmentRow(
      { deadline: "2026-06-04", subject: "理科", task: "レポート" },
      TODAY,
    );
    expect(row).toMatchObject({ daysLeft: "2日超過", isOverdue: true, isUrgent: false });
  });

  it("subject/task 欠損は null (表に出さない)", () => {
    expect(parseAssignmentRow({ deadline: TODAY, subject: "数学" }, TODAY)).toBeNull();
    expect(parseAssignmentRow({ deadline: TODAY, task: "ワーク" }, TODAY)).toBeNull();
    expect(parseAssignmentRow("生文字列", TODAY)).toBeNull();
  });

  it("期限欠損/不正は残日数空・非緊急 (表示は壊さない)", () => {
    const row = parseAssignmentRow({ subject: "数学", task: "ワーク" }, TODAY);
    expect(row).toMatchObject({
      daysLeft: "",
      deadlineShort: "",
      isOverdue: false,
      isUrgent: false,
    });
  });
});
