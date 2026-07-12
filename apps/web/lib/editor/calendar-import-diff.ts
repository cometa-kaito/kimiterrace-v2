/**
 * 年間行事予定表「置き換え保存」の**差分計算**純ロジック（教員 FB 対応・#1259 起点）。
 *
 * 置き換え保存の意味論は不変（`file:` 名前空間の完全書き換え・replaceFileImportedEvents）。弱点は
 * 「部分ファイルを取り込むと既存行事が気づかず消える」ことなので、保存確認ダイアログで
 * **何が追加され・何が削除されるか**（特に削除される行事の一覧）を保存前に見せるための計算を担う。
 * 表示専用であり、保存ロジック・保存ペイロードには一切関与しない。
 *
 * client（CalendarImportClient の確認ダイアログ）から import されるため **@kimiterrace/db の
 * メインバレルを import しない**（"use client" から db 値 import に到達すると next build が落ちる・#1269）。
 * キー関数のみ drizzle 非依存サブパス `@kimiterrace/db/calendar-import-key` から読む（tv-schedule と同じ
 * 流儀。マージ保存 `mergeFileImportedEvents` と同一キーの単一ソース化）。DB / React 非依存で全て
 * 単体テスト可能（calendar-import-view と同方針）。
 */

import { fileImportEventDiffKey } from "@kimiterrace/db/calendar-import-key";

/**
 * 差分キーの元になる最小形。summary は DB 由来（nullable カラム）と プレビュー行（string）の両方を
 * 受けられるよう `string | null` を許す。
 */
export interface CalendarImportDiffKeySource {
  summary: string | null;
  startDate: string;
}

/**
 * 既存のファイル取込由来イベントの plain 形（page.tsx が DB 行から導出して client へ渡す。
 * 差分計算の existing 側 + 削除一覧の表示（eventDateRangeLabel）に足る最小フィールド）。
 */
export interface FileImportedEventSummary extends CalendarImportDiffKeySource {
  /** YYYY-MM-DD（単日は null）。 */
  endDate: string | null;
  location: string | null;
}

/**
 * 置き換え保存の差分（確認ダイアログの表示用・監査可能な形）。
 * マージ保存（2026-07-12 追補）でも同じ計算を使い、表示だけ読み替える:
 * added = 追加 / kept = キー一致（マージでは**更新**される）/ removed = 既存のみ（マージでは
 * 削除されず**そのまま残る**）。`mergeFileImportedEvents` と同一キーなので読み替えは正確。
 */
export interface CalendarImportReplaceDiff<TExisting, TNext> {
  /** 今回のプレビューにのみある行事（保存で新規追加される）。 */
  added: TNext[];
  /** キーが既存と一致するプレビュー行の数（置換: 実質同じ行事が残る / マージ: 更新される）。 */
  kept: number;
  /** 既存（前回のファイル取込）にのみある行事（置換: **保存すると消える**・ダイアログで一覧表示する / マージ: そのまま残る）。 */
  removed: TExisting[];
}

/**
 * 既存のファイル取込由来イベントと、これから保存するプレビュー行の差分を計算する。
 *
 * - マッチキーは **(summary, startDate)**（sanitize / 保存前再検証の dedupe と同じ境界。summary は
 *   保存時に Zod で trim されるため、キー側でも trim して比較する）。endDate / location の違いは
 *   「変更」として扱わず、キー一致 = 継続とみなす（シンプルさ優先・置き換え意味論では同じ結果）。
 * - キー一致 = kept（継続）、プレビューのみ = added、既存のみ = **removed**（削除される行事）。
 * - 配列の順序は入力順を保つ（呼び出し側が表示順を決める）。
 * - プレビュー側にキー重複がある場合（保存前再検証でエラーになる状態）は、重複行もそれぞれ
 *   added / kept に数える（added + kept = next.length を常に満たす。確認時点の概算表示なので許容）。
 *
 * @param existing 既存のファイル取込由来イベント（今年度窓の読みなので過年度分は含まない**概算**。
 *                 置き換え削除自体は `file:` 名前空間全体に及ぶ点は呼び出し側 UI が文言で補う）。
 * @param next     保存しようとしているプレビュー行。
 */
export function diffCalendarImportReplace<
  TExisting extends CalendarImportDiffKeySource,
  TNext extends CalendarImportDiffKeySource,
>(
  existing: readonly TExisting[],
  next: readonly TNext[],
): CalendarImportReplaceDiff<TExisting, TNext> {
  const existingKeys = new Set(existing.map(fileImportEventDiffKey));
  const nextKeys = new Set(next.map(fileImportEventDiffKey));
  const added: TNext[] = [];
  let kept = 0;
  for (const ev of next) {
    if (existingKeys.has(fileImportEventDiffKey(ev))) {
      kept += 1;
    } else {
      added.push(ev);
    }
  }
  const removed = existing.filter((ev) => !nextKeys.has(fileImportEventDiffKey(ev)));
  return { added, kept, removed };
}
