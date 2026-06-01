import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { contents } from "../schema/contents.js";
import { events } from "../schema/events.js";
import { schools } from "../schema/schools.js";

/**
 * F08 (#44): 効果ダッシュボードの集計読み取り層。**SELECT のみ**。
 *
 * F07 (#43) が `events` に記録した行動ログ (view/tap) を、ダッシュボード 1 枚分に集計する。
 * mutation は持たない参照専用モジュール。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト (`app.current_school_id`、
 * ADR-019) が DB レベルでテナント境界を強制する。呼び出し側 (apps/web の `withSession`) が RLS
 * context を張った接続/トランザクションで実行し、`db` には RLS をバイパスしない接続ロール
 * (kimiterrace_app) を使うこと。`events` の `tenant_isolation` policy が SELECT を自校行に絞る
 * ため、集計結果も自校スコープになる。content 結合先 `contents` も同 policy で絞られる。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 集計は件数 (整数) と content タイトルのみを返し、`events.payload` の匿名 clientId 等は読み出さ
 * ない。個人を再識別しうる粒度 (端末別/個人別) には落とさない。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/**
 * 行動種別ごとの件数。F07 が記録する **view / tap** に加え、F06 生徒対話の **ask** (Q&A 件数、
 * F08 受け入れ条件) を面に出す。`dwell` は滞留秒数の計測手段が未確定で Phase 2 まで書き込み不在の
 * ため集計対象外。`ask` を書き込む経路 (F06) が未配線の間は 0 になるが、配線後は自動で反映される。
 */
export type EventTotals = { view: number; tap: number; ask: number };

/** content 1 件あたりの反応集計 (ランキング 1 行)。 */
export type ContentEngagement = {
  contentId: string;
  title: string;
  views: number;
  taps: number;
  /** views + taps (= 反応総数)。ランキングの並べ替えキー。 */
  total: number;
};

/** ダッシュボード 1 枚分の read モデル。 */
export type EventStats = {
  /** 集計対象の遡及日数 (DB の now() 基準)。表示の「過去 N 日間」ラベルに使う。 */
  sinceDays: number;
  totals: EventTotals;
  /** 反応の多い content 上位。total 降順、同数は title 昇順 → contentId 昇順で決定的に並べる。 */
  ranking: ContentEngagement[];
};

const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_RANKING_LIMIT = 10;

/**
 * 自校の行動ログを集計する (RLS で school スコープ)。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。期間窓は DB の `now()` 基準で評価し、
 *   クライアント/アプリ時刻を信用しない (F07 と同じ思想、なりすまし/時計ずれ回避)。
 * @param opts.rankingLimit content ランキングの最大件数 (既定 10)。
 */
export async function getEventStats(
  db: Selectable,
  opts: { sinceDays?: number; rankingLimit?: number } = {},
): Promise<EventStats> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const rankingLimit = opts.rankingLimit ?? DEFAULT_RANKING_LIMIT;

  // 期間窓は DB の now() を基準にする。sinceDays は内部既定 or 呼出側の固定値であり、
  // ユーザー入力を直接渡さない (将来 UI から渡す場合は呼出側で範囲検証する)。
  const recent = gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`);

  // --- totals: type 別件数 ---
  const totalRows = await db
    .select({ type: events.type, n: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .where(recent)
    .groupBy(events.type);
  const totals: EventTotals = { view: 0, tap: 0, ask: 0 };
  for (const row of totalRows) {
    if (row.type === "view") {
      totals.view = row.n;
    } else if (row.type === "tap") {
      totals.tap = row.n;
    } else if (row.type === "ask") {
      totals.ask = row.n;
    }
  }

  // --- ranking: content 別反応数 ---
  // title を出すため contents を内部結合する。INNER JOIN により content_id が NULL の event
  // (例: 広告枠そのものへの tap) は自然に除外される。結合先 contents も RLS で自校に絞られる。
  // ランキングは **view/tap の反応**で並べるため WHERE で ask/dwell を除外する。これにより
  // `total = count(*)` が views + taps と一致し (UI の 表示/タップ/合計 が整合)、ask は totals 側に
  // のみ計上される。
  const reactions = and(recent, inArray(events.type, ["view", "tap"]));
  const views = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
  const taps = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const total = sql<number>`count(*)`.mapWith(Number);
  const rankRows = await db
    .select({ contentId: events.contentId, title: contents.title, views, taps, total })
    .from(events)
    .innerJoin(contents, eq(events.contentId, contents.id))
    .where(reactions)
    .groupBy(events.contentId, contents.title)
    // total 同数でも順序を決定的にするため title → contentId を二次/三次キーにする。
    .orderBy(sql`count(*) desc`, contents.title, events.contentId)
    .limit(rankingLimit);

  const ranking: ContentEngagement[] = rankRows.map((r) => ({
    // INNER JOIN により contentId は非 NULL (NULL は結合条件で除外される)。型の都合で narrow する。
    contentId: r.contentId as string,
    title: r.title,
    views: r.views,
    taps: r.taps,
    total: r.total,
  }));

  return { sinceDays, totals, ranking };
}

/** 1 日 (JST 暦日) あたりの view/tap 件数。時系列表示用。 */
export type DailyEventCount = {
  /** JST 暦日 (YYYY-MM-DD)。 */
  day: string;
  views: number;
  taps: number;
};

/**
 * 自校の view/tap を **JST 暦日**ごとに集計する (RLS で school スコープ)。日付昇順。
 *
 * バケットは `occurred_at` (timestamptz) を Asia/Tokyo に変換してから日に丸める。UTC のまま
 * 丸めると深夜帯 (例 JST 8:00 = UTC 23:00 前日) の event が前日にずれるため、日本の学校向けに
 * JST 暦日へ寄せる (signage の jstDateString と同じ思想)。期間窓は `getEventStats` と同じく
 * DB の `now()` 基準。集計は件数のみで `payload` の匿名 clientId は読まない (ルール4)。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。
 */
export async function getDailyEventCounts(
  db: Selectable,
  opts: { sinceDays?: number } = {},
): Promise<DailyEventCount[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const recent = gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`);

  const day = sql<string>`to_char(date_trunc('day', ${events.occurredAt} at time zone 'Asia/Tokyo'), 'YYYY-MM-DD')`;
  const views = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
  const taps = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const rows = await db
    .select({ day, views, taps })
    .from(events)
    .where(recent)
    .groupBy(day)
    .orderBy(day);

  return rows.map((r) => ({ day: r.day, views: r.views, taps: r.taps }));
}

/** 全校横断ダッシュボードの 1 行 (= 1 校分の行動サマリー)。 */
export type SchoolEventSummary = {
  schoolId: string;
  /** 学校名 (schools.name)。 */
  schoolName: string;
  /** 都道府県 (schools.prefecture)。一覧の地域別把握用。 */
  prefecture: string;
  /** view / tap / ask の期間内総数。 */
  totals: EventTotals;
  /** view + tap (= 反応総数)。並べ替えキー。 */
  reactions: number;
};

/**
 * **全校横断**で学校別の行動サマリーを集計する (system_admin 専用の cross-tenant ビュー)。
 *
 * F08 第1〜3スライス (`getEventStats` / `getDailyEventCounts`) が **自校スコープ** (school_admin /
 * teacher) のダッシュボードを担うのに対し、本クエリは運営 (system_admin) が全校の活動量を横断で
 * 把握するための学校別サマリーを返す。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * ここでも `school_id` 条件は**書かない** — events / schools の RLS に委譲する。**system_admin
 * コンテキスト** (`app.current_user_role = 'system_admin'`、ADR-019) では `system_admin_full_access`
 * policy が全校行に PERMISSIVE 発火し、横断集計になる。tenant ロール (school_admin / teacher) で
 * 呼んだ場合は `tenant_isolation` が自校行のみに絞るため**自校 1 行**だけが返る (多層防御。ただし
 * UX 層では `requireRole(SYSTEM_ADMIN_ROLES)` で先に弾く)。空コンテキストは deny-by-default で空配列。
 *
 * ## 集計対象 / PII (ルール4)
 * events を schools に **INNER JOIN** して school 名/都道府県を付す。events.school_id は NOT NULL かつ
 * schools 参照のため、期間内に 1 件以上 event があった学校だけが行として現れる (活動ゼロの学校は
 * 本スライスでは省略する。全校網羅一覧は学校マスタ #48-L 側に存在する)。集計は件数のみで、
 * `events.payload` の匿名 clientId 等は読まない。
 *
 * 並びは反応数 (view+tap) 降順 → 学校名昇順 → schoolId 昇順で決定的にする。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。期間窓は DB の `now()` 基準 (クライアント時刻不信)。
 */
export async function getEventStatsBySchool(
  db: Selectable,
  opts: { sinceDays?: number } = {},
): Promise<SchoolEventSummary[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const recent = gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`);

  const views = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
  const taps = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const asks = sql<number>`count(*) filter (where ${events.type} = 'ask')`.mapWith(Number);
  // 反応数 = view + tap (ask は別指標として totals.ask にのみ計上、getEventStats と同方針)。
  const reactions = sql<number>`count(*) filter (where ${events.type} in ('view', 'tap'))`.mapWith(
    Number,
  );

  const rows = await db
    .select({
      schoolId: schools.id,
      schoolName: schools.name,
      prefecture: schools.prefecture,
      views,
      taps,
      asks,
      reactions,
    })
    .from(events)
    .innerJoin(schools, eq(events.schoolId, schools.id))
    .where(recent)
    .groupBy(schools.id, schools.name, schools.prefecture)
    // 反応数同数でも順序を決定的にするため schoolName → schoolId を二次/三次キーにする。
    .orderBy(
      sql`count(*) filter (where ${events.type} in ('view', 'tap')) desc`,
      schools.name,
      schools.id,
    );

  return rows.map((r) => ({
    schoolId: r.schoolId,
    schoolName: r.schoolName,
    prefecture: r.prefecture,
    totals: { view: r.views, tap: r.taps, ask: r.asks },
    reactions: r.reactions,
  }));
}

/** 時間帯 (JST hour-of-day, 0-23) あたりの view/tap 件数。1 日のうちの反応傾向を見る。 */
export type HourlyEventCount = {
  /** JST の時 (0-23)。 */
  hour: number;
  views: number;
  taps: number;
};

/**
 * 自校の view/tap を **JST の時 (hour-of-day, 0-23)** ごとに集計する (RLS で school スコープ)。時昇順。
 *
 * 日次推移 (`getDailyEventCounts`) が「どの日に見られたか」を示すのに対し、これは「1 日のうち
 * どの時間帯に見られるか」(朝の登校時・昼休み・放課後など) の傾向を示す。バケットは `occurred_at`
 * を Asia/Tokyo に変換してから `extract(hour ...)` で時を取り出す。UTC のまま取ると JST との時差
 * (9h) で時間帯がずれるため、`getDailyEventCounts` と同じく JST に寄せる。期間窓は DB の `now()`
 * 基準。集計は件数のみで `payload` の匿名 clientId は読まない (ルール4)。
 *
 * 返す行は **events が存在する時のみ** (sparse)。0 件の時を含めた 0-23 の密化は表示層の責務とする。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。
 */
export async function getHourlyEventCounts(
  db: Selectable,
  opts: { sinceDays?: number } = {},
): Promise<HourlyEventCount[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const recent = gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`);

  // extract(...) は numeric を返すため ::int に落としてから Number 化する。
  const hour =
    sql<number>`extract(hour from ${events.occurredAt} at time zone 'Asia/Tokyo')::int`.mapWith(
      Number,
    );
  const views = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
  const taps = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const rows = await db
    .select({ hour, views, taps })
    .from(events)
    .where(recent)
    .groupBy(hour)
    .orderBy(hour);

  return rows.map((r) => ({ hour: r.hour, views: r.views, taps: r.taps }));
}

/** JST の時 (0-23) ごとの presence (在室) 件数。F08 人感ヒートマップ用。 */
export type HourlyPresenceCount = {
  /** JST の時 (0-23)。 */
  hour: number;
  /** その時間帯の presence イベント数。 */
  presence: number;
};

/**
 * 自校の presence イベント (F13 人感センサー由来、`events.type='presence'`) を **JST の時
 * (hour-of-day, 0-23)** ごとに集計する (RLS で school スコープ)。時昇順。
 *
 * view/tap (`getHourlyEventCounts`) が「掲示物への反応」を示すのに対し、これは反応の有無に依らない
 * 「人の在室」を示す F08 人感ヒートマップの基盤。occupancy 指標は将来 `sensor_devices` 結合で
 * class/location 別に拡張しうる (sensor-devices.ts の `class_id` コメント参照) ため、content 反応集計
 * (getHourlyEventCounts) とは別関数に分け、既存の返却形を壊さない。
 *
 * - JST 変換は `getHourlyEventCounts` と同じ (`at time zone 'Asia/Tokyo'` 後に `extract(hour ...)`)。
 *   UTC のまま取ると JST と 9h ずれる。期間窓は DB の `now()` 基準 (クライアント時刻を信用しない、F07 と同思想)。
 * - **テナント分離 (ルール2)**: `school_id` を書かず `events` の RLS (`tenant_isolation`) に委譲。
 * - 件数のみ。`payload` (device 詳細) は読まない。presence/sensor_devices に PII は無い (ADR-020 §6) が
 *   個人別粒度には落とさない (ルール4)。
 * - 返す行は presence が存在する時のみ (sparse、`WHERE type='presence'`)。0-23 の密化は表示層の責務。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。
 */
export async function getHourlyPresenceCounts(
  db: Selectable,
  opts: { sinceDays?: number } = {},
): Promise<HourlyPresenceCount[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const where = and(
    eq(events.type, "presence"),
    gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`),
  );
  const hour =
    sql<number>`extract(hour from ${events.occurredAt} at time zone 'Asia/Tokyo')::int`.mapWith(
      Number,
    );
  const presence = sql<number>`count(*)`.mapWith(Number);
  const rows = await db
    .select({ hour, presence })
    .from(events)
    .where(where)
    .groupBy(hour)
    .orderBy(hour);

  return rows.map((r) => ({ hour: r.hour, presence: r.presence }));
}

/** JST 暦日ごとの presence (在室) 件数。F08 在室の日次推移用。 */
export type DailyPresenceCount = {
  /** JST 暦日 (YYYY-MM-DD)。 */
  day: string;
  /** その日の presence イベント数。 */
  presence: number;
};

/**
 * 自校の presence イベント (F13 人感センサー由来、`events.type='presence'`) を **JST 暦日**ごとに
 * 集計する (RLS で school スコープ)。日付昇順。
 *
 * `getDailyEventCounts` (view/tap の日次推移) の presence 版。「日々どれだけ人が来ているか」(来場の
 * 増減トレンド) を示し、時間帯別 (`getHourlyPresenceCounts`) と対で在室の推移と傾向を見せる。
 *
 * - JST 暦日への丸めは `getDailyEventCounts` と同じ (`date_trunc('day', ... at time zone 'Asia/Tokyo')`)。
 *   UTC のまま丸めると深夜帯 (JST 8:00 = UTC 前日 23:00) が前日にずれる。期間窓は DB の `now()` 基準。
 * - **テナント分離 (ルール2)**: `school_id` を書かず `events` の RLS (`tenant_isolation`) に委譲。
 * - 件数のみ。`payload` (device 詳細) は読まない。presence/sensor_devices に PII は無い (ADR-020 §6) が
 *   個人別粒度には落とさない (ルール4)。
 * - 返す行は presence が存在する日のみ (sparse、`WHERE type='presence'`)。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。
 */
export async function getDailyPresenceCounts(
  db: Selectable,
  opts: { sinceDays?: number } = {},
): Promise<DailyPresenceCount[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const where = and(
    eq(events.type, "presence"),
    gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`),
  );
  const day = sql<string>`to_char(date_trunc('day', ${events.occurredAt} at time zone 'Asia/Tokyo'), 'YYYY-MM-DD')`;
  const presence = sql<number>`count(*)`.mapWith(Number);
  const rows = await db
    .select({ day, presence })
    .from(events)
    .where(where)
    .groupBy(day)
    .orderBy(day);

  return rows.map((r) => ({ day: r.day, presence: r.presence }));
}
