import { describe, expect, it } from "vitest";
import { parseBlackout } from "@/lib/signage/blackout";

/**
 * サイネージ黒画面フラグ（per-class・`school_configs` の class スコープ `display_settings.value.blackout`）の
 * defensive 解決の単体テスト（DB 非依存の純ロジック）。`true` のときだけ true、それ以外（キー欠落・非
 * boolean・null・配列・非オブジェクト・行なし）はすべて既定 false（黒画面しない＝盤面を出す・fail-soft）に
 * 倒すことを固定する。読み取り経路（`getClassSignageBlackout`）と書き込み経路（`setClassSignageBlackoutAction`
 * の before スナップショット）が同じこの解決を共有する。
 */
describe("parseBlackout（class display_settings の defensive 解決）", () => {
  it("value.blackout === true のときだけ true", () => {
    expect(parseBlackout({ blackout: true })).toBe(true);
  });

  it("value.blackout === false は false", () => {
    expect(parseBlackout({ blackout: false })).toBe(false);
  });

  it("キー欠落・空オブジェクトは既定 false", () => {
    expect(parseBlackout({})).toBe(false);
    expect(parseBlackout({ signageDesign: "pattern2" })).toBe(false);
  });

  it("非 boolean（truthy 値含む）は false（厳密一致のみ true）", () => {
    expect(parseBlackout({ blackout: "true" })).toBe(false);
    expect(parseBlackout({ blackout: 1 })).toBe(false);
    expect(parseBlackout({ blackout: null })).toBe(false);
    expect(parseBlackout({ blackout: undefined })).toBe(false);
  });

  it("null / 非オブジェクト / 配列（行なし・想定外の形）は既定 false", () => {
    expect(parseBlackout(null)).toBe(false);
    expect(parseBlackout(undefined)).toBe(false);
    expect(parseBlackout("blackout")).toBe(false);
    expect(parseBlackout(123)).toBe(false);
    expect(parseBlackout(true)).toBe(false);
    expect(parseBlackout([{ blackout: true }])).toBe(false);
  });
});
