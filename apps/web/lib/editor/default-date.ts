import { isValidDate } from "@/lib/editor/schedule-core";
import { addDaysUtc } from "@/lib/editor/week-math";
import { jstDateString } from "@/lib/signage/rotation";

/**
 * エディタの**既定対象日**の決定（単一スタック化・editor-restructure-bulletin-2026-07.md §3.2）。
 *
 * 実運用は「前日夕方・休日に**次の授業日**を仕込む」なので、`?date=` 無指定でエディタを開いたときの
 * 既定選択を「授業日の下校時刻（cutover・既定 16:00）まで＝今日、それ以降と休日＝次の授業日」にする。
 * `?date=` が明示されていれば常にそれが勝つ（deep link 安定・本モジュールは初期値のみを決める）。
 *
 * **授業日判定は v1 では「土日スキップ」のみ**（祝日非考慮）。盤面の「次の N 平日」
 * （`signageScheduleDates`）・前日コピーの `previousBusinessDay`（rotation.ts）と同一制約で一貫させる。
 * 祝日・休校日（school_calendar_events / ADR-045）は将来拡張（設計書 §9）。
 *
 * 切替時刻は school_configs（kind='display_settings'・scope='school'）の `value.editorDayCutover`
 * （"HH:MM" 文字列・opaque JSONB なので migration 不要）。パースは `parseSignageDesignPattern` と同じ
 * defensive 作法で、形不正・欠落は既定 {@link DEFAULT_EDITOR_DAY_CUTOVER} に fail-soft する。
 */

/** 切替時刻（下校時刻）の既定値。school_configs 未設定・形不正はこれに倒す（fail-soft）。 */
export const DEFAULT_EDITOR_DAY_CUTOVER = "16:00";

/** "HH:MM"（00:00〜23:59・ゼロ詰め）の形式検証。 */
const CUTOVER_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `display_settings` config の `value`（JSONB, opaque）から `editorDayCutover` を **defensive に**取り出す。
 * 形が想定外・キー欠落・"HH:MM" 不一致はいずれも既定 "16:00" に倒す（fail-soft・エディタを壊さない）。
 */
export function parseEditorDayCutover(configValue: unknown): string {
  if (configValue && typeof configValue === "object" && !Array.isArray(configValue)) {
    const v = (configValue as Record<string, unknown>).editorDayCutover;
    if (typeof v === "string" && CUTOVER_RE.test(v)) {
      return v;
    }
  }
  return DEFAULT_EDITOR_DAY_CUTOVER;
}

/** `YYYY-MM-DD` が授業日（v1 = 平日・土日スキップのみ。祝日非考慮）かどうか。不正な日付は false。 */
export function isSchoolDay(date: string): boolean {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return false;
  }
  const [y, m, d] = parts.map(Number);
  const base = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  // 実在暦日でなければ false（rotation.ts と同じ round-trip 検証）。
  if (
    !(
      base.getUTCFullYear() === y &&
      base.getUTCMonth() === (m as number) - 1 &&
      base.getUTCDate() === d
    )
  ) {
    return false;
  }
  const dow = base.getUTCDay(); // 0=日, 6=土
  return dow !== 0 && dow !== 6;
}

/**
 * `fromDate` の**次の授業日**（翌日以降の直近の平日・土日スキップ）。`previousBusinessDay`
 * （rotation.ts）の**前向き版**で、同じ「土日スキップ・UTC 暦日演算」の制約を共有する。
 * 不正な日付文字列は `null`（呼び出し側で fail-soft）。
 */
export function nextSchoolDay(fromDate: string): string | null {
  let cursor = addDaysUtc(fromDate, 1);
  if (!cursor) {
    return null;
  }
  // 最長でも 土→月 の 2 スキップ。暴走防止に上限を置く（rotation.ts と同作法）。
  for (let i = 0; i < 7; i++) {
    if (isSchoolDay(cursor)) {
      return cursor;
    }
    cursor = addDaysUtc(cursor, 1);
  }
  return null;
}

/** `now` の JST 時刻を「0 時からの分」で返す（cutover 比較用・端末 TZ 非依存）。 */
function jstMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** "HH:MM" → 0 時からの分。検証済み前提（{@link parseEditorDayCutover} を通した値を渡す）。 */
function cutoverMinutes(cutover: string): number {
  const [h, m] = cutover.split(":").map(Number);
  return (h ?? 16) * 60 + (m ?? 0);
}

/**
 * エディタの既定対象日（§3.2 の単一ソース・純関数）。
 * 授業日の cutover（下校時刻）**前**なら今日、それ以降と休日は**次の授業日**。
 */
export function resolveDefaultEditorDate(now: Date, cutover: string): string {
  const today = jstDateString(now);
  if (isSchoolDay(today) && jstMinutes(now) < cutoverMinutes(cutover)) {
    return today;
  }
  // 次の授業日が計算不能（あり得ないが fail-soft）なら今日に倒す。
  return nextSchoolDay(today) ?? today;
}

/**
 * 対象日セグメントの日付列（時系列順・§3.1）。**今日を常に先頭**に出し（授業日でなくても「今日の盤面に
 * 何が映っているか」の確認用途を殺さない）、続けて翌授業日から `count` 個の授業日を並べる。
 * 不正な `today` は単独配列で fail-soft。
 */
export function editorDateSegments(today: string, count = 3): string[] {
  const out = [today];
  let cursor: string | null = today;
  for (let i = 0; i < count; i++) {
    cursor = nextSchoolDay(cursor);
    if (!cursor) {
      break;
    }
    out.push(cursor);
  }
  return out;
}

/**
 * 旧 `?plan=X` URL の後方互換リダイレクト先（§3.3）。単一スタック化で `?plan` は廃止し `?date=` に
 * 一本化したが、ブックマーク・履歴・進行中タブを壊さないため `?date=X` へ redirect する。
 * `plan` が日付として不正なら `null`（リダイレクトせず既定挙動へ fail-soft）。
 */
export function planRedirectPath(classId: string, planParam: unknown): string | null {
  if (!isValidDate(planParam)) {
    return null;
  }
  return `/app/editor/${classId}?date=${planParam}`;
}
