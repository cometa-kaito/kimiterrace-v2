"use client";

import { useEffect, useRef, useState } from "react";
import { clampAdDurationMs, clampIndex, nextIndex } from "./rotation";

/**
 * 広告ローテーションの index 管理フック（client）。現在広告の `durationSec`（秒）ごとに次の広告へ循環し、
 * 件数変動時は index を有効範囲へ丸めた **`safeIndex`** を返す。再生制御の純ロジック（{@link nextIndex} /
 * {@link clampIndex} / {@link clampAdDurationMs}）に `setTimeout` + state を被せた glue を **単一ソース化**し、
 * 実機サイネージ（`SignageClient`）とエディタの WYSIWYG プレビュー（`ScaledSignageBoard` 経由）で共有する。
 *
 * - 広告 0 / 1 件のときは回さず常に 0 を返す（タイマーも張らない）。
 * - テレメトリ（view / tap impression）・ポーリングは**持たない**（呼び出し側の責務）。エディタプレビューは
 *   インプレッションを計上しないので、回転 index だけを担う本フックがちょうど必要十分。
 *
 * @param ads 現在の広告リスト（`durationSec` と件数だけ参照）。poll 等で件数が変わっても安全に丸める。
 * @returns いま表示すべき広告の index（`0 <= safeIndex < ads.length`、空なら 0）。
 */
export function useAdRotation(ads: readonly { durationSec: number }[]): number {
  const adCount = ads.length;
  const [adIndex, setAdIndex] = useState(0);
  const safeIndex = clampIndex(adIndex, adCount);
  // 最新の ads を ref で読む（duration 取得用）。effect の dep を [safeIndex, adCount] に保ち、ads の配列
  // 参照が毎レンダー変わっても無駄に再購読しない（SignageClient の従来実装と同作法）。
  const adsRef = useRef(ads);
  adsRef.current = ads;
  useEffect(() => {
    if (adCount <= 1) {
      return;
    }
    const ms = clampAdDurationMs(adsRef.current[safeIndex]?.durationSec ?? 0);
    const id = setTimeout(() => setAdIndex((i) => nextIndex(i, adCount)), ms);
    return () => clearTimeout(id);
  }, [safeIndex, adCount]);
  return safeIndex;
}
