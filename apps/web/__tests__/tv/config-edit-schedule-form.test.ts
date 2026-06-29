import type { TvSchedule } from "@kimiterrace/db/tv-schedule";
import { describe, expect, it } from "vitest";
import {
  type TvScheduleFormState,
  WEEKDAY_LABELS,
  formStateToScheduleInput,
  scheduleToFormState,
} from "@/lib/tv/config-edit-core";

/**
 * F15 §4.2: TV 表示時間帯（分単位・複数窓）・表示曜日編集フォームの純変換ロジックの単体検証。
 * フォーム state ⇔ TvSchedule の往復を決定的にテストする（RTL の React 19 transition flaky を避けるため
 * 変換を core の純関数へ切り出した、[[feedback_react19_transition_pending_test_flaky]]）。
 */

function form(over: Partial<TvScheduleFormState> = {}): TvScheduleFormState {
  return {
    enabled: false,
    windows: [{ on: "", off: "" }],
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
  it("null はスケジュール無し（無効・空行 1 つ・全曜日チェックなし）", () => {
    expect(scheduleToFormState(null)).toEqual(form());
  });

  it("legacy 単一窓（時単位）を HH:MM の 1 行に展開する", () => {
    const s = scheduleToFormState({
      enabled: true,
      onHour: 8,
      offHour: 17,
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(s.enabled).toBe(true);
    expect(s.windows).toEqual([{ on: "08:00", off: "17:00" }]);
    // 月(1)〜金(5) が true、日(0)・土(6) が false
    expect(s.weekdays).toEqual([false, true, true, true, true, true, false]);
  });

  it("分単位の legacy 窓も HH:MM に展開する", () => {
    const s = scheduleToFormState({
      enabled: true,
      onHour: 8,
      onMinute: 30,
      offHour: 17,
      offMinute: 45,
    });
    expect(s.windows).toEqual([{ on: "08:30", off: "17:45" }]);
  });

  it("複数窓は各窓を別々の行に展開する", () => {
    const s = scheduleToFormState({
      enabled: true,
      windows: [
        { onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 },
        { onHour: 13, onMinute: 0, offHour: 17, offMinute: 0 },
      ],
    });
    expect(s.windows).toEqual([
      { on: "08:00", off: "12:00" },
      { on: "13:00", off: "17:00" },
    ]);
  });

  it("weekdays 未指定（=全曜日）は全チェックなしで表現", () => {
    const s = scheduleToFormState({ enabled: true });
    expect(s.weekdays).toEqual([false, false, false, false, false, false, false]);
    // 時刻指定なし → 空行 1 つ
    expect(s.windows).toEqual([{ on: "", off: "" }]);
  });
});

describe("formStateToScheduleInput", () => {
  it("全項目空なら null（スケジュール無し）", () => {
    expect(formStateToScheduleInput(form())).toBeNull();
  });

  it("enabled のみでも schedule を返す", () => {
    expect(formStateToScheduleInput(form({ enabled: true }))).toEqual({ enabled: true });
  });

  it("単一窓（分 0）は legacy onHour/offHour で保存（分は省略）", () => {
    expect(
      formStateToScheduleInput(form({ enabled: true, windows: [{ on: "08:00", off: "17:00" }] })),
    ).toEqual({ enabled: true, onHour: 8, offHour: 17 });
  });

  it("単一窓（分あり）は onMinute/offMinute も保存", () => {
    expect(
      formStateToScheduleInput(form({ enabled: true, windows: [{ on: "08:30", off: "17:45" }] })),
    ).toEqual({ enabled: true, onHour: 8, onMinute: 30, offHour: 17, offMinute: 45 });
  });

  it("複数窓は windows 配列で保存", () => {
    expect(
      formStateToScheduleInput(
        form({
          enabled: true,
          windows: [
            { on: "08:00", off: "12:00" },
            { on: "13:30", off: "17:00" },
          ],
        }),
      ),
    ).toEqual({
      enabled: true,
      windows: [
        { onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 },
        { onHour: 13, onMinute: 30, offHour: 17, offMinute: 0 },
      ],
    });
  });

  it("片方だけ入力した行・空行は無視する", () => {
    const out = formStateToScheduleInput(
      form({
        enabled: true,
        windows: [
          { on: "08:00", off: "" },
          { on: "", off: "" },
          { on: "09:00", off: "15:00" },
        ],
      }),
    );
    // 完全な行（09:00-15:00）だけが単一窓として採用される
    expect(out).toEqual({ enabled: true, onHour: 9, offHour: 15 });
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

  it("時間帯のみ入力でも schedule を返す（enabled は false のまま）", () => {
    const out = formStateToScheduleInput(form({ windows: [{ on: "08:00", off: "17:00" }] }));
    expect(out).toEqual({ enabled: false, onHour: 8, offHour: 17 });
  });
});

describe("round-trip", () => {
  it("legacy 単一窓（時単位）は state ⇔ schedule を保つ", () => {
    const original: TvSchedule = { enabled: true, onHour: 7, offHour: 18, weekdays: [1, 3, 5] };
    expect(formStateToScheduleInput(scheduleToFormState(original))).toEqual(original);
  });

  it("分単位の単一窓も往復で保たれる", () => {
    const original: TvSchedule = {
      enabled: true,
      onHour: 7,
      onMinute: 15,
      offHour: 18,
      offMinute: 30,
    };
    expect(formStateToScheduleInput(scheduleToFormState(original))).toEqual(original);
  });

  it("複数窓も往復で保たれる", () => {
    const original: TvSchedule = {
      enabled: true,
      windows: [
        { onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 },
        { onHour: 13, onMinute: 0, offHour: 17, offMinute: 30 },
      ],
      weekdays: [1, 2, 3, 4, 5],
    };
    expect(formStateToScheduleInput(scheduleToFormState(original))).toEqual(original);
  });
});
