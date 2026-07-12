/**
 * 年間行事ファイル取込（ADR-049）の **(summary, startDate) 合成キー**の正本。drizzle / postgres 非依存の
 * 純関数のみを置く（`@kimiterrace/db/tv-schedule` と同じ「client からはサブパスで読む」流儀。メインバレル
 * `@kimiterrace/db` を "use client" から import すると postgres/drizzle が client bundle に入り
 * next build が落ちる・#1269）。
 *
 * 単一ソース化の対象（2026-07-12 マージ保存の追加でキーが「表示」から「保存の一致判定」に昇格）:
 *   - apps/web `diffCalendarImportReplace`（保存確認ダイアログの差分計算・#1278）
 *   - packages/db `mergeFileImportedEvents`（マージ保存のキー一致判定）
 * 両者が別実装のキーを持つと「ダイアログで更新と出た行が保存では追加される」ズレが起きるため、
 * ここ 1 箇所に固定する。
 */

/** {@link fileImportEventDiffKey} が受ける最小形（DB 行 / プレビュー行 / 保存入力の共通部分）。 */
export interface FileImportEventKeySource {
  /** 行事名。DB 行は nullable、保存入力は optional のためどちらも受ける（null/undefined は空文字扱い）。 */
  summary?: string | null;
  /** 開始日（JST 暦日 'YYYY-MM-DD'）。 */
  startDate: string;
}

/**
 * (trim(summary), startDate) の合成キー。summary は保存時に Zod で trim される（calendarImportEventSchema）
 * が、過去データ側の揺れに備え両側で防御的に trim する（SQL 側で正規化せず TS 側で既存行を fetch して
 * キー計算する方式とセット）。区切りの U+0000 は summary に実質現れない（sanitizeImportedEvents の
 * dedupe キーと同作法）。
 */
export function fileImportEventDiffKey(ev: FileImportEventKeySource): string {
  return `${ev.startDate}\u0000${(ev.summary ?? "").trim()}`;
}
