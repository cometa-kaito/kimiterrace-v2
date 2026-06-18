import { type InferSelectModel, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SnippetCategory } from "../_shared/enums.js";
import { signageSnippets } from "../schema/signage-snippets.js";

/**
 * サイネージ静的コンテンツ（名言/四字熟語/英単語/今日は何の日）の query 層。
 *
 * weather_warnings / heat_alerts と同じ「読みは RLS 委譲（公開型 read_all）」だが、**取得 Job は無い**
 * （外部 API ゼロ・固定費ゼロ）。seed 済みの静的データを **日付決定論ローテ**でサイネージ側が読むだけ。
 *
 * 設計の核（Reviewer 重点）:
 *   1. **決定論ローテは純関数 `selectSnippetForDate` に切り出す**。同じ日付・同じ items なら必ず同じ 1 件を返す
 *      → 複数サイネージ端末・複数リクエスト間で表示が一致する（端末ごとにバラけない）。DB I/O 非依存ゆえ
 *      ユニットテストで網羅できる。
 *   2. `getSignageSnippets` は active 行を読み（RLS 委譲、`signage_snippets_read_all` USING(true) で匿名でも可）、
 *      カテゴリごとに純関数で 1 件を選んで返す。手書きの `WHERE school_id=?` は無い（school_id 非保持の公開型）。
 *
 * 型は schema の `signageSnippets` から派生する（ルール3、手書きドメイン型を作らない）。
 */

/** SELECT だけできれば良い接続（db / tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type SignageSnippetRow = InferSelectModel<typeof signageSnippets>;

/** サイネージ表示で参照する静的コンテンツ 1 行（schema 由来、全フィールド）。 */
export type SignageSnippet = SignageSnippetRow;

/**
 * カテゴリごとに 1 件ずつ選んだ「本日のサイネージ静的コンテンツ」。該当が無いカテゴリは null（fail-soft）。
 * 表示側（apps/web、別 PR）はこの形をそのまま受けて盤面に流す。
 */
export interface DailySnippets {
  /** 名言（本文＋出典）。ローテ選択。 */
  quote: SignageSnippet | null;
  /** 四字熟語（語＋読み＋意味）。ローテ選択。 */
  idiom: SignageSnippet | null;
  /** 英単語（語＋発音＋和訳）。ローテ選択。 */
  word: SignageSnippet | null;
  /** 今日は何の日（記念日）。month_day が当日 'MM-DD' に一致する行から決定論選択。無ければ null。 */
  onThisDay: SignageSnippet | null;
}

/** 'MM-DD' に整形する（month は 1-12、day は 1-31）。決定論ローテ・on_this_day 照合のキー生成に使う。 */
function toMonthDay(month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${mm}-${dd}`;
}

/**
 * 1-origin の通日（day-of-year）を **タイムゾーン非依存**で求める純関数。
 *
 * `date` の **UTC 暦日**（getUTCMonth / getUTCDate）から計算する。これにより、ランナーのローカル TZ に
 * よらず同じ Date 入力に対し同じ結果を返す（テストの再現性）。呼び出し側（`getSignageSnippets`）は
 * 「JST の今日の暦日を表す Date（= UTC 正午の Date など暦日が安定するもの）」を渡す契約とする。
 * うるう年も自然に扱える（2/29 が存在する年は 366 日になる）。
 */
export function dayOfYearUTC(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((today - startOfYear) / msPerDay) + 1; // 1/1 = 1
}

/**
 * 指定カテゴリの「本日表示すべき 1 件」を **決定論的に**選ぶ純関数。
 *
 * - `quote` / `idiom` / `word`（ローテ系）: その日の通日（day-of-year）を **該当カテゴリの件数で剰余**して
 *   選ぶ（`items[dayOfYear % count]`）。同じ日付・同じ items なら必ず同じ 1 件 = 端末間・リクエスト間で一致。
 * - `on_this_day`: `monthDay` が当日 'MM-DD' に一致する行に絞り、その中から（複数あれば）通日剰余で 1 件選ぶ。
 *   一致が無ければ `null`（記念日が無い日は非表示、fail-soft）。
 * - 空配列・該当 0 件は `null`（fail-soft、盤面はそのブロックを出さないだけ）。
 *
 * @param items    候補行（呼び出し側で active のみに絞った、カテゴリ混在でも可。本関数が category で選別する）。
 * @param date     基準日（JST の今日の暦日を表す Date）。
 * @param category 選ぶカテゴリ。
 * @returns        選ばれた 1 行、または該当無しの null。
 */
export function selectSnippetForDate(
  items: readonly SignageSnippet[],
  date: Date,
  category: SnippetCategory,
): SignageSnippet | null {
  const doy = dayOfYearUTC(date);

  if (category === "on_this_day") {
    const md = toMonthDay(date.getUTCMonth() + 1, date.getUTCDate());
    // 当日 'MM-DD' に一致する行のみ。決定論のため安定キー（id 昇順）でソートしてから剰余選択。
    const matches = items
      .filter((s) => s.category === "on_this_day" && s.monthDay === md)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (matches.length === 0) return null;
    return matches[doy % matches.length] ?? null;
  }

  // ローテ系（quote/idiom/word）。決定論のため安定キー（id 昇順）でソートしてから通日剰余で選ぶ。
  const pool = items
    .filter((s) => s.category === category)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (pool.length === 0) return null;
  return pool[doy % pool.length] ?? null;
}

/**
 * 本日のサイネージ静的コンテンツを **カテゴリごとに 1 件ずつ** 返す。
 *
 * active な行を 1 回の SELECT で読み（RLS 委譲、`signage_snippets_read_all` USING(true) で匿名サイネージ
 * コンテキストでも読める）、純関数 `selectSnippetForDate` で各カテゴリの本日分を決定論的に選ぶ。
 * 取得 Job は無い（外部依存ゼロ）。表示結線は apps/web の別 PR。
 *
 * @param db   SELECT 可能な接続 / tx（匿名サイネージは role / school_id 未設定でも可）。
 * @param date 基準日（JST の今日の暦日を表す Date）。
 */
export async function getSignageSnippets(db: Selectable, date: Date): Promise<DailySnippets> {
  const rows = await db.select().from(signageSnippets).where(eq(signageSnippets.active, true));
  return {
    quote: selectSnippetForDate(rows, date, "quote"),
    idiom: selectSnippetForDate(rows, date, "idiom"),
    word: selectSnippetForDate(rows, date, "word"),
    onThisDay: selectSnippetForDate(rows, date, "on_this_day"),
  };
}
