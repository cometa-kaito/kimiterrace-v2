import { describe, expect, it } from "vitest";
import {
  DEFAULT_TV_LIVENESS_THRESHOLDS,
  DEFAULT_TV_LONG_SILENCE_SEC,
  type TvLivenessInput,
  classifyLongSilence,
  classifyTvLiveness,
  isSignageOffHours,
} from "../../src/queries/tv-liveness.js";

/**
 * F16 (ADR-023): TV 死活ギャップチェッカの純関数 `classifyTvLiveness` / `isSignageOffHours` の単体検証。
 * I/O 非依存（DB 不要）。閾値超で down 遷移 / 復帰で recover + duration の材料 / 不変で no-op / 冪等性
 * （継続中は再計上しない）/ OFF 時間帯の閾値緩和 / monitoring_enabled / last_seen NULL を固定する。
 *
 * 加えて schedule-agnostic な「長時間サイレンス」検出器 `classifyLongSilence`（運営整理 OFF 盲点修正）の
 * 閾値・dedup 列遷移（新規アラート / クリア / 継続 no-op）・monitoring / last_seen NULL を固定する。
 */

const NOW = new Date("2026-06-02T05:00:00.000Z"); // JST 14:00（平日 = 火曜）
const T = DEFAULT_TV_LIVENESS_THRESHOLDS;

/** テスト用の入力 1 行を作る（既定は「鮮度 OK・監視 ON・ok・未解決行なし・schedule なし・未通知」）。 */
function device(overrides: Partial<TvLivenessInput> = {}): TvLivenessInput {
  return {
    deviceId: "dev-1",
    schoolId: "school-1",
    lastSeenAt: new Date(NOW.getTime() - 30_000), // 30 秒前（鮮度 OK）
    lastBootAt: null,
    alertState: "ok",
    monitoringEnabled: true,
    schedule: null,
    hasOpenDowntime: false,
    longSilenceNotifiedAt: null,
    ...overrides,
  };
}

describe("classifyTvLiveness: down 遷移", () => {
  it("閾値ちょうどでは down にしない（境界: > のみ down）", () => {
    const lastSeenAt = new Date(NOW.getTime() - T.downThresholdSec * 1000); // ぴったり 3 分前
    const { newlyDown, recovered } = classifyTvLiveness([device({ lastSeenAt })], NOW);
    expect(newlyDown).toEqual([]);
    expect(recovered).toEqual([]);
  });

  it("閾値超で down 遷移し went_down_at = last_seen_at を記録する", () => {
    const lastSeenAt = new Date(NOW.getTime() - (T.downThresholdSec + 1) * 1000);
    const { newlyDown, recovered } = classifyTvLiveness([device({ lastSeenAt })], NOW);
    expect(newlyDown).toEqual([
      { deviceId: "dev-1", schoolId: "school-1", wentDownAt: lastSeenAt },
    ]);
    expect(recovered).toEqual([]);
  });

  it("last_seen_at が NULL（未観測）は down にしない", () => {
    const { newlyDown } = classifyTvLiveness([device({ lastSeenAt: null })], NOW);
    expect(newlyDown).toEqual([]);
  });

  it("monitoring_enabled=false の TV は down 計上しない", () => {
    const lastSeenAt = new Date(NOW.getTime() - 10 * 60_000); // 10 分前（通常閾値超）
    const { newlyDown } = classifyTvLiveness(
      [device({ lastSeenAt, monitoringEnabled: false })],
      NOW,
    );
    expect(newlyDown).toEqual([]);
  });
});

describe("classifyTvLiveness: 冪等性 / send-once（継続中は再計上しない）", () => {
  it("既に alert_state=down の継続中は down→down で no-op", () => {
    const lastSeenAt = new Date(NOW.getTime() - 10 * 60_000);
    const { newlyDown, recovered } = classifyTvLiveness(
      [device({ lastSeenAt, alertState: "down" })],
      NOW,
    );
    expect(newlyDown).toEqual([]);
    expect(recovered).toEqual([]);
  });

  it("未解決ダウンタイム行がある継続中も down→down で no-op（alert_state ズレ時も二重計上しない）", () => {
    const lastSeenAt = new Date(NOW.getTime() - 10 * 60_000);
    const { newlyDown, recovered } = classifyTvLiveness(
      [device({ lastSeenAt, alertState: "ok", hasOpenDowntime: true })],
      NOW,
    );
    expect(newlyDown).toEqual([]);
    expect(recovered).toEqual([]);
  });
});

describe("classifyTvLiveness: recover 遷移", () => {
  it("鮮度 OK に戻った down 中の TV は recover（recovered_at=now, cause_hint=unknown）", () => {
    const { newlyDown, recovered } = classifyTvLiveness(
      [device({ alertState: "down" })], // lastSeenAt は 30 秒前 = 鮮度 OK
      NOW,
    );
    expect(newlyDown).toEqual([]);
    expect(recovered).toEqual([
      { deviceId: "dev-1", schoolId: "school-1", recoveredAt: NOW, causeHint: "unknown" },
    ]);
  });

  it("ダウン中に last_boot_at が last_seen_at より後に進んでいれば cause_hint=reboot", () => {
    const lastSeenAt = new Date(NOW.getTime() - 30_000);
    const lastBootAt = new Date(lastSeenAt.getTime() + 5_000); // ダウン起点より後 = 再起動
    const { recovered } = classifyTvLiveness(
      [device({ lastSeenAt, lastBootAt, alertState: "down" })],
      NOW,
    );
    expect(recovered[0].causeHint).toBe("reboot");
  });

  it("last_boot_at が古い（last_seen_at 以前）なら reboot と推定しない（unknown）", () => {
    const lastSeenAt = new Date(NOW.getTime() - 30_000);
    const lastBootAt = new Date(lastSeenAt.getTime() - 5_000);
    const { recovered } = classifyTvLiveness(
      [device({ lastSeenAt, lastBootAt, alertState: "down" })],
      NOW,
    );
    expect(recovered[0].causeHint).toBe("unknown");
  });

  it("monitoring_enabled=false でも鮮度 OK の down 中は recover を許す（メンテ後の自然復帰を妨げない）", () => {
    const { recovered } = classifyTvLiveness(
      [device({ alertState: "down", monitoringEnabled: false })],
      NOW,
    );
    expect(recovered.length).toBe(1);
  });
});

describe("classifyTvLiveness: no-op（不変）", () => {
  it("鮮度 OK かつ ok のままは何も出さない（ok→ok）", () => {
    const { newlyDown, recovered } = classifyTvLiveness([device()], NOW);
    expect(newlyDown).toEqual([]);
    expect(recovered).toEqual([]);
  });

  it("複数 TV を 1 回で分類: down / recover / no-op が混在しても正しく振り分ける", () => {
    const downSeen = new Date(NOW.getTime() - 10 * 60_000);
    const result = classifyTvLiveness(
      [
        device({ deviceId: "down-1", lastSeenAt: downSeen }), // 新規 down
        device({ deviceId: "rec-1", alertState: "down" }), // recover
        device({ deviceId: "ok-1" }), // no-op
        device({ deviceId: "cont-1", lastSeenAt: downSeen, alertState: "down" }), // 継続 → no-op
      ],
      NOW,
    );
    expect(result.newlyDown.map((d) => d.deviceId)).toEqual(["down-1"]);
    expect(result.recovered.map((r) => r.deviceId)).toEqual(["rec-1"]);
  });
});

describe("classifyTvLiveness: OFF 時間帯は死活評価を停止する（BUG-2）", () => {
  // schedule: 8〜18 時表示。NOW(JST 14:00) は ON 時間帯。
  const schedule = { enabled: true, onHour: 8, offHour: 18 };
  const offNow = new Date("2026-06-01T17:00:00.000Z"); // JST 6/2 02:00 = OFF（8〜18 の外）

  it("ON 時間帯は通常閾値（3 分超で down）", () => {
    const lastSeenAt = new Date(NOW.getTime() - 5 * 60_000); // 5 分前
    const { newlyDown } = classifyTvLiveness([device({ lastSeenAt, schedule })], NOW);
    expect(newlyDown.length).toBe(1);
  });

  it("OFF 時間帯は短い途絶（5 分）では down にしない", () => {
    const lastSeenAt = new Date(offNow.getTime() - 5 * 60_000);
    const { newlyDown } = classifyTvLiveness([device({ lastSeenAt, schedule })], offNow);
    expect(newlyDown).toEqual([]);
  });

  it("OFF 時間帯は長時間（31 分超）の無応答でも down にしない（OFF をダウンに数えない）", () => {
    const lastSeenAt = new Date(offNow.getTime() - 31 * 60_000);
    const { newlyDown } = classifyTvLiveness([device({ lastSeenAt, schedule })], offNow);
    expect(newlyDown).toEqual([]);
  });

  it("OFF 中は down/recover を凍結する（鮮度 OK の down 中 TV も締めない）", () => {
    const lastSeenAt = new Date(offNow.getTime() - 30_000); // offNow 基準で 30 秒前（鮮度 OK）
    const { newlyDown, recovered } = classifyTvLiveness(
      [device({ schedule, lastSeenAt, alertState: "down" })],
      offNow,
    );
    expect(newlyDown).toEqual([]);
    expect(recovered).toEqual([]); // OFF 中はスキップ（凍結）→ ON で再評価
  });

  it("OFF→ON: 夜通し無応答だった端末は ON 入り後に down 検出される（自力起動不能の検出）", () => {
    // ON 時間帯 NOW(JST 14:00) に last_seen が前夜から 8 時間途絶 → ON の通常閾値超で down
    const lastSeenAt = new Date(NOW.getTime() - 8 * 60 * 60_000);
    const { newlyDown } = classifyTvLiveness([device({ lastSeenAt, schedule })], NOW);
    expect(newlyDown.length).toBe(1);
  });
});

describe("isSignageOffHours", () => {
  it("schedule なし（NULL）は常時 ON 扱い", () => {
    expect(isSignageOffHours(null, NOW)).toBe(false);
  });

  it("enabled=false は恒久 OFF", () => {
    expect(isSignageOffHours({ enabled: false }, NOW)).toBe(true);
  });

  it("同日内の表示窓（8〜18）: 窓内は ON、窓外は OFF", () => {
    const sched = { enabled: true, onHour: 8, offHour: 18 };
    expect(isSignageOffHours(sched, new Date("2026-06-02T05:00:00Z"))).toBe(false); // JST 14:00 ON
    expect(isSignageOffHours(sched, new Date("2026-06-01T22:00:00Z"))).toBe(true); // JST 07:00 OFF
    expect(isSignageOffHours(sched, new Date("2026-06-02T10:00:00Z"))).toBe(true); // JST 19:00 OFF
  });

  it("日跨ぎの表示窓（22〜6）: 夜間 ON、昼間 OFF", () => {
    const sched = { enabled: true, onHour: 22, offHour: 6 };
    expect(isSignageOffHours(sched, new Date("2026-06-01T14:00:00Z"))).toBe(false); // JST 23:00 ON
    expect(isSignageOffHours(sched, new Date("2026-06-02T05:00:00Z"))).toBe(true); // JST 14:00 OFF
  });

  it("weekdays で当日が非表示曜日なら OFF（NOW=火曜、weekdays=[1,3,5] に火曜=2 含まず）", () => {
    const sched = { enabled: true, onHour: 8, offHour: 18, weekdays: [1, 3, 5] };
    expect(isSignageOffHours(sched, NOW)).toBe(true);
  });

  it("weekdays に当日が含まれかつ窓内なら ON", () => {
    const sched = { enabled: true, onHour: 8, offHour: 18, weekdays: [2, 4] }; // 火曜=2 含む
    expect(isSignageOffHours(sched, NOW)).toBe(false);
  });

  it("分単位の境界（08:30〜17:00）: 08:29 は OFF、08:30 は ON", () => {
    const sched = { enabled: true, onHour: 8, onMinute: 30, offHour: 17, offMinute: 0 };
    // JST 08:29 = UTC 前日 23:29
    expect(isSignageOffHours(sched, new Date("2026-06-01T23:29:00Z"))).toBe(true);
    // JST 08:30 = UTC 前日 23:30
    expect(isSignageOffHours(sched, new Date("2026-06-01T23:30:00Z"))).toBe(false);
  });

  it("複数窓（08:00-12:00, 13:00-17:00）: 昼休み(12:30)は OFF、両窓内は ON", () => {
    const sched = {
      enabled: true,
      windows: [
        { onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 },
        { onHour: 13, onMinute: 0, offHour: 17, offMinute: 0 },
      ],
    };
    expect(isSignageOffHours(sched, new Date("2026-06-02T00:00:00Z"))).toBe(false); // JST 09:00 窓1内
    expect(isSignageOffHours(sched, new Date("2026-06-02T03:30:00Z"))).toBe(true); // JST 12:30 昼休み
    expect(isSignageOffHours(sched, new Date("2026-06-02T06:00:00Z"))).toBe(false); // JST 15:00 窓2内
    expect(isSignageOffHours(sched, new Date("2026-06-02T09:00:00Z"))).toBe(true); // JST 18:00 全窓外
  });

  it("windows は legacy onHour/offHour より優先される", () => {
    const sched = {
      enabled: true,
      onHour: 0,
      offHour: 23, // legacy はほぼ終日 ON だが windows が優先
      windows: [{ onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 }],
    };
    // JST 15:00 (UTC 06:00) は windows(8-12) の外 → OFF
    expect(isSignageOffHours(sched, new Date("2026-06-02T06:00:00Z"))).toBe(true);
  });
});

describe("classifyLongSilence: 閾値（schedule-agnostic）", () => {
  const LS = DEFAULT_TV_LONG_SILENCE_SEC; // 6h = 21600

  it("既定閾値が 6h（21600 秒）であること", () => {
    expect(DEFAULT_TV_LONG_SILENCE_SEC).toBe(21600);
  });

  it("閾値ちょうど（6h）では長時間サイレンスにしない（境界: > のみ）", () => {
    const lastSeenAt = new Date(NOW.getTime() - LS * 1000); // ぴったり 6h 前
    const { newlyLongSilent, cleared } = classifyLongSilence([device({ lastSeenAt })], NOW);
    expect(newlyLongSilent).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("閾値超（6h + 1 秒）で新規アラートし lastSeenAt を起点に記録する", () => {
    const lastSeenAt = new Date(NOW.getTime() - (LS + 1) * 1000);
    const { newlyLongSilent, cleared } = classifyLongSilence([device({ lastSeenAt })], NOW);
    expect(newlyLongSilent).toEqual([{ deviceId: "dev-1", schoolId: "school-1", lastSeenAt }]);
    expect(cleared).toEqual([]);
  });

  it("OFF 時間帯の短い途絶（5 分）は閾値未満で no-op（schedule を見ても見なくても同じ）", () => {
    // schedule を OFF にしても classifyLongSilence は schedule を無視する。5 分 < 6h なので no-op。
    const schedule = { enabled: true, onHour: 8, offHour: 18 };
    const offNow = new Date("2026-06-01T17:00:00.000Z"); // JST 02:00 = OFF
    const lastSeenAt = new Date(offNow.getTime() - 5 * 60_000);
    const { newlyLongSilent } = classifyLongSilence([device({ lastSeenAt, schedule })], offNow);
    expect(newlyLongSilent).toEqual([]);
  });

  it("OFF 時間帯でも 6h 超 無音なら長時間サイレンス（schedule を無視＝OFF 盲点を塞ぐ）", () => {
    // ここが本機能の肝: classifyTvLiveness は OFF をスキップするが、classifyLongSilence は OFF でも検出する。
    const schedule = { enabled: true, onHour: 8, offHour: 18 };
    const offNow = new Date("2026-06-01T17:00:00.000Z"); // JST 02:00 = OFF（夜間 ~03:47 帯の途絶を模す）
    const lastSeenAt = new Date(offNow.getTime() - 7 * 60 * 60_000); // 7h 前から無音
    const { newlyLongSilent } = classifyLongSilence([device({ lastSeenAt, schedule })], offNow);
    expect(newlyLongSilent.map((d) => d.deviceId)).toEqual(["dev-1"]);
  });

  it("enabled=false（恒久 OFF）の端末でも 6h 超 無音なら検出する（schedule を完全に無視）", () => {
    const schedule = { enabled: false };
    const lastSeenAt = new Date(NOW.getTime() - 7 * 60 * 60_000);
    const { newlyLongSilent } = classifyLongSilence([device({ lastSeenAt, schedule })], NOW);
    expect(newlyLongSilent.length).toBe(1);
  });

  it("カスタム閾値（1h）を渡すと 1h 超で検出する", () => {
    const lastSeenAt = new Date(NOW.getTime() - 90 * 60_000); // 1.5h 前
    const { newlyLongSilent } = classifyLongSilence([device({ lastSeenAt })], NOW, 3600);
    expect(newlyLongSilent.length).toBe(1);
  });
});

describe("classifyLongSilence: dedup 列遷移（send-once / クリア）", () => {
  const longAgo = () => new Date(NOW.getTime() - 7 * 60 * 60_000); // 7h 前（閾値超）

  it("dedup 列が NULL かつ閾値超 → 新規アラート（NULL → now() で 1 回だけ）", () => {
    const { newlyLongSilent, cleared } = classifyLongSilence(
      [device({ lastSeenAt: longAgo(), longSilenceNotifiedAt: null })],
      NOW,
    );
    expect(newlyLongSilent.length).toBe(1);
    expect(cleared).toEqual([]);
  });

  it("dedup 列が non-NULL かつ閾値超（継続中） → no-op（send-once、再アラートしない）", () => {
    const { newlyLongSilent, cleared } = classifyLongSilence(
      [device({ lastSeenAt: longAgo(), longSilenceNotifiedAt: new Date(NOW.getTime() - 60_000) })],
      NOW,
    );
    expect(newlyLongSilent).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("dedup 列が non-NULL かつ鮮度復帰（閾値内） → クリア（now() → NULL で再アラート可能に）", () => {
    const { newlyLongSilent, cleared } = classifyLongSilence(
      // lastSeenAt 既定 = 30 秒前（鮮度 OK）。列が立っている = 前回アラート済み。
      [device({ longSilenceNotifiedAt: new Date(NOW.getTime() - 8 * 60 * 60_000) })],
      NOW,
    );
    expect(newlyLongSilent).toEqual([]);
    expect(cleared).toEqual([{ deviceId: "dev-1", schoolId: "school-1" }]);
  });

  it("dedup 列が NULL かつ鮮度 OK（未アラート・正常） → no-op", () => {
    const { newlyLongSilent, cleared } = classifyLongSilence([device()], NOW);
    expect(newlyLongSilent).toEqual([]);
    expect(cleared).toEqual([]);
  });
});

describe("classifyLongSilence: monitoring_enabled / last_seen NULL", () => {
  const longAgo = () => new Date(NOW.getTime() - 7 * 60 * 60_000);

  it("monitoring_enabled=false の閾値超 無音は新規アラートしない", () => {
    const { newlyLongSilent } = classifyLongSilence(
      [device({ lastSeenAt: longAgo(), monitoringEnabled: false })],
      NOW,
    );
    expect(newlyLongSilent).toEqual([]);
  });

  it("monitoring_enabled=false でもアラート中で鮮度復帰すればクリアは許す（列を取り残さない）", () => {
    const { cleared } = classifyLongSilence(
      [
        device({
          monitoringEnabled: false,
          longSilenceNotifiedAt: new Date(NOW.getTime() - 8 * 60 * 60_000),
        }),
      ],
      NOW,
    );
    expect(cleared).toEqual([{ deviceId: "dev-1", schoolId: "school-1" }]);
  });

  it("last_seen_at が NULL（未観測）は新規アラートにもクリアにも数えない", () => {
    // 列が NULL: no-op。
    expect(classifyLongSilence([device({ lastSeenAt: null })], NOW).newlyLongSilent).toEqual([]);
    // 列が non-NULL（万一立っていても）でも鮮度根拠が無いので no-op（クリアしない）。
    const res = classifyLongSilence(
      [device({ lastSeenAt: null, longSilenceNotifiedAt: new Date(NOW.getTime() - 60_000) })],
      NOW,
    );
    expect(res.newlyLongSilent).toEqual([]);
    expect(res.cleared).toEqual([]);
  });
});

describe("classifyLongSilence: 複数 TV を 1 回で分類", () => {
  it("新規アラート / クリア / 継続 / 正常 を正しく振り分ける", () => {
    const longAgo = new Date(NOW.getTime() - 7 * 60 * 60_000);
    const alerted = new Date(NOW.getTime() - 60_000);
    const res = classifyLongSilence(
      [
        device({ deviceId: "new-1", lastSeenAt: longAgo, longSilenceNotifiedAt: null }), // 新規
        device({ deviceId: "clear-1", longSilenceNotifiedAt: alerted }), // 鮮度 OK + 列あり = クリア
        device({ deviceId: "cont-1", lastSeenAt: longAgo, longSilenceNotifiedAt: alerted }), // 継続 = no-op
        device({ deviceId: "ok-1" }), // 正常 = no-op
      ],
      NOW,
    );
    expect(res.newlyLongSilent.map((d) => d.deviceId)).toEqual(["new-1"]);
    expect(res.cleared.map((d) => d.deviceId)).toEqual(["clear-1"]);
  });
});
