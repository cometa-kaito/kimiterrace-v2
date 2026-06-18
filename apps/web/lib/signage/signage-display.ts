import { hashToken } from "@/lib/magic-link/token";
import {
  type ClassVisitor,
  type EffectiveAd,
  type SignageClassContext,
  type StudentCallout,
  type TenantTx,
  getCalloutsForClass,
  getEffectiveAdsForClass,
  getSignageClassContext,
  getTodayPresenceCount,
  getVisitorsForClass,
  resolveMagicLink,
  withTenantContext,
} from "@kimiterrace/db";
import { getDb } from "../db";
import { getClassSignageBlackout } from "./blackout";
import {
  type EffectiveDailyData,
  type ScheduleDay,
  getEffectiveDailyData,
  getEffectiveScheduleDays,
} from "./effective-daily-data";
import { type SignageNews, getSignageNews } from "./news";
import { patternIncludesBlock } from "./pattern-blocks";
import { type SignageRailwayStatus, getSignageRailwayStatus } from "./railway-status";
import { signageScheduleDates } from "./rotation";
import {
  type SignageDesignPattern,
  getSignageDesignPattern,
  isSignageDesignPattern,
} from "./signage-design";
import { type SignageWeather, getSignageWeather } from "./weather";

/**
 * 公開サイネージ表示の**データアクセス層** (#48-E / F12)。`/signage/{classToken}` の Server
 * Component (初期描画) とポーリング Route Handler (自動更新) の両方が本層を 1 回呼ぶ。
 *
 * ## RLS コンテキスト (CLAUDE.md ルール2 / STATUS「withSession→withTenantContext」)
 *
 * サイネージ端末は**匿名** (教員の Identity Platform セッションを持たない) なので、認証必須の
 * `withSession` (lib/db) は使えない。代わりに 2 段で安全にテナント文脈を確立する:
 *
 *  1. URL の `classToken` を `resolveMagicLink` (SECURITY DEFINER 関数、RLS 文脈不要) で
 *     `{schoolId, classId}` に解決。失効/期限切れ/不明トークンは null → 呼び出し側が 410/無効画面へ。
 *     これは F05 の生徒匿名アクセスと同じ「RLS をくぐる唯一の扉」を再利用する (新規スキーマ不要)。
 *  2. 解決できた `schoolId` のみを `withTenantContext` に載せてトランザクションを開く。userId/role は
 *     **載せない** (deny-by-default)。`app.current_school_id` だけが set されるので、`daily_data` /
 *     `effective_ads_per_class` VIEW (security_invoker) の `tenant_isolation` が DB レベルで自校に
 *     限定する。手書き `WHERE school_id=?` には依存しない (ルール2)。`getDb()` は非 BYPASSRLS の
 *     `kimiterrace_app` 接続。
 *
 * **PII 非表示 (threat-model S-03)**: 表示するのはクラス単位の公開情報 (時間割・連絡・課題・広告)
 * のみで、個別生徒の氏名・出欠は含まない。よって本経路は Vertex AI を呼ばず PII マスキング (ルール4)
 * の対象外。`classToken` は credential なのでログ・例外に出さない (ルール5)。
 *
 * ## NFR01 接続試算 (タスク要件: 50 台×ポーリングを NFR01 と突合)
 *
 * - 1 ポーリング = 本関数 1 回 = `withTenantContext` 1 トランザクション = プール 1 接続を**短時間**
 *   占有 (内訳: クラス解決 1 + daily 1 + ads 1 の計 3 SELECT、いずれも index 等価結合で
 *   NFR01「DB クエリ p95 < 100ms」内、合計 < 数十 ms)。
 * - 負荷: 50 台/校 ÷ 10 秒 (POLL_BASE_MS) = **5 req/s/校** (v1-v2-mapping が懸念した 5 秒間隔の
 *   10 req/s を、サイネージの低更新頻度を根拠に 10 秒へ倍化して半減)。`rotation.ts` のジッタで
 *   位相を分散し同一秒バーストを回避。
 * - 同時接続: 5 req/s × ~0.05s 占有 ≒ **平均 0.25 接続/校**。`createDbClient` の `max:10`
 *   プール (Cloud Run 1 インスタンス) に対し桁違いに余裕。最悪ケース (50 台が同位相に揃う) でも
 *   ジッタ + Cloud Run の水平オートスケール (ADR-002) + 短トランザクションで吸収。
 * - 多校展開時の真の上限は Cloud SQL 全体の `max_connections`。1 インスタンス当たり max:10 を
 *   守り、必要なら Phase 2 で pgBouncer / Cloud SQL コネクションプーラを前段に置く (本 MVP では不要)。
 * - 鮮度: NFR01「公開からサイネージ反映まで最大 60 秒」に対し 10 秒ポーリングは十分内側。
 *   失効反映も毎リクエスト再解決なので即時 (キャッシュしない、下記 Route Handler の no-store 参照)。
 */

/** サイネージ 1 画面分のペイロード。Server Component の初期描画とポーリング応答で共有。 */
export type SignagePayload = {
  date: string;
  /**
   * 学校が選んだサイネージ盤面デザインパターン（学校別デザイン）。`SignageClient` がこの値で盤面
   * コンポーネントを dispatch する。未設定の学校は既定 `pattern1`（今回作成した v1 レイアウト）。
   */
  designPattern: SignageDesignPattern;
  daily: EffectiveDailyData;
  /**
   * v1 サイネージの「予定」3 列グリッド (今後 3 平日) 用。`date` を起点に土日を飛ばした 3 平日ぶんの
   * 実効「予定」セクション。連絡/課題/静粛時間は当日のみで足りるので `daily` 側に持つ (本配列は予定専用)。
   */
  scheduleDays: ScheduleDay[];
  ads: EffectiveAd[];
  /**
   * F14 (#128, ADR-021): 自校地域の天気予報（本日以降）。**バックエンド Job が `weather_forecasts` に
   * キャッシュした行を自社 DB から SELECT しただけ**で、端末・本経路とも JMA を直叩きしない（閉域維持、
   * [[closed-system-security]]）。地域未解決・キャッシュ無し・取得失敗時は `null`（ウィジェット非表示 =
   * fail-soft。天気が無くても画面の他要素は壊れない、F14 §3 / NFR02）。
   */
  weather: SignageWeather | null;
  /**
   * #243 (②UI-UX): このサイネージが**どのクラスのものか識別**するための文脈（学科名 / 学年名 / クラス名）。
   * ヘッダーの時刻横に表示する。階層モードにより学科・学年は null になりうる。RLS で自校に限定。
   */
  classContext: SignageClassContext;
  /**
   * パターン2「人感センサカウンタ」用、このクラスの**本日（JST）の presence 検知件数**（PIR 人感センサーの
   * 検知回数）。pattern1 は使わない。センサー未設置・検知ゼロは `0`、取得失敗は `null`（ウィジェットは
   * 「計測なし」表示＝fail-soft、盤面を壊さない）。
   */
  presenceCount: number | null;
  /**
   * パターン2「来校者一覧」用、このクラスの**当日（JST）の来校者**（時刻順）。pattern1 は使わない。来校者
   * 無し・取得失敗はともに空/`null`（ウィジェットは「本日の来校者はありません」表示＝fail-soft）。氏名は
   * 当該クラスの端末にのみ表示され RLS で自校スコープ（class-visitors schema の「個人情報について」参照）。
   */
  visitors: ClassVisitor[] | null;
  /**
   * パターン2「生徒呼び出し」用、このクラスの**当日（JST）の呼び出し**（時刻順）。pattern1 は使わない。
   * 呼び出し無し・取得失敗はともに空/`null`（ウィジェットは「呼び出しはありません」表示＝fail-soft）。
   * 生徒氏名はフルネームで当該クラス端末にのみ表示され RLS で自校スコープ・**Vertex 非送信**（ADR-034）。
   */
  callouts: StudentCallout[] | null;
  /**
   * パターン2「鉄道」用、対象事業者（当面=名鉄/笠松駅）の運行情報。pattern1 は使わない。**端末は閉域**で、
   * バックエンド取得 Job が `railway_status` にキャッシュした行を読むだけ（名鉄サイト直叩きしない・ADR-035）。
   * キャッシュ無し・取得失敗は `null`（ウィジェットは「運行情報は取得できていません」表示＝fail-soft）。
   */
  trainStatus: SignageRailwayStatus | null;
  /**
   * パターン2/3「工学ニュース」用、外部取得キャッシュ（news_items）の最新見出し（見出し+発表元+公開日+出典 URL）。
   * pattern1 は使わない。**端末は閉域**で、バックエンド取得 Job が `news_items` にキャッシュした行を読むだけ
   * （政府系/JST の公開 RSS を直叩きしない・ADR-043）。RLS read_all で匿名でも読める。**本文は持たず転載しない**
   * （著作権方針）。記事無し・取得失敗は `items: []`（ウィジェットは「ニュースを取得できていません」表示＝
   * fail-soft）。`null` はパターン非該当（pattern1）で取得していないことを表す。
   */
  news: SignageNews | null;
  /**
   * このクラスのサイネージ「黒画面」状態（per-class 運用トグル・web のみ・パターン非依存）。`true` のとき
   * `SignageClient` が盤面の代わりに全画面の黒画面を描く（夜間/イベント等で一時的に画面を消す用途）。保存先は
   * `school_configs`（scope='class', kind='display_settings'）の `value.blackout`。未設定・取得失敗は `false`
   * （＝通常の盤面を出す。fail-soft、盤面を壊さない）。ポーリングで `false` 復帰すると盤面に戻る。
   */
  blackout: boolean;
};

/** トークンを {schoolId, classId} に解決。無効 (失効/期限切れ/不明) なら null。 */
async function resolveSignageClass(
  classToken: string,
): Promise<{ schoolId: string; classId: string } | null> {
  const resolved = await resolveMagicLink(getDb(), hashToken(classToken));
  if (!resolved) {
    return null;
  }
  return { schoolId: resolved.schoolId, classId: resolved.classId };
}

/**
 * 指定クラストークン・日付のサイネージ表示データを 1 トランザクションで取得する。
 *
 * @param classToken 公開クラストークン (magic link)。credential なのでログに出さない。
 * @param date       YYYY-MM-DD (JST)。
 * @returns          有効トークンかつクラス可視なら `SignagePayload`、無効/不可視なら null。
 */
export async function getSignageDisplayData(
  classToken: string,
  date: string,
  designParam?: unknown,
): Promise<SignagePayload | null> {
  const cls = await resolveSignageClass(classToken);
  if (!cls) {
    return null;
  }

  // 解決した school のみを載せた匿名テナント文脈で 1 トランザクションを開き、共通ビルダーに委譲する
  // （実機の盤面と「実画面モニタの壁」が同一の payload ビルダーを使う＝単一ソース、見た目を一致させる）。
  return await withTenantContext(getDb(), { schoolId: cls.schoolId }, (tx: TenantTx) =>
    buildSignagePayloadForClass(tx, cls.schoolId, cls.classId, date, designParam),
  );
}

/**
 * **既に RLS テナント文脈が確立済みの `tx` 内で**、指定クラス・日付のサイネージ表示データ
 * (`SignagePayload`) を組み立てる共通ビルダー（実画面の盤面ビルダーの単一ソース）。
 *
 * 実機サイネージ（匿名公開・`getSignageDisplayData` が `withTenantContext` で開く tx）と、
 * 教員エディタの「実画面モニタの壁」（認証済み `withSession` の自校 RLS tx）の**両方が本関数を呼ぶ**ことで、
 * モニタの壁が実機と**同一のデータ・同一の見た目**になる（盤面ロジックを二重実装しない）。
 *
 * tx は呼び出し側が `app.current_school_id`（= `schoolId`）を set 済みであること。本関数は手書き
 * `WHERE school_id=?` を持たず、各 SELECT は RLS で自校に限定される（ルール2。`schoolId` は `getSignageWeather`
 * の prefecture 解決対象を特定するためだけに使い、RLS の代替にはしない）。空クラス（その日 daily_data 無し）は
 * 各セクションが空の payload を返す（盤面は placeholder を自然に描く）。クラスが（別テナント等で）不可視の
 * ときだけ `null`。
 *
 * @param tx          RLS テナント文脈確立済みのトランザクション（`withSession` / `withTenantContext`）。
 * @param schoolId    自校 id（tx の context と一致。`getSignageWeather` の prefecture 取得対象特定に使う）。
 * @param classId     表示対象クラス id（自校・RLS スコープ内であること）。
 * @param date        YYYY-MM-DD (JST)。
 * @param designParam 端末別デザイン上書き（`?design=patternN` 相当）。未指定/未知は学校レベル既定→pattern1。
 * @returns           クラス可視なら `SignagePayload`、不可視なら null。
 */
export async function buildSignagePayloadForClass(
  tx: TenantTx,
  schoolId: string,
  classId: string,
  date: string,
  designParam?: unknown,
): Promise<SignagePayload | null> {
  const daily = await getEffectiveDailyData(tx, classId, date);
  if (!daily) {
    // クラスが (別テナント等で) 不可視 → null。呼び出し側が無効扱い / 表示スキップにする。
    return null;
  }
  // デザインパターン解決（端末別 > 学校レベル既定 > pattern1、いずれも fail-soft）。
  // 端末別: `signage_url` の `?design=patternN` を TV がそのまま開き、本データ層に `designParam` として
  // 渡る（`tv_devices` スキーマ非変更で端末ごとに切替可能。design-pattern.ts 参照）。未指定/未知は
  // school_configs display_settings.signageDesign（学校レベル既定）へ、それも無ければ pattern1 に倒す。
  // 同一 tx 内・RLS 自校限定（ルール2）。読み取り失敗・不正値は parse 側で既定に倒れる（盤面を壊さない）。
  //
  // **パターンを先に解決する**理由: 盤面に出すブロックは `PATTERN_BLOCKS`（単一ソース）が決めるので、
  // パターン別ブロック（来校者/呼び出し/センサ/鉄道）の取得を `patternIncludesBlock` で出し分け、含まない
  // パターン（例 pattern1）では引かない＝無駄クエリを省く（単一ソースがデータ取得まで駆動・finding①）。
  const designPattern: SignageDesignPattern = isSignageDesignPattern(designParam)
    ? designParam
    : await getSignageDesignPattern(tx);
  const ads = await getEffectiveAdsForClass(tx, classId);
  // 予定グリッド (今後 3 平日)。`date` を起点に土日を飛ばした 3 平日ぶんの schedules を 1 クエリで取得
  // (v1 ScheduleGrid の nextThreeWeekdays 移植)。同一 tx 内なので追加コネクションは増やさない。
  const scheduleDays = await getEffectiveScheduleDays(tx, classId, signageScheduleDates(date, 3));
  // 天気は **fail-soft** (F14 §3 / NFR02): 自校地域の解決失敗・キャッシュ無し・読み取り例外が起きても
  // サイネージ本体 (予定/連絡/提出物/広告) は壊さず、weather=null で天気枠だけ落とす。同一 tx 内で読む
  // (effective-daily-data と同じテナント context) ので追加コネクションは増やさない。
  const weather = await getSignageWeather(tx, schoolId, date).catch(() => null);
  // このサイネージのクラス文脈（学科/学年/クラス名）。識別表示用（時刻横）。同一 tx・RLS 自校限定。
  // 取得失敗・不可視は全 null に倒れ、表示側が識別ラベルを出さないだけで盤面は壊さない（fail-soft）。
  const classContext = await getSignageClassContext(tx, classId);
  // 以下 4 つはパターン別ブロック（`PATTERN_BLOCKS` に含まれる時だけ取得）。含まないパターンでは取得せず
  // `null`＝盤面でも出さない（単一ソースがデータ取得を駆動）。取得する場合の失敗は従来どおり fail-soft で
  // null に倒し、ウィジェットは不在表示にする（盤面の他要素は壊さない）。同一 tx・RLS 自校限定（ルール2）。
  //
  // 「人感センサカウンタ」= このクラスの本日(JST=`date`)の presence 検知件数。
  const presenceCount = patternIncludesBlock(designPattern, "presence")
    ? await getTodayPresenceCount(tx, classId, date).catch(() => null)
    : null;
  // 「来校者一覧」= このクラスの当日(JST=`date`)の来校者を時刻順で取得。
  const visitors = patternIncludesBlock(designPattern, "visitor")
    ? await getVisitorsForClass(tx, classId, date).catch(() => null)
    : null;
  // 「生徒呼び出し」= このクラスの当日(JST=`date`)の呼び出しを時刻順で取得。実名表示の境界は ADR-034
  // （Vertex 非送信＝payload 直返しのみ）。
  const callouts = patternIncludesBlock(designPattern, "callout")
    ? await getCalloutsForClass(tx, classId, date).catch(() => null)
    : null;
  // 「鉄道」= 対象事業者（名鉄/笠松駅）の運行情報をキャッシュ（railway_status）から読む。端末は閉域
  // （名鉄サイト直叩きしない・ADR-035）。RLS read_all で匿名でも読める。
  const trainStatus = patternIncludesBlock(designPattern, "train")
    ? await getSignageRailwayStatus(tx).catch(() => null)
    : null;
  // 「工学ニュース」= 外部取得キャッシュ（news_items）の最新見出しを公開日降順で読む。端末は閉域（政府系/JST
  // の RSS 直叩きしない・ADR-043）。RLS read_all で匿名でも読める。取得失敗は空リスト（fail-soft）に倒す。
  // パターン非該当（pattern1）は引かず null（盤面でも出さない）。
  const news = patternIncludesBlock(designPattern, "news")
    ? await getSignageNews(tx).catch(() => ({ items: [], isStale: false }))
    : null;
  // 黒画面トグル（per-class・パターン非依存）。class スコープ display_settings.blackout を読む。同一 tx・
  // RLS 自校限定（ルール2）。読み取り失敗は false に倒し盤面を出す（fail-soft、黒画面で覆い隠さない）。
  const blackout = await getClassSignageBlackout(tx, classId).catch(() => false);
  return {
    date,
    designPattern,
    daily,
    scheduleDays,
    ads,
    weather,
    classContext,
    presenceCount,
    visitors,
    callouts,
    trainStatus,
    news,
    blackout,
  } satisfies SignagePayload;
}
