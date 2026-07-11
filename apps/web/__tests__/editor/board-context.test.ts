import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * エディタ / 実寸サイネージプレビュー共有の盤面組み立てヘルパ（board-context.ts・#1257）の固定テスト。
 * 固定点: `?date=` の妥当な明示は常に優先・不正値/未指定は cutover 既定対象日／パターンは端末別 `?design` >
 * 学校既定 > pattern1 で解決し実機と同一 builder へ designParam として渡す／schoolId 不明は board=null。
 */

const h = vi.hoisted(() => ({
  getSchoolConfigValue: vi.fn(),
  getClassSignageUrl: vi.fn(),
  buildSignagePayloadForClass: vi.fn(),
}));

vi.mock("@kimiterrace/db", () => ({
  getSchoolConfigValue: h.getSchoolConfigValue,
  getClassSignageUrl: h.getClassSignageUrl,
}));
vi.mock("@/lib/signage/signage-display", () => ({
  buildSignagePayloadForClass: h.buildSignagePayloadForClass,
}));

import { resolveClassBoardForDate, resolveEditorTargetDate } from "@/lib/editor/board-context";
import type { TenantTx } from "@kimiterrace/db";

const TX = {} as TenantTx; // モックしたクエリ関数へ素通しされるだけ（opaque なダミー）。
const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";
// 2026-07-08 (水) 12:00 JST = 03:00 UTC。既定 cutover 16:00 より前＝既定対象日は「今日」。
const NOW = new Date("2026-07-08T03:00:00Z");

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveEditorTargetDate（対象日の解決・エディタ/プレビュー共有）", () => {
  it("妥当な ?date= 明示は常に優先し、display_settings も併せて返す", async () => {
    const settings = { editorDayCutover: "08:00" };
    h.getSchoolConfigValue.mockResolvedValue(settings);
    const out = await resolveEditorTargetDate(TX, "2026-07-20", NOW);
    expect(out.date).toBe("2026-07-20"); // cutover を過ぎていても明示日付が勝つ（deep link 安定）。
    expect(out.displaySettings).toBe(settings);
    expect(h.getSchoolConfigValue).toHaveBeenCalledWith(TX, "display_settings");
  });

  it("未指定は既定対象日ロジック（cutover 前の授業日＝今日）に倒す", async () => {
    h.getSchoolConfigValue.mockResolvedValue(null);
    const out = await resolveEditorTargetDate(TX, undefined, NOW);
    expect(out.date).toBe("2026-07-08");
  });

  it("不正な date 値（形不一致）は無視して既定対象日に倒す（cutover 後は次の授業日）", async () => {
    // cutover 10:00 < now 12:00 JST → 次の授業日（木曜 7/9）。
    h.getSchoolConfigValue.mockResolvedValue({ editorDayCutover: "10:00" });
    for (const bad of ["2026/07/20", "20260720", "", 42, {}]) {
      const out = await resolveEditorTargetDate(TX, bad, NOW);
      expect(out.date).toBe("2026-07-09");
    }
  });
});

describe("resolveClassBoardForDate（実機 URL → パターン解決 → 実機と同一 builder）", () => {
  it("端末別 ?design= が学校既定より優先され、builder へ designParam として渡る", async () => {
    h.getClassSignageUrl.mockResolvedValue("https://tv.example.com/signage/tok?design=pattern3");
    const payload = { designPattern: "pattern3" };
    h.buildSignagePayloadForClass.mockResolvedValue(payload);
    const out = await resolveClassBoardForDate(TX, CLASS_ID, SCHOOL_ID, "2026-07-08", {
      signageDesign: "pattern2",
    });
    expect(out.pattern).toBe("pattern3");
    expect(out.board).toBe(payload);
    expect(out.liveSignageUrl).toBe("https://tv.example.com/signage/tok?design=pattern3");
    expect(h.buildSignagePayloadForClass).toHaveBeenCalledWith(
      TX,
      SCHOOL_ID,
      CLASS_ID,
      "2026-07-08",
      "pattern3",
    );
  });

  it("端末 URL に ?design が無ければ学校レベル既定、どちらも無ければ pattern1 に倒す", async () => {
    h.getClassSignageUrl.mockResolvedValue("https://tv.example.com/signage/tok");
    h.buildSignagePayloadForClass.mockResolvedValue({});
    const school = await resolveClassBoardForDate(TX, CLASS_ID, SCHOOL_ID, "2026-07-08", {
      signageDesign: "pattern2",
    });
    expect(school.pattern).toBe("pattern2");
    // 端末未設置 + 設定なし → pattern1（既定）。liveSignageUrl は undefined のまま返す（死リンク防止）。
    h.getClassSignageUrl.mockResolvedValue(undefined);
    const fallback = await resolveClassBoardForDate(TX, CLASS_ID, SCHOOL_ID, "2026-07-08", null);
    expect(fallback.pattern).toBe("pattern1");
    expect(fallback.liveSignageUrl).toBeUndefined();
  });

  it("schoolId 不明は builder を呼ばず board=null（呼び出し側が 404 / フォールバックを判断）", async () => {
    h.getClassSignageUrl.mockResolvedValue(undefined);
    const out = await resolveClassBoardForDate(TX, CLASS_ID, null, "2026-07-08", null);
    expect(out.board).toBeNull();
    expect(h.buildSignagePayloadForClass).not.toHaveBeenCalled();
  });
});
