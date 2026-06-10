import { type InferSelectModel, and, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ads } from "../schema/ads.js";
import { advertisers } from "../schema/advertisers.js";
import { contents } from "../schema/contents.js";
import { contractContents } from "../schema/contract-contents.js";
import { contracts } from "../schema/contracts.js";
import { events } from "../schema/events.js";
import { schools } from "../schema/schools.js";

/**
 * Partner API K1 (`docs/api/partner-api-contract.md` §2): **単一広告主 × 指定月**の効果メトリクス
 * 読み取り層。**SELECT のみ**。
 *
 * 全広告主一覧用の `advertiser-report.ts` (`getMonthlyAdvertiserReport`) を **単一 advertiser に絞り込み**、
 * かつ契約 §2 が要求する追加フィールド (`dwell_seconds` / `presence` / `by_school` / `contracts`) を
 * 供給する薄い兄弟モジュール。portal の Vercel サーバーが server-to-server で pull する (ブラウザ非経由・
 * PII 無し・冪等)。
 *
 * ## 広告反応 (impressions/taps/asks/dwell) の帰属
 * `getMonthlyAdvertiserReport` と同一の連鎖
 * `advertisers ⟶ contracts (active_in_month) ⟶ contract_contents ⟶ contents ⟶ events` を辿り、
 * `count(distinct events.id)` で event 単位に重複排除する (#555 の anti-inflation を踏襲)。違いは
 * **WHERE で 1 広告主に絞る**点と、契約 §2 のため **dwell の秒数合計**を追加する点のみ。
 * - `impressions` = `view` の distinct event 数 (= 延べ表示数)。
 * - `taps` = `tap` の distinct event 数。
 * - `asks` = `ask` (F06 Q&A) の distinct event 数。
 * - `dwell_seconds` = `dwell` event の滞留秒数の総和。dwell の書き込み経路は現状未配線 (F07/event-ingest:
 *   `dwell` は Phase 2 まで write 不在) のため当面 0 になるが、配線後は `payload->>'seconds'` の合算で
 *   自動的に反映される。`distinct event` の dedup 対象 (count) ではなく **値の sum** なので、契約期間 ×
 *   コンテンツ紐付けの fan-out で二重加算しないよう、対象 event を **distinct(events.id) に正規化した
 *   サブセット**で合算する (下記 §dwell の fan-out 対策)。
 *
 * ## presence (接触機会 = §32 主役 KPI「リーチ」) の帰属 — 反応経路とは別系統
 * presence は広告主の契約コンテンツへの反応ではなく「対象校のサイネージ前に人が居た」接触機会
 * (ADR-020 / SwitchBot PIR)。したがって反応の連鎖 (contract_contents) ではなく、
 * **その広告主の広告が出ている学校** = `ads.advertiser_id = {advertiserId}` の distinct `school_id` を
 * 対象校とし、その学校群の当月 `type='presence'` event を `count(distinct payload->>'device_mac')` で
 * 集計する (契約 §2 の「対象校×期間の presence を distinct(device_mac)」)。device_mac は端末識別子で
 * あって個人 PII ではない (ADR-020 §6 PIR はカメラ非搭載・個人識別なし)。表記は「接触機会」で、視認
 * (見た) は断定しない (§32.3)。対象校が無い (= その広告主の `ads` が無い) 広告主は presence=0。
 *
 * ## by_school 内訳 (任意)
 * `bySchool` 指定時のみ、学校別に impressions/taps/presence を返す (契約 §2 の by_school 形)。
 * impressions/taps は反応の連鎖を school 別に group by し、presence は対象校別の distinct(device_mac)。
 * 学校名は `schools` から付す (system_admin context で cross-tenant 可視)。
 *
 * ## contracts 一覧
 * その広告主の契約を `status` / `target_school_count` (target_schools jsonb 配列長) / `monthly_fee_jpy`
 * で返す (契約 §2 の contracts 形)。月で絞らず広告主の全契約を返す (portal が契約状態を把握するため)。
 *
 * ## テナント分離 / 可視範囲 (CLAUDE.md ルール2 / ADR-019)
 * `school_id` 条件を**手書きしない**。CRM 表 (`advertisers`/`contracts`/`contract_contents`) は
 * `system_admin_full_access` policy のみを持つため、呼び出しは **system_admin context** で行う必要が
 * あり、その context では `events`/`contents`/`ads`/`schools` も全校横断に可視になる (複数校にまたがる
 * 広告主メトリクスの要件と一致)。非 system_admin context では CRM 表が 0 行になり結果も空
 * (deny-by-default)。呼び出し側は RLS をバイパスしない接続ロール (kimiterrace_app) を使う。**BYPASSRLS
 * 不使用**。降格 (tenantScoped) はしない (全校横断が要件)。
 *
 * ## 期間境界 (JST 暦月)
 * 対象月の窓は **Asia/Tokyo の暦月** `[当月 1 日 00:00 JST, 翌月 1 日 00:00 JST)`。両境界を
 * `make_timestamptz(year, month, ...)` で DB 側に int から構築し、JS の `Date` を bind しない
 * (postgres@3 の Date 直列化罠を回避、`advertiser-report.ts` と同方針)。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 返すのは広告主名・件数 (整数) / 秒数 / 学校名のみ。`events.payload` の生値 (device_mac 個別値・
 * clientId 等) や user_id は出さない (集計値のみ)。
 *
 * 型は schema (`advertisers`/`contracts`/`schools`) から `InferSelectModel` で派生する (ルール3)。
 */

/** SELECT (+ selectDistinct) だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select" | "selectDistinct">;

type AdvertiserRow = InferSelectModel<typeof advertisers>;
type ContractRow = InferSelectModel<typeof contracts>;
type SchoolRow = InferSelectModel<typeof schools>;

/** 単一広告主 × 指定月の集計合計 (契約 §2 totals)。 */
export type AdvertiserMetricsTotals = {
  /** view (延べ表示) の distinct event 数。 */
  impressions: number;
  /** tap (リンク/QR) の distinct event 数。 */
  taps: number;
  /** ask (Q&A) の distinct event 数。 */
  asks: number;
  /** dwell event の滞留秒数の総和 (payload.seconds、書き込み未配線の間は 0)。 */
  dwellSeconds: number;
  /** 接触機会 = 対象校×当月の presence を distinct(device_mac) で数えたリーチ。 */
  presence: number;
};

/** 学校別内訳 1 行 (契約 §2 by_school、bySchool 指定時のみ)。 */
export type AdvertiserMetricsBySchool = {
  schoolId: SchoolRow["id"];
  schoolName: SchoolRow["name"];
  impressions: number;
  taps: number;
  presence: number;
};

/** 契約 1 件の要約 (契約 §2 contracts)。 */
export type AdvertiserMetricsContract = {
  contractId: ContractRow["id"];
  status: ContractRow["status"];
  /** target_schools (配信対象校 jsonb 配列) の要素数。 */
  targetSchoolCount: number;
  monthlyFeeJpy: ContractRow["monthlyFeeJpy"];
};

/** 単一広告主 × 指定月のメトリクス読み取り結果。広告主が存在しなければ `null`。 */
export type AdvertiserMetrics = {
  advertiserId: AdvertiserRow["id"];
  companyName: AdvertiserRow["companyName"];
  totals: AdvertiserMetricsTotals;
  /** bySchool 指定時のみ非 undefined。学校別内訳 (impressions 降順 → schoolName 昇順 → schoolId 昇順)。 */
  bySchool?: AdvertiserMetricsBySchool[];
  contracts: AdvertiserMetricsContract[];
};

const MIN_MONTH = 1;
const MAX_MONTH = 12;

/** 広告反応として集計する event 種別 (presence/dwell は別経路で扱うためここには含めない)。 */
const REACTION_EVENT_TYPES = ["view", "tap", "ask"] as const;

export type AdvertiserMetricsParams = {
  /** 対象 `advertisers.id` (UUID)。 */
  advertiserId: string;
  /** 対象年 (西暦、例 2026)。整数以外は `RangeError`。 */
  year: number;
  /** 対象月 (1-12)。範囲外は `RangeError`。 */
  month: number;
  /** true で by_school 内訳を含める (契約 §2 `?by=school`)。 */
  bySchool?: boolean;
};

/**
 * 単一広告主 × 指定 JST 暦月の効果メトリクスを集計する (system_admin context、cross-tenant)。
 *
 * 広告主が存在しなければ `null` を返す (呼び出し側 Route Handler が 404 に変換する)。存在すれば
 * 反応 0 でも会社名 + 0 件の totals と contracts (あれば) を返す。
 *
 * @param db  system_admin context を張った非 BYPASSRLS の Selectable (tx)。
 */
export async function getAdvertiserMetrics(
  db: Selectable,
  params: AdvertiserMetricsParams,
): Promise<AdvertiserMetrics | null> {
  const { advertiserId, year, month, bySchool } = params;
  // 月は 1-12 のみ (make_timestamptz の月繰り上げ回避、advertiser-report.ts と同方針)。
  if (!Number.isInteger(month) || month < MIN_MONTH || month > MAX_MONTH) {
    throw new RangeError(`month must be an integer in [1, 12], got ${month}`);
  }
  if (!Number.isInteger(year)) {
    throw new RangeError(`year must be an integer, got ${year}`);
  }

  // 広告主の存在 + 会社名を先に解決する。0 行 (不存在 / 非 system_admin で不可視) は null → 404。
  const advRows = await db
    .select({ id: advertisers.id, companyName: advertisers.companyName })
    .from(advertisers)
    .where(eq(advertisers.id, advertiserId))
    .limit(1);
  const adv = advRows[0];
  if (!adv) {
    return null;
  }

  // JST 暦月窓 [当月 1 日 00:00 JST, 翌月 1 日 00:00 JST)。両境界を make_timestamptz で組み TZ 非依存に
  // する (advertiser-report.ts / ad-reach.ts と同方針、`+ interval '1 month'` の UTC セッション罠を回避)。
  const nextYear = month === MAX_MONTH ? year + 1 : year;
  const nextMonth = month === MAX_MONTH ? 1 : month + 1;
  const monthStart = sql`make_timestamptz(${year}::int, ${month}::int, 1, 0, 0, 0, 'Asia/Tokyo')`;
  const nextMonthStart = sql`make_timestamptz(${nextYear}::int, ${nextMonth}::int, 1, 0, 0, 0, 'Asia/Tokyo')`;

  // presence の「対象校」= その広告主の広告が出ている学校 = `ads.advertiser_id = {id}` の distinct school_id。
  // 先に id 集合を解決し、presence 集計へ配列で渡す (inArray にサブクエリを埋めず、proven な配列フォームを使う)。
  const targetSchoolRows = await db
    .selectDistinct({ schoolId: ads.schoolId })
    .from(ads)
    .where(eq(ads.advertiserId, advertiserId));
  const targetSchoolIds = targetSchoolRows.map((r) => r.schoolId);

  const [totals, bySchoolRows, contractRows] = await Promise.all([
    aggregateTotals(db, advertiserId, targetSchoolIds, monthStart, nextMonthStart),
    bySchool
      ? aggregateBySchool(db, advertiserId, targetSchoolIds, monthStart, nextMonthStart)
      : Promise.resolve(undefined),
    listContracts(db, advertiserId),
  ]);

  return {
    advertiserId: adv.id,
    companyName: adv.companyName,
    totals,
    ...(bySchoolRows ? { bySchool: bySchoolRows } : {}),
    contracts: contractRows,
  };
}

/** 当月 active な契約に紐づくコンテンツ反応 (view/tap/ask) の対象を絞る ON 節。dwell/presence は別経路。 */
function reactionInScope(
  monthStart: ReturnType<typeof sql>,
  nextMonthStart: ReturnType<typeof sql>,
) {
  return and(
    eq(events.contentId, contents.id),
    gte(events.occurredAt, monthStart),
    lt(events.occurredAt, nextMonthStart),
    inArray(events.type, [...REACTION_EVENT_TYPES]),
  );
}

/** 広告主スコープを「対象月にアクティブな契約 (active_in_month, #555)」に限定する ON 節。 */
function contractActiveInMonth(
  advertiserId: string,
  monthStart: ReturnType<typeof sql>,
  nextMonthStart: ReturnType<typeof sql>,
) {
  return and(
    eq(contracts.advertiserId, advertiserId),
    eq(contracts.status, "active"),
    lt(contracts.startedAt, nextMonthStart),
    or(isNull(contracts.endedAt), gt(contracts.endedAt, monthStart)),
  );
}

/** 反応 totals (impressions/taps/asks/dwell_seconds) + presence を集計する。 */
async function aggregateTotals(
  db: Selectable,
  advertiserId: string,
  targetSchoolIds: string[],
  monthStart: ReturnType<typeof sql>,
  nextMonthStart: ReturnType<typeof sql>,
): Promise<AdvertiserMetricsTotals> {
  // impressions/taps/asks は distinct event 数で fan-out を吸収する。dwell_seconds (値の sum) と
  // presence (別系統) はここで一緒に数えられない (count distinct と sum/別テーブルの混在) ため別取得する。
  const distinctOfType = (type: (typeof REACTION_EVENT_TYPES)[number]) =>
    sql<number>`count(distinct ${events.id}) filter (where ${events.type} = ${type})`.mapWith(
      Number,
    );

  const rows = await db
    .select({
      impressions: distinctOfType("view"),
      taps: distinctOfType("tap"),
      asks: distinctOfType("ask"),
    })
    .from(advertisers)
    .leftJoin(contracts, contractActiveInMonth(advertiserId, monthStart, nextMonthStart))
    .leftJoin(contractContents, eq(contractContents.contractId, contracts.id))
    .leftJoin(contents, eq(contents.id, contractContents.contentId))
    .leftJoin(events, reactionInScope(monthStart, nextMonthStart))
    .where(eq(advertisers.id, advertiserId));

  const row = rows[0] ?? { impressions: 0, taps: 0, asks: 0 };

  const [dwellSeconds, presence] = await Promise.all([
    sumDwellSeconds(db, advertiserId, monthStart, nextMonthStart),
    countPresence(db, targetSchoolIds, monthStart, nextMonthStart),
  ]);

  return {
    impressions: row.impressions,
    taps: row.taps,
    asks: row.asks,
    dwellSeconds,
    presence,
  };
}

/**
 * 当月 active 契約に紐づくコンテンツの dwell event について `payload.seconds` を合算する。
 *
 * fan-out (1 event が複数契約紐付けで複製) を避けるため、`group by events.id` で対象 dwell event を
 * 一意化して (id, seconds) を取り出し、JS 側で seconds を合算する。seconds 欠落 / 非数値は 0 に倒す
 * (不正 payload で SQL エラーにしない安全側)。dwell の書き込み経路は現状未配線のため通常 0 件で空を返す。
 */
async function sumDwellSeconds(
  db: Selectable,
  advertiserId: string,
  monthStart: ReturnType<typeof sql>,
  nextMonthStart: ReturnType<typeof sql>,
): Promise<number> {
  // 数字のみのとき numeric へ、それ以外は 0 に倒した seconds を event ごとに 1 行で取り出す。
  const seconds =
    sql<number>`(case when (${events.payload}->>'seconds') ~ '^[0-9]+$' then (${events.payload}->>'seconds')::numeric else 0 end)`.mapWith(
      Number,
    );
  const rows = await db
    .select({ seconds })
    .from(advertisers)
    .leftJoin(contracts, contractActiveInMonth(advertiserId, monthStart, nextMonthStart))
    .leftJoin(contractContents, eq(contractContents.contractId, contracts.id))
    .leftJoin(contents, eq(contents.id, contractContents.contentId))
    .innerJoin(
      events,
      and(
        eq(events.contentId, contents.id),
        eq(events.type, "dwell"),
        gte(events.occurredAt, monthStart),
        lt(events.occurredAt, nextMonthStart),
      ),
    )
    .where(eq(advertisers.id, advertiserId))
    // 同一 dwell event が複数契約紐付けで fan-out しても 1 行に畳む (二重加算回避)。
    .groupBy(events.id, events.payload);

  return rows.reduce((acc, r) => acc + r.seconds, 0);
}

/** 対象校 (= `ads.advertiser_id = {id}` の distinct school_id) の当月 presence を distinct(device_mac) で数える。 */
async function countPresence(
  db: Selectable,
  targetSchoolIds: string[],
  monthStart: ReturnType<typeof sql>,
  nextMonthStart: ReturnType<typeof sql>,
): Promise<number> {
  // 対象校が無い (その広告主の ads が無い) なら presence は 0 (空 inArray を避ける)。
  if (targetSchoolIds.length === 0) {
    return 0;
  }
  // device_mac は表記ゆれ (区切り有無) を正規形へ畳んでから distinct する (presence-history.ts と同式)。
  const macNorm = sql`upper(replace(replace(${events.payload}->>'device_mac', ':', ''), '-', ''))`;
  const presence = sql<number>`count(distinct ${macNorm})`.mapWith(Number);
  const rows = await db
    .select({ presence })
    .from(events)
    .where(
      and(
        eq(events.type, "presence"),
        gte(events.occurredAt, monthStart),
        lt(events.occurredAt, nextMonthStart),
        inArray(events.schoolId, targetSchoolIds),
        sql`${events.payload}->>'device_mac' is not null`,
      ),
    );
  return rows[0]?.presence ?? 0;
}

/** by_school 内訳 (impressions/taps を school 別、presence を対象校別)。impressions 降順で決定的に並べる。 */
async function aggregateBySchool(
  db: Selectable,
  advertiserId: string,
  targetSchoolIds: string[],
  monthStart: ReturnType<typeof sql>,
  nextMonthStart: ReturnType<typeof sql>,
): Promise<AdvertiserMetricsBySchool[]> {
  // --- impressions / taps を school 別に (反応の連鎖を events.school_id で group) ---
  const impressions =
    sql<number>`count(distinct ${events.id}) filter (where ${events.type} = 'view')`.mapWith(
      Number,
    );
  const taps =
    sql<number>`count(distinct ${events.id}) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const reactionRows = await db
    .select({ schoolId: events.schoolId, impressions, taps })
    .from(advertisers)
    .innerJoin(contracts, contractActiveInMonth(advertiserId, monthStart, nextMonthStart))
    .innerJoin(contractContents, eq(contractContents.contractId, contracts.id))
    .innerJoin(contents, eq(contents.id, contractContents.contentId))
    .innerJoin(
      events,
      and(
        eq(events.contentId, contents.id),
        gte(events.occurredAt, monthStart),
        lt(events.occurredAt, nextMonthStart),
        inArray(events.type, ["view", "tap"]),
      ),
    )
    .where(eq(advertisers.id, advertiserId))
    .groupBy(events.schoolId);

  // --- presence を対象校別に distinct(device_mac) ---
  const macNorm = sql`upper(replace(replace(${events.payload}->>'device_mac', ':', ''), '-', ''))`;
  const presenceCount = sql<number>`count(distinct ${macNorm})`.mapWith(Number);
  const presenceRows =
    targetSchoolIds.length === 0
      ? []
      : await db
          .select({ schoolId: events.schoolId, presence: presenceCount })
          .from(events)
          .where(
            and(
              eq(events.type, "presence"),
              gte(events.occurredAt, monthStart),
              lt(events.occurredAt, nextMonthStart),
              inArray(events.schoolId, targetSchoolIds),
              sql`${events.payload}->>'device_mac' is not null`,
            ),
          )
          .groupBy(events.schoolId);

  // --- school 名を解決して合流 (反応 or presence のどちらかがある school を網羅) ---
  const byId = new Map<string, { impressions: number; taps: number; presence: number }>();
  for (const r of reactionRows) {
    if (!r.schoolId) continue;
    const cur = byId.get(r.schoolId) ?? { impressions: 0, taps: 0, presence: 0 };
    cur.impressions += r.impressions;
    cur.taps += r.taps;
    byId.set(r.schoolId, cur);
  }
  for (const r of presenceRows) {
    if (!r.schoolId) continue;
    const cur = byId.get(r.schoolId) ?? { impressions: 0, taps: 0, presence: 0 };
    cur.presence += r.presence;
    byId.set(r.schoolId, cur);
  }
  if (byId.size === 0) {
    return [];
  }
  const ids = [...byId.keys()];
  const nameRows = await db
    .select({ id: schools.id, name: schools.name })
    .from(schools)
    .where(inArray(schools.id, ids));
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

  return (
    [...byId.entries()]
      .map(([schoolId, v]) => ({
        schoolId,
        schoolName: nameById.get(schoolId) ?? "",
        impressions: v.impressions,
        taps: v.taps,
        presence: v.presence,
      }))
      // impressions 降順 → schoolName 昇順 → schoolId 昇順で決定的に並べる。
      .sort(
        (a, b) =>
          b.impressions - a.impressions ||
          a.schoolName.localeCompare(b.schoolName) ||
          a.schoolId.localeCompare(b.schoolId),
      )
  );
}

/** その広告主の契約一覧 (status / target_school_count / monthly_fee_jpy)。startedAt 降順 → id 昇順。 */
async function listContracts(
  db: Selectable,
  advertiserId: string,
): Promise<AdvertiserMetricsContract[]> {
  // target_schools jsonb 配列の要素数を DB 側で数える (jsonb_array_length、非配列/NULL は 0 に倒す)。
  const targetSchoolCount =
    sql<number>`coalesce(jsonb_array_length(case when jsonb_typeof(${contracts.targetSchools}) = 'array' then ${contracts.targetSchools} else '[]'::jsonb end), 0)`.mapWith(
      Number,
    );
  const rows = await db
    .select({
      contractId: contracts.id,
      status: contracts.status,
      targetSchoolCount,
      monthlyFeeJpy: contracts.monthlyFeeJpy,
    })
    .from(contracts)
    .where(eq(contracts.advertiserId, advertiserId))
    .orderBy(sql`${contracts.startedAt} desc`, contracts.id);

  return rows.map((r) => ({
    contractId: r.contractId,
    status: r.status,
    targetSchoolCount: r.targetSchoolCount,
    monthlyFeeJpy: r.monthlyFeeJpy,
  }));
}
