import { type TenantTx, getClassSignageUrls } from "@kimiterrace/db";
import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";

/**
 * エディタ着地「実画面モニタの壁」(`/app/editor`) が使う、**実機モニタ紐づけ + 端末別デザインパターン**の
 * まとめ取得（server 専用・RLS 自校限定）。
 *
 * 壁の 2 つの改善を **1 ソース**で駆動する keystone:
 *  1. **学科に実機モニタが紐づくか**: `signageUrlByClass` のキーに当該学科配下のクラスが 1 つでも含まれるか。
 *     紐づくモニタが無い学科は壁から丸ごと隠す（ユーザー指示 2026-06-18）。
 *  2. **端末別デザインパターン**: 各クラスの代表 `signage_url` の `?design=patternN` を
 *     {@link resolveDesignPattern} で解決し、各モニタサムネ / クラスエディタのプレビューを**実機と同じパターン**で
 *     描く（学校レベル既定→`pattern1` に fail-soft）。
 *
 * `@kimiterrace/db`（postgres barrel）と `signage-design`（DB 読み取り）への依存を**本モジュールに閉じ込める**
 * ことで、壁ページ（Server Component）は本ラッパだけを import すれば良く、apps/web の vitest では本モジュールを
 * mock するだけで DB 解決を避けられる（hub-queries / other-classes-queries / signage-display と同じ作法）。
 */
export type ClassMonitorInfo = {
  /**
   * クラス → 代表 `signage_url`（`signage_url` 非 null・未削除のうち最新更新の 1 件）。**キーに含まれる＝実機
   * モニタ紐づけあり**。設置 TV が無いクラスはキーに現れない。
   */
  signageUrlByClass: Map<string, string>;
  /** 学校レベル既定パターン（端末別 `?design` 未指定時のフォールバック。未設定なら `pattern1`）。 */
  schoolDefaultPattern: SignageDesignPattern;
};

/**
 * 自校の「クラス→代表サイネージ URL」と「学校レベル既定パターン」を **同一 RLS tx 内**で取得する。
 * いずれも自校に RLS スコープされる（ルール2）。`withSession` の自校コンテキスト tx 内で呼ぶこと。
 */
export async function getClassMonitorInfo(tx: TenantTx): Promise<ClassMonitorInfo> {
  const [signageUrlByClass, schoolDefaultPattern] = await Promise.all([
    getClassSignageUrls(tx),
    getSignageDesignPattern(tx),
  ]);
  return { signageUrlByClass, schoolDefaultPattern };
}
