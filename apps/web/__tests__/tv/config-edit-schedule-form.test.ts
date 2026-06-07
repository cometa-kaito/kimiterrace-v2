import { describe, expect, it } from "vitest";
import {
  type TvScheduleFormState,
  WEEKDAY_LABELS,
  formStateToScheduleInput,
  scheduleToFormState,
} from "@/lib/tv/config-edit-core";

/**
 * F15 §4.2: TV 表示時間（hour）・表示曜日（weekday）編集フォームの純変換ロジックの単体検証。
 * フォーム state ⇔ TvSchedule の往復を決定的にテストする（RTL の React 19 transition flaky を避けるため
 * 変換を core の純関数へ切り出した、[[feedback_react19_transition_pending_test_flaky]]）。
 */

function form(over: Partial<TvScheduleFormState> = {}): TvScheduleFormState {
  return {
    enabled: false,
    onHour: "",
    offHour: "",
    weekdays: [false, false, false, false, false, false, false],
    ...over,
  };
}

describe("WEEKDAY_LABELS", () => {
  it("0=日..6=土 の 7 曜日", () => {
    expect(WEEKDAY_LABELS).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
  });
});

describe("scheduleToFormState", () => {
  it("null はスケジュール無し（無効・時刻空・全曜日チェックなし）", () => {
    expect(scheduleToFormState(null)).toEqual(form());
  });

  it("時刻・曜日を展開する（weekdays は index で boolean 化）", () => {
    const s = scheduleToFormState({
      enabled: true,
      onHour: 8,
      offHour: 17,
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(s.enabled).toBe(true);
    expect(s.onHour).toBe("8");
    expect(s.offHour).toBe("17");
    // 月(1)〜金(5) が true、日(0)・土(6) が false
    expect(s.weekdays).toEqual([false, true, true, true, true, true, false]);
  });

  it("weekdays 未指定（=全曜日）は全チェックなしで表現", () => {
    const s = scheduleToFormState({ enabled: true });
    expect(s.weekdays).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("formStateToScheduleInput", () => {
  it("全項目空なら null（スケジュール無し）", () => {
    expect(formStateToScheduleInput(form())).toBeNull();
  });

  it("enabled のみでも schedule を返す", () => {
    expect(formStateToScheduleInput(form({ enabled: true }))).toEqual({ enabled: true });
  });

  it("時刻を数値化して含める", () => {
    expect(formStateToScheduleInput(form({ enabled: true, onHour: "8", offHour: "17" }))).toEqual({
      enabled: true,
      onHour: 8,
      offHour: 17,
    });
  });

  it("部分選択の曜日は昇順配列で含める", () => {
    const out = formStateToScheduleInput(
      form({ enabled: true, weekdays: [false, true, true, true, true, true, false] }),
    );
    expect(out?.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("全曜日選択は weekdays を省略（毎日）", () => {
    const out = formStateToScheduleInput(
      form({ enabled: true, weekdays: [true, true, true, true, true, true, true] }),
    );
    expect(out).toEqual({ enabled: true });
    expect(out && "weekdays" in out).toBe(false);
  });

  it("曜日未選択は weekdays を省略（毎日）", () => {
    const out = formStateToScheduleInput(form({ enabled: true }));
    expect(out && "weekdays" in out).toBe(false);
  });

  it("曜日のみ選択でも schedule を返す（enabled は false のまま）", () => {
    const out = formStateToScheduleInput(
      form({ weekdays: [false, true, false, false, false, false, false] }),
    );
    expect(out).toEqual({ enabled: false, weekdays: [1] });
  });

  it("非数の時刻は NaN を載せ Server 検証に委ねる（空欄との区別）", () => {
    const out = formStateToScheduleInput(form({ enabled: true, onHour: "abc" }));
    expect(out?.onHour).toBeNaN();
  });
});

describe("round-trip", () => {
  it("部分曜日 + 時刻は state ⇔ schedule を保つ", () => {
    const original = { enabled: true, onHour: 7, offHour: 18, weekdays: [1, 3, 5] };
    expect(formStateToScheduleInput(scheduleToFormState(original))).toEqual(original);
  });
});
