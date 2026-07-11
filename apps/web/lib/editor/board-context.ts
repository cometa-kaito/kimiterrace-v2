import { parseEditorDayCutover, resolveDefaultEditorDate } from "@/lib/editor/default-date";
import { isValidDate } from "@/lib/editor/schedule-core";
import {
  type SignageDesignPattern,
  parseSignageDesignPattern,
  resolveDesignPattern,
} from "@/lib/signage/design-pattern";
import { type SignagePayload, buildSignagePayloadForClass } from "@/lib/signage/signage-display";
import { type TenantTx, getClassSignageUrl, getSchoolConfigValue } from "@kimiterrace/db";

/**
 * クラスエディタ（`/app/editor/[classId]`）とその実寸サイネージプレビュー（`…/preview`・#1257）が**共有する**
 * 対象日・盤面データの組み立てヘルパ（単一ソース）。エディタ page.tsx にあった「`?date=` パース → 既定対象日
 * （cutover）解決」と「実機 URL → 端末別デザインパターン解決 → 実機と同一 payload builder で盤面基底取得」を
 * 抽出し、プレビューが**同じ経路**で同じ盤面を組めるようにする（合成・パターン解決の二重実装禁止）。
 * どちらも呼び出し側の RLS テナント文脈確立済み `tx`（`withSession`）内で動く（ルール2）。
 */

/**
 * `?date=` 生パラメータから編集/プレビューの対象日を決める。妥当な `YYYY-MM-DD` の明示は常に優先
 * （deep link 安定）。無指定・不正値は school_configs の cutover（下校時刻・既定 16:00）から
 * {@link resolveDefaultEditorDate} で決める（エディタの既定対象日ロジックと同一）。読み出した
 * `displaySettings` は後段（デザインパターン解決）でも使うので併せて返し、二重読みを避ける。
 */
export async function resolveEditorTargetDate(
  tx: TenantTx,
  rawDateParam: unknown,
  now: Date,
): Promise<{ date: string; displaySettings: unknown }> {
  const displaySettings = await getSchoolConfigValue(tx, "display_settings");
  const requested = isValidDate(rawDateParam) ? rawDateParam : null;
  const date = requested ?? resolveDefaultEditorDate(now, parseEditorDayCutover(displaySettings));
  return { date, displaySettings };
}

/** {@link resolveClassBoardForDate} の結果（実機 URL・実効パターン・実機と同一の盤面 payload）。 */
export type ClassBoardForDate = {
  /** 実機サイネージ URL（`tv_devices.signage_url`・最初の端末）。未設置クラスは undefined（死リンク防止）。 */
  liveSignageUrl: string | undefined;
  /** 実効デザインパターン（**端末別 `?design` > 学校レベル既定 > pattern1**・実機 TV と同じ優先順位）。 */
  pattern: SignageDesignPattern;
  /** 実機と同一の builder が組んだ盤面。クラス不可視・schoolId 不明は null（呼び出し側が 404 等を判断）。 */
  board: SignagePayload | null;
};

/**
 * 指定クラス・対象日の「実機が実際に出す盤面」をエディタと同じ経路で解決する: `getClassSignageUrl`（RLS
 * 自校限定）→ {@link resolveDesignPattern} 単一ソースでパターン解決（複数モニタのクラスは最初の端末＝
 * エディタと同じ結果）→ 実機と同一の {@link buildSignagePayloadForClass}（`pattern` を designParam に渡す
 * ので builder 内の二重パターン解決は起きない）。`displaySettings` は {@link resolveEditorTargetDate} が
 * 読んだ値をそのまま渡す（opaque JSONB・パースは parse 側が defensive に担う）。
 */
export async function resolveClassBoardForDate(
  tx: TenantTx,
  classId: string,
  schoolId: string | null | undefined,
  date: string,
  displaySettings: unknown,
): Promise<ClassBoardForDate> {
  const liveSignageUrl = await getClassSignageUrl(tx, classId);
  const pattern = resolveDesignPattern(liveSignageUrl, parseSignageDesignPattern(displaySettings));
  const board = schoolId
    ? await buildSignagePayloadForClass(tx, schoolId, classId, date, pattern)
    : null;
  return { liveSignageUrl, pattern, board };
}
