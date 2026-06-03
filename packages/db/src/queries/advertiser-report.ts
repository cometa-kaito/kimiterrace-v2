import { type InferSelectModel, and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { advertisers } from "../schema/advertisers.js";
import { contents } from "../schema/contents.js";
import { contractContents } from "../schema/contract-contents.js";
import { contracts } from "../schema/contracts.js";
import { events } from "../schema/events.js";

/**
 * F09 (#45): 広告主アカウント単位の月次レポート集計読み取り層。**SELECT のみ**。
 *
 * F09 受け入れ条件「広告主別レポート: その広告主の広告だけの到達・タップ・Q&A 件数」の
 * **広告主アカウント単位**の供給源。広告 (caption) 単位の到達数を出す `ad-reach.ts`
 * (`getMonthlyAdReach`) と対になり、こちらは CRM の `advertisers` を主語に
 * 「その広告主が出稿した全コンテンツ」の反応 (view/tap/ask) を **JST 暦月**で 1 行/広告主に
 * 集約する。`monthly-report.md` シーケンス図の「集計結果 (advertiser 別)」に対応する。
 *
 * ## 広告主 → 反応のたどり方 (関連の連鎖)
 * 広告主の出稿は `advertisers ⟶ contracts (advertiser_id) ⟶ contract_contents
 * (contract_id, content_id) ⟶ contents` で表現される (F10 CRM)。`events` は `content_id` で
 * `contents` を参照するため、ある広告主の反応は「その広告主の契約に紐づくコンテンツに対する
 * event」になる。`ads` テーブル (表示メディア) は CRM の advertiser アカウントとは**別概念**で
 * advertiser_id を持たないため、本集計は `contract_contents` 経由のコンテンツ紐付けを唯一の
 * 広告主帰属とする (data-model.md / ADR-018)。
 *
 * ## 重複計上の回避 (count distinct event)
 * 1 コンテンツが同一広告主の**複数契約**に紐づく / 1 広告主が複数契約を持つ場合、素朴な
 * `count(*)` は同じ event を契約数ぶん重複計上する (contract_contents との結合で event 行が
 * fan-out する)。広告主への報告値を膨らませないため、件数は **`count(distinct events.id)`**
 * で event 単位に集約する (anti-inflation、ad-reach.ts の dedup と同じ思想)。
 *
 * ## 対象 event と Q&A の帰属
 * `type ∈ {view, tap, ask}` のみ集計する (`dwell`/`presence` は広告効果指標でないため除外)。
 * `ask` (F06 生徒対話の Q&A) は `content_id` を持つ event のみ join 成立する。掲示物に紐づかない
 * 一般チャットの ask は `content_id` が無く join しないため、広告主に**誤帰属しない** (正しい挙動)。
 *
 * ## テナント分離 / 可視範囲 (CLAUDE.md ルール2 / ADR-019)
 * `school_id` 条件を**手書きしない**。本集計は CRM 表 (`advertisers`/`contracts`/
 * `contract_contents`) を含み、これらは `system_admin_full_access` policy **のみ**を持つ
 * (tenant_isolation 無し、migration 0002/0020)。したがって呼び出しは **system_admin context**
 * (`app.current_user_role='system_admin'`) で行う必要があり、その context では `events`/`contents`
 * も `system_admin_full_access` で**全校横断**に可視になる。これは広告主の契約が複数校にまたがる
 * 広告主別レポートの要件と一致する (school_admin/teacher 等の非 system_admin context では CRM 表が
 * 0 行になり結合結果も空 = deny-by-default)。呼び出し側は RLS をバイパスしない接続ロール
 * (kimiterrace_app) を使うこと。**BYPASSRLS 不使用**。
 *
 * ## 期間境界 (JST 暦月)
 * 対象月の窓は **Asia/Tokyo の暦月** `[当月 1 日 00:00 JST, 翌月 1 日 00:00 JST)`。両境界を
 * `make_timestamptz(year, month, 1, 0, 0, 0, 'Asia/Tokyo')` で **DB 側に int から構築**し、JS の
 * `Date` を timestamptz に bind しない (postgres@3.4.9 の Date 直列化罠を回避、getMonthlyAdReach /
 * getMonthlySchoolSummary と同方針)。翌月境界に `+ interval '1 month'` を使うとセッション TZ
 * (CI/本番=UTC) で月加算され JST 月末を取りこぼすため、翌月は JS 側で年跨ぎを解いて明示構築する。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 返すのは広告主名・件数 (整数) のみ。`events.payload` の匿名 clientId 等や個人特定情報は出さない。
 *
 * 型は schema (`advertisers`) から `InferSelectModel` で派生する (ルール3)。mutation は持たない。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type AdvertiserRow = InferSelectModel<typeof advertisers>;

/** 広告主 1 件あたりの月次反応サマリー (F09 広告主別レポート 1 行)。 */
export type AdvertiserMonthlyReport = {
  /** 広告主 id (advertisers.id)。 */
  advertiserId: AdvertiserRow["id"];
  /** 広告主の会社名 (advertisers.company_name)。表示ラベル。 */
  companyName: AdvertiserRow["companyName"];
  /** 当月にその広告主のコンテンツに発生した view 件数 (event 単位で重複排除済)。 */
  views: number;
  /** 当月のタップ件数 (event 単位で重複排除済)。 */
  taps: number;
  /** 当月の Q&A (ask) 件数 (event 単位で重複排除済)。 */
  asks: number;
  /** views + taps + asks の合計反応数。並べ替えキー。 */
  total: number;
};

const MIN_MONTH = 1;
const MAX_MONTH = 12;

/** 広告効果として集計する event 種別。dwell/presence は広告指標でないため除外する。 */
const REPORTED_EVENT_TYPES = ["view", "tap", "ask"] as const;

/**
 * 広告主アカウント単位の月次反応サマリーを **JST 暦月**で集計する (RLS で system_admin スコープ)。
 *
 * 広告主ごとに 1 行を返し、その広告主が契約 (`contracts`) ⟶ `contract_contents` ⟶ `contents` で
 * 出稿したコンテンツに対する当月の view/tap/ask 件数を `count(distinct events.id)` で出す。当月に
 * 反応が 1 件も無い広告主も**会社名と 0 件で 1 行**返す (広告主一覧として欠落させない。LEFT JOIN)。
 *
 * 並びは合計反応数 (total) 降順、同数は会社名昇順 → advertiserId 昇順で決定的に並べる。
 *
 * @param db  system_admin context を張った非 BYPASSRLS の Selectable (tx)。
 * @param opts.year  対象年 (西暦、例 2026)。整数以外は `RangeError`。
 * @param opts.month 対象月 (1-12)。範囲外は `RangeError`。
 */
export async function getMonthlyAdvertiserReport(
  db: Selectable,
  opts: { year: number; month: number },
): Promise<AdvertiserMonthlyReport[]> {
  const { year, month } = opts;
  // 月は 1-12 のみ受け付ける (make_timestamptz は 13 月等を翌年へ繰り上げ、呼び出し側の想定とずれる
  // ため明示的に弾く)。year/month は UI からの入力になりうるので範囲検証する (getMonthlyAdReach と同様)。
  if (!Number.isInteger(month) || month < MIN_MONTH || month > MAX_MONTH) {
    throw new RangeError(`month must be an integer in [1, 12], got ${month}`);
  }
  if (!Number.isInteger(year)) {
    throw new RangeError(`year must be an integer, got ${year}`);
  }

  // JST 暦月の窓 [当月 1 日 00:00 JST, 翌月 1 日 00:00 JST)。両境界を make_timestamptz で直接組み、
  // セッション TZ 非依存にする (`+ interval '1 month'` は UTC セッションで JST 月末を取りこぼす既知罠)。
  // 翌月は JS 側で年跨ぎ (12 月→翌年 1 月) を解いて明示構築する (int 渡し、Date は bind しない)。
  const nextYear = month === MAX_MONTH ? year + 1 : year;
  const nextMonth = month === MAX_MONTH ? 1 : month + 1;
  const monthStart = sql`make_timestamptz(${year}::int, ${month}::int, 1, 0, 0, 0, 'Asia/Tokyo')`;
  const nextMonthStart = sql`make_timestamptz(${nextYear}::int, ${nextMonth}::int, 1, 0, 0, 0, 'Asia/Tokyo')`;

  // 当月かつ集計対象種別の event だけを join 対象にする条件。LEFT JOIN の ON 節に載せることで、
  // 「反応 0 の広告主も 1 行残す」(広告主一覧の網羅性) を保ったまま、件数だけを当月・対象種別へ絞る。
  // (WHERE に置くと event が無い広告主行が落ち、0 件広告主が一覧から消える。)
  const eventInScope = and(
    eq(events.contentId, contents.id),
    gte(events.occurredAt, monthStart),
    lt(events.occurredAt, nextMonthStart),
    inArray(events.type, [...REPORTED_EVENT_TYPES]),
  );

  // event 単位で重複排除した type 別件数 (contract_contents/contracts 経由の fan-out を吸収)。
  const distinctOfType = (type: (typeof REPORTED_EVENT_TYPES)[number]) =>
    sql<number>`count(distinct ${events.id}) filter (where ${events.type} = ${type})`.mapWith(
      Number,
    );
  const views = distinctOfType("view");
  const taps = distinctOfType("tap");
  const asks = distinctOfType("ask");
  // 合計反応数も distinct event 数 (= 当月・対象種別の event 総数を広告主単位で重複排除)。
  const total = sql<number>`count(distinct ${events.id})`.mapWith(Number);

  const rows = await db
    .select({
      advertiserId: advertisers.id,
      companyName: advertisers.companyName,
      views,
      taps,
      asks,
      total,
    })
    .from(advertisers)
    // 広告主 → 契約 → 出稿コンテンツ → event の連鎖。すべて LEFT JOIN で、契約/出稿/反応が無い広告主も
    // 1 行 (0 件) 残す。RLS により CRM 表は system_admin のみ可視、events/contents も同 context で全校可視。
    .leftJoin(contracts, eq(contracts.advertiserId, advertisers.id))
    .leftJoin(contractContents, eq(contractContents.contractId, contracts.id))
    .leftJoin(contents, eq(contents.id, contractContents.contentId))
    .leftJoin(events, eventInScope)
    .groupBy(advertisers.id, advertisers.companyName)
    // total 同数でも順序を決定的にするため会社名 → advertiserId を二次/三次キーにする。
    .orderBy(sql`count(distinct ${events.id}) desc`, advertisers.companyName, advertisers.id);

  return rows.map((r) => ({
    advertiserId: r.advertiserId,
    companyName: r.companyName,
    views: r.views,
    taps: r.taps,
    asks: r.asks,
    total: r.total,
  }));
}
