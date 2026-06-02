import type { SensorHealthStatus } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import { maskDeviceMac, presentSensorStatus } from "../../lib/sensors/status-presentation";

/**
 * F13 (#391, ADR-020): センサー稼働ヘルス状態の表示プレゼンテーション純粋関数の検証。
 *
 * 判定ロジック自体は DB 側 (`listSensorDeviceStatuses`) にあるため、ここでは「状態値 →
 * 表示メタ」の写像と device_mac マスクのみを node 環境で網羅検証する (副作用なし)。
 */

const ALL_STATUSES: SensorHealthStatus[] = ["healthy", "quiet", "dead", "never"];

describe("presentSensorStatus", () => {
  it("全状態が非空のテキストラベルを持つ (NFR05: 色のみに依存しない)", () => {
    for (const status of ALL_STATUSES) {
      const p = presentSensorStatus(status);
      expect(p.label.length).toBeGreaterThan(0);
      // 記号も付くが、ラベルが一次情報。色は補助。
      expect(p.symbol.length).toBeGreaterThan(0);
      expect(p.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.background).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("状態ごとにラベルが一意 (取り違え防止)", () => {
    const labels = ALL_STATUSES.map((s) => presentSensorStatus(s).label);
    expect(new Set(labels).size).toBe(ALL_STATUSES.length);
  });

  it("healthy=稼働中 / quiet=静観 / dead=応答なし / never=未検知", () => {
    expect(presentSensorStatus("healthy").label).toBe("稼働中");
    expect(presentSensorStatus("quiet").label).toBe("静観");
    expect(presentSensorStatus("dead").label).toBe("応答なし");
    expect(presentSensorStatus("never").label).toBe("未検知");
  });

  it("未知値は never 相当に倒す (UI を壊さない、防御的)", () => {
    // 型的には到達しないが、DB enum 拡張等の不整合に対する防御。
    const p = presentSensorStatus("bogus" as SensorHealthStatus);
    expect(p.label).toBe(presentSensorStatus("never").label);
  });
});

describe("maskDeviceMac", () => {
  it("末尾 4 hex 桁のみ平文で示し前方を伏せる (F13 §4 擬似識別子)", () => {
    expect(maskDeviceMac("AA:BB:CC:DD:EE:01")).toBe("…EE:01");
  });

  it("区切り表記ゆれ (ハイフン / 無し / 小文字) を吸収して同じ末尾を返す", () => {
    expect(maskDeviceMac("aa-bb-cc-dd-ee-01")).toBe("…EE:01");
    expect(maskDeviceMac("AABBCCDDEE01")).toBe("…EE:01");
    expect(maskDeviceMac("aabbccddee01")).toBe("…EE:01");
  });

  it("フル MAC を平文で漏らさない (末尾 4 桁以外は出さない)", () => {
    const masked = maskDeviceMac("AA:BB:CC:DD:EE:01");
    expect(masked).not.toContain("AA");
    expect(masked).not.toContain("BB");
    expect(masked.startsWith("…")).toBe(true);
  });

  it("4 文字以下の異常入力はそのまま返す (情報を捏造しない)", () => {
    expect(maskDeviceMac("01")).toBe("01");
    expect(maskDeviceMac("ABCD")).toBe("ABCD");
  });
});
