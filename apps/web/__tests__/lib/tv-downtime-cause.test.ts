import type { TvSchedule } from "@kimiterrace/db/schema";
import { describe, expect, it } from "vitest";
import { type DowntimeCauseInput, estimateDowntimeCause } from "../../lib/tv/downtime-cause";
import { describeDowntimeCause } from "../../lib/tv/downtime-format";

/**
 * 運営整理 Phase6 (BUG-2): TV ダウンタイム推定原因分類 (estimateDowntimeCause) の単体テスト。
 *
 * ADR-023 §悪い影響に従い「電源OFF/ネット断/アプリ停止は区別不能 → indeterminate に倒し候補 3 つを併記」
 * を境界 (JST 日跨ぎ・夜間窓・発生時刻 vs 復帰時刻) 含めて検証する。純関数・実 PG 不要。
 */

// JST は UTC+9。schedule 8-18 のとき: UTC 05:00 = JST 14:00 (ON) / UTC 11:00 = JST 20:00 (OFF)。
const NOW = new Date("2026-06-02T05:00:00.000Z"); // JST 2026-06-02(火) 14:00、8-18 schedule では ON。
const ON_SCHEDULE: TvSchedule = { enabled: true, onHour: 8, offHour: 18 };

/** JST 火 14:00 (ON 窓内) に発生し 10 分で復帰した unknown 行を既定とするファクトリ。 */
function row(overrides: Partial<DowntimeCauseInput> = {}): DowntimeCauseInput {
  return {
    wentDownAt: new Date("2026-06-02T05:00:00.000Z"), // JST 火 14:00
    recoveredAt: new Date("2026-06-02T05:10:00.000Z"), // JST 火 14:10
    causeHint: "unknown",
    schedule: ON_SCHEDULE,
    ...overrides,
  };
}

describe("estimateDowntimeCause", () => {
  it("1. causeHint=reboot は OFF 窓内でも reboot 優先 (precedence の要)", () => {
    // wentDownAt = JST 20:00 (OFF) でも reboot が勝つ。
    const category = estimateDowntimeCause(
      row({ causeHint: "reboot", wentDownAt: new Date("2026-06-02T11:00:00.000Z") }),
      NOW,
    );
    expect(category).toBe("reboot");
  });

  it("2. causeHint=reboot は継続中 (未復帰) でも reboot (確定事実 > 継続中)", () => {
    const category = estimateDowntimeCause(row({ causeHint: "reboot", recoveredAt: null }), NOW);
    expect(category).toBe("reboot");
  });

  it("3. 復帰済 unknown・schedule null → indeterminate (候補 3)", () => {
    const category = estimateDowntimeCause(row({ causeHint: "unknown", schedule: null }), NOW);
    expect(category).toBe("indeterminate");
  });

  it("4. 復帰済 causeHint=null・schedule null → indeterminate (null=unknown 扱い)", () => {
    const category = estimateDowntimeCause(row({ causeHint: null, schedule: null }), NOW);
    expect(category).toBe("indeterminate");
  });

  it("5. 復帰済 unknown・wentDownAt が OFF 窓内 (JST20:00/8-18) → scheduled_off", () => {
    const category = estimateDowntimeCause(
      row({ wentDownAt: new Date("2026-06-02T11:00:00.000Z") }),
      NOW,
    );
    expect(category).toBe("scheduled_off");
  });

  it("6. 復帰済 unknown・wentDownAt が ON 窓内 → indeterminate", () => {
    // 既定 row は JST 14:00 (ON)。
    expect(estimateDowntimeCause(row(), NOW)).toBe("indeterminate");
  });

  it("7. 落下 JST17:00(ON)・復帰 JST20:00(OFF) → indeterminate (発生時刻で判定)", () => {
    const category = estimateDowntimeCause(
      row({
        wentDownAt: new Date("2026-06-02T08:00:00.000Z"), // JST 17:00 (ON, 17<18)
        recoveredAt: new Date("2026-06-02T11:00:00.000Z"), // JST 20:00 (OFF)
      }),
      NOW,
    );
    expect(category).toBe("indeterminate");
  });

  it("8. 継続中・now ON・hint null → ongoing_action", () => {
    const category = estimateDowntimeCause(row({ recoveredAt: null, causeHint: null }), NOW);
    expect(category).toBe("ongoing_action");
  });

  it("9. 継続中・now OFF → ongoing_watch", () => {
    const nowOff = new Date("2026-06-02T11:00:00.000Z"); // JST 20:00 (OFF under 8-18)
    const category = estimateDowntimeCause(row({ recoveredAt: null, causeHint: null }), nowOff);
    expect(category).toBe("ongoing_watch");
  });

  it("10. 継続中・schedule null → ongoing_action (null=常時 ON)", () => {
    const category = estimateDowntimeCause(
      row({ recoveredAt: null, causeHint: null, schedule: null }),
      NOW,
    );
    expect(category).toBe("ongoing_action");
  });

  it("11. JST 日跨ぎ: wentDownAt UTC 20:30Z(=JST翌05:30, onHour8前) → scheduled_off", () => {
    const category = estimateDowntimeCause(
      row({ wentDownAt: new Date("2026-06-02T20:30:00.000Z") }), // JST 6/3 05:30
      NOW,
    );
    expect(category).toBe("scheduled_off");
  });

  it("12. 夜間窓 (onHour22/offHour6): JST12:00→scheduled_off / JST23:00→indeterminate", () => {
    const night: TvSchedule = { enabled: true, onHour: 22, offHour: 6 };
    const noon = estimateDowntimeCause(
      row({ schedule: night, wentDownAt: new Date("2026-06-02T03:00:00.000Z") }), // JST 12:00
      NOW,
    );
    const lateNight = estimateDowntimeCause(
      row({ schedule: night, wentDownAt: new Date("2026-06-02T14:00:00.000Z") }), // JST 23:00
      NOW,
    );
    expect(noon).toBe("scheduled_off"); // 昼は表示窓 (22-6) の外 = OFF
    expect(lateNight).toBe("indeterminate"); // 23 時は表示窓内 = ON
  });

  it("13. enabled=false (恒久 OFF) の復帰済 unknown → scheduled_off", () => {
    const category = estimateDowntimeCause(
      row({ schedule: { enabled: false } as TvSchedule }),
      NOW,
    );
    expect(category).toBe("scheduled_off");
  });

  it("14. weekdays に wentDownAt 曜日 (火=2) が無い → scheduled_off", () => {
    const wedOnly: TvSchedule = { enabled: true, onHour: 8, offHour: 18, weekdays: [3] };
    // 既定 row の wentDownAt は JST 火 (=2)。水曜のみ表示 → 当日は表示曜日でない = OFF。
    expect(estimateDowntimeCause(row({ schedule: wedOnly }), NOW)).toBe("scheduled_off");
  });

  it("16. 未知 causeHint='bogus' は schedule/indeterminate に落ちる (クラッシュしない)", () => {
    expect(estimateDowntimeCause(row({ causeHint: "bogus", schedule: null }), NOW)).toBe(
      "indeterminate",
    );
  });

  it("17. causeHint='network' → network (防御的分岐)", () => {
    expect(estimateDowntimeCause(row({ causeHint: "network" }), NOW)).toBe("network");
  });
});

describe("describeDowntimeCause (候補/根拠の shape)", () => {
  it("15. indeterminate は候補ちょうど 3 つ・非 indeterminate は []", () => {
    const indeterminate = describeDowntimeCause("indeterminate");
    expect(indeterminate.candidates).toEqual(["電源OFF", "ネットワーク断", "アプリ停止"]);
    expect(describeDowntimeCause("reboot").candidates).toEqual([]);
    expect(describeDowntimeCause("scheduled_off").candidates).toEqual([]);
  });

  it("全カテゴリにラベルと根拠文がある (空でない)", () => {
    for (const c of [
      "reboot",
      "network",
      "scheduled_off",
      "indeterminate",
      "ongoing_action",
      "ongoing_watch",
    ] as const) {
      const d = describeDowntimeCause(c);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.rationale.length).toBeGreaterThan(0);
    }
  });
});
