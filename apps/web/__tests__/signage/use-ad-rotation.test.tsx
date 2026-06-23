import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAdRotation } from "@/lib/signage/useAdRotation";

/**
 * 広告ローテーション index の共有フック {@link useAdRotation} の挙動を固定する。実機サイネージ
 * （`SignageClient`）とエディタの WYSIWYG プレビュー（`ScaledSignageBoard` 経由）が同じ回転 glue を共有する
 * （単一ソース）。純ロジック（nextIndex/clampIndex/clampAdDurationMs）は signage-rotation.test が担保するので、
 * ここでは setTimeout + state の glue（duration ごとの巡回・0/1 件で止まる・件数変動の丸め）を固定する。
 */

/** durationSec だけ持つ最小広告（フックは件数と durationSec しか参照しない）。 */
const ad = (durationSec: number) => ({ durationSec });

describe("useAdRotation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("複数広告は各 durationSec ごとに次の index へ循環する", () => {
    const ads = [ad(5), ad(5), ad(5)]; // 各 5 秒
    const { result } = renderHook(() => useAdRotation(ads));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(0); // 末尾の次は先頭へ循環
  });

  it("広告 1 件は回さず常に 0（タイマーを張らない）", () => {
    const { result } = renderHook(() => useAdRotation([ad(5)]));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(0);
  });

  it("広告 0 件は 0（空でも落ちない）", () => {
    const { result } = renderHook(() => useAdRotation([]));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(0);
  });

  it("durationSec が不正（0）でも既定 10 秒で進む（一瞬切替・固着を防ぐ）", () => {
    const ads = [ad(0), ad(0)];
    const { result } = renderHook(() => useAdRotation(ads));
    act(() => vi.advanceTimersByTime(9_999));
    expect(result.current).toBe(0); // 既定 10s 未満では進まない
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(1);
  });

  it("件数が減って現在 index が範囲外になっても丸めて落ちない", () => {
    const three = [ad(5), ad(5), ad(5)];
    const { result, rerender } = renderHook(({ ads }) => useAdRotation(ads), {
      initialProps: { ads: three },
    });
    act(() => vi.advanceTimersByTime(5000)); // → index 1
    act(() => vi.advanceTimersByTime(5000)); // → index 2
    expect(result.current).toBe(2);
    // 1 件に減ると安全に 0 へ丸める（範囲外を指さない）。
    rerender({ ads: [ad(5)] });
    expect(result.current).toBe(0);
  });
});
