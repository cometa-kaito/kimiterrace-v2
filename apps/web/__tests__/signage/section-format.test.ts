import { type SignageSectionKind, formatSignageItem } from "@/lib/signage/section-format";
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
});
