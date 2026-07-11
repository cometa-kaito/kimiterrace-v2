import { hashToken } from "@/lib/magic-link/token";
import {
  type ClassVisitor,
  type EffectiveAdForMonitor,
  type SignageClassContext,
  type StudentCallout,
  type TenantTx,
  getCalloutsForClass,
  getEffectiveAdsForClass,
  getEffectiveAdsForMonitor,
  getSignageClassContext,
  getTodayPresenceCount,
  getVisitorsForClass,
  resolveMagicLink,
  resolveTvDeviceByDeviceId,
  withTenantContext,
} from "@kimiterrace/db";
import { getDb } from "../db";
import { getClassSignageBlackout } from "./blackout";
import {
  type EffectiveDailyData,
  type ScheduleDay,
  getEffectiveDailyData,
  getEffectiveScheduleDays,
  mergeDailySections,
} from "./effective-daily-data";
import { type SignageHeatAlert, getSignageHeatAlerts } from "./heat-alerts";
import { type SignageNews, getSignageNews, getSignagePattern3News } from "./news";
import { patternIncludesBlock } from "./pattern-blocks";
import { type SignageRailwayStatus, getSignageRailwayStatus } from "./railway-status";
import {
  type AssignmentDeadlineFormat,
  parseAssignmentDeadlineFormat,
} from "./assignment-deadline-format";
import { signageScheduleDates } from "./rotation";
import {
  type SignageDesignPattern,
  getSchoolDisplaySettings,
  isSignageDesignPattern,
  parseSignageDesignPattern,
  signageScheduleDayCount,
} from "./signage-design";
import { type SignageWeather, getSignageWeather } from "./weather";
import { type SignageWeatherWarning, getSignageWeatherWarnings } from "./weather-warnings";

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
  /**
   * 提出物の期日表示形式（学校別設定・#1258 教員フィードバック対応③）。`school_configs`（scope='school',
   * kind='display_settings'）の `value.assignmentDeadlineFormat` を defensive にパースした値。盤面
   * （`AssignmentTable` の期限セル）が `until` のとき残り日数ラベルの代わりに「M/Dまで」を描く。未設定・
   * 不正値は既定 `daysLeft`（従来表示＝完全互換・fail-soft）。
   */
  assignmentDeadlineFormat: AssignmentDeadlineFormat;
  daily: EffectiveDailyData;
  /**
   * サイネージの「予定」列グリッド用（列数はパターン別 `SIGNAGE_SCHEDULE_DAY_COUNT` 単一ソース＝pattern1/2=3,
   * pattern3=5, pattern4=0）。`date` を起点に土日を飛ばした N 平日ぶんの実効「予定」セクション。連絡/課題/静粛
   * 時間は当日のみで足りるので `daily` 側に持つ (本配列は予定専用)。盤面 CSS の列数は描画時に `days.length` を
   * CSS 変数で流して自動追従させる（`SignageBoardView`）。
   */
  scheduleDays: ScheduleDay[];
  /**
   * 実効広告。クラス継承（`getEffectiveAdsForClass`）に加え、モニタ起点表示ではモニタ直指定も合成した
   * `EffectiveAdForMonitor`（= `EffectiveAd` から `classId` を除いた形）を持つ。クラス専用表示でも
   * `EffectiveAd[]` は構造的に代入可能（classId を盤面が使わないため型を広げても無影響・Phase5 v2-PR3）。
   */
  ads: EffectiveAdForMonitor[];
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
   * パターン2/4「時事ニュース」用、外部取得キャッシュ（news_items）の最新見出し（見出し+発表元+公開日+出典 URL）。
   * pattern1/pattern3 は使わない（pattern3 は 2026-06-20 にニュース枠を撤去）。**端末は閉域**で、バックエンド取得
   * Job が `news_items` にキャッシュした行を読むだけ（政府系/JST の公開 RSS を直叩きしない・ADR-043）。RLS read_all
   * で匿名でも読める。**本文は持たず転載しない**（著作権方針）。記事無し・取得失敗は `items: []`（ウィジェットは
   * 「ニュースを取得できていません」表示＝fail-soft）。`null` はパターン非該当（pattern1/pattern3）で取得していない
   * ことを表す。
   */
  news: SignageNews | null;
  /**
   * pattern1/pattern4「防災・安全」帯用、自校地域の**気象警報・注意報**（ADR-044）。pattern2/3 は使わない（null）。
   * **端末は閉域**で、バックエンド天気 Job が `weather_warnings` にキャッシュした行（公開・非 PII の地域警報）を
   * 読むだけ（JMA bosai を直叩きしない）。RLS read_all で匿名でも読める。地域未解決・キャッシュ無し・取得失敗は
   * `null`（帯ごと非表示＝fail-soft、盤面の他要素は壊さない）。`maxLevel='none'`（行はあるが警報なし）は非 null で
   * 返り、**帯を目立たせるか否か（アクティブ判定）は表示側**が `maxLevel≠'none'` で決める。
   */
  weatherWarnings: SignageWeatherWarning | null;
  /**
   * pattern1/pattern4「防災・安全」帯用、自校地域の**熱中症警戒アラート / WBGT**（ADR-044）。pattern2/3 は使わない（null）。
   * **端末は閉域**で、バックエンド天気 Job が `heat_alerts` にキャッシュした行（公開・非 PII の地域アラート）を
   * 読むだけ（環境省を直叩きしない）。RLS read_all で匿名でも読める。地域未解決・キャッシュ無し・取得失敗は
   * `null`（帯ごと非表示＝fail-soft）。`alertLevel='none'`（行はあるがアラートなし）は非 null で返り、**帯を
   * 目立たせるか否か（アクティブ判定）は表示側**が `alertLevel≠'none'` で決める。
   */
  heatAlerts: SignageHeatAlert | null;
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
 * @param monitorId   （Phase5 v2-PR3）指定すると、クラス継承広告に加え当該モニタへの**直指定広告**も合成して
 *                    返す（`getEffectiveAdsForMonitor`＝追加モード）。未指定はクラス専用（従来挙動・完全互換）。
 * @returns           クラス可視なら `SignagePayload`、不可視なら null。
 */
export async function buildSignagePayloadForClass(
  tx: TenantTx,
  schoolId: string,
  classId: string,
  date: string,
  designParam?: unknown,
  monitorId?: string,
): Promise<SignagePayload | null> {
  const daily = await getEffectiveDailyData(tx, classId, date);
  if (!daily) {
    // クラスが (別テナント等で) 不可視 → null。呼び出し側が無効扱い / 表示スキップにする。
    return null;
  }
  // 学校スコープ display_settings（opaque JSONB）は **1 回だけ**読み、学校レベル既定デザイン
  // （signageDesign）と提出物の期日表示形式（assignmentDeadlineFormat・#1258）の両方をここから defensive に
  // パースする（新規 round-trip を増やさない）。同一 tx 内・RLS 自校限定（ルール2）。読み取り失敗・不正値は
  // 各 parse が既定に倒す（盤面を壊さない）。
  const displaySettings = await getSchoolDisplaySettings(tx);
  const assignmentDeadlineFormat = parseAssignmentDeadlineFormat(displaySettings);
  // デザインパターン解決（端末別 > 学校レベル既定 > pattern1、いずれも fail-soft）。
  // 端末別: `signage_url` の `?design=patternN` を TV がそのまま開き、本データ層に `designParam` として
  // 渡る（`tv_devices` スキーマ非変更で端末ごとに切替可能。design-pattern.ts 参照）。未指定/未知は
  // school_configs display_settings.signageDesign（学校レベル既定）へ、それも無ければ pattern1 に倒す。
  //
  // **パターンを先に解決する**理由: 盤面に出すブロックは `PATTERN_BLOCKS`（単一ソース）が決めるので、
  // パターン別ブロック（来校者/呼び出し/センサ/鉄道）の取得を `patternIncludesBlock` で出し分け、含まない
  // パターン（例 pattern1）では引かない＝無駄クエリを省く（単一ソースがデータ取得まで駆動・finding①）。
  const designPattern: SignageDesignPattern = isSignageDesignPattern(designParam)
    ? designParam
    : parseSignageDesignPattern(displaySettings);
  // 広告: monitorId 指定時はクラス継承 ∪ モニタ直指定（追加モード）、未指定はクラス継承のみ（従来）。
  const ads = monitorId
    ? await getEffectiveAdsForMonitor(tx, classId, monitorId)
    : await getEffectiveAdsForClass(tx, classId);
  // 予定グリッド (今後 N 平日)。表示日数（= 盤面の列数）は**パターン別**に `SIGNAGE_SCHEDULE_DAY_COUNT`
  // （design-pattern.ts）が単一ソース＝そこを変えればデータ取得日数と CSS 列数が同時に追従する。pattern1/2=3、
  // pattern3（廊下版）=5、pattern4=0（予定を描画しないので取得もしない）。`date` を起点に土日を飛ばした N 平日
  // ぶんを 1 クエリで取得（列数を変えても日付配列を渡すだけ＝追加コネクション・往復は増やさない）。連絡/提出物/
  // 自動ブロックの取得範囲は不変。
  const scheduleDays = await getEffectiveScheduleDays(
    tx,
    classId,
    signageScheduleDates(date, signageScheduleDayCount(designPattern)),
  );
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
  // 「時事ニュース」= 外部取得キャッシュ（news_items）を読む。端末は閉域（政府系/JST の RSS 直叩きしない・
  // ADR-043）。RLS read_all で匿名でも読める。取得失敗は空リスト（fail-soft）に倒す。news ブロックを持つのは
  // pattern2/3/4（pattern1 は対象外）。pattern3 廊下フッタだけは要約優先＋不足時のみ見出し補完で鮮度を保つ
  // （getSignagePattern3News）、pattern2/4 は最新 N 件（getSignageNews）。
  const news = patternIncludesBlock(designPattern, "news")
    ? await (designPattern === "pattern3" ? getSignagePattern3News(tx) : getSignageNews(tx)).catch(
        () => ({ items: [], isStale: false }),
      )
    : null;
  // 「防災・安全」= 自校地域の気象警報・注意報 + 熱中症警戒アラートをキャッシュ（weather_warnings / heat_alerts）
  // から読む。端末は閉域（JMA / 環境省を直叩きしない・ADR-044）。RLS read_all で匿名でも読める。pattern1/pattern4
  // が取得（pattern2/3 は null で盤面に出さない）。取得失敗・地域未解決・行無しは null に倒し帯ごと出さない
  // （fail-soft、安全情報でも盤面の他要素は壊さない）。同一 tx・天気と同じ prefecture 解決を使う。
  const weatherWarnings = patternIncludesBlock(designPattern, "safety_alert")
    ? await getSignageWeatherWarnings(tx, schoolId).catch(() => null)
    : null;
  const heatAlerts = patternIncludesBlock(designPattern, "safety_alert")
    ? await getSignageHeatAlerts(tx, schoolId, date).catch(() => null)
    : null;
  // 黒画面トグル（per-class・パターン非依存）。class スコープ display_settings.blackout を読む。同一 tx・
  // RLS 自校限定（ルール2）。読み取り失敗は false に倒し盤面を出す（fail-soft、黒画面で覆い隠さない）。
  const blackout = await getClassSignageBlackout(tx, classId).catch(() => false);
  return {
    date,
    designPattern,
    assignmentDeadlineFormat,
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
    weatherWarnings,
    heatAlerts,
    blackout,
  } satisfies SignagePayload;
}

/**
 * モニタ起点（`device_id` 解決）のサイネージ表示データを取得する（Phase5 v2-PR3）。
 *
 * `getSignageDisplayData`（classToken 起点）の姉妹。端末の `signage_url` が classToken でなく device_id を
 * 持つ経路（廊下等クラス無し端末／自端末への直指定広告を上乗せ表示する端末）で使う。device_id を **cross-tenant
 * に解決**し（`resolveTvDeviceByDeviceId`・system_admin 文脈・read 専用）、得た `schoolId` だけで改めて
 * **自校テナント文脈**を開いて payload を組む（system_admin 文脈は表示読取に持ち越さない＝ルール2）。
 *
 * - クラス所属端末: クラス payload（時間割/連絡/…）＋ **クラス継承 ∪ 自端末直指定** の広告（追加モード）。
 * - クラス無し端末（廊下）: クラス系セクションは空・広告は **自端末直指定のみ**（ads-only 盤面）。
 *
 * device_id は credential ではないが推測不能 UUID（ADR-022）なので、ログには出さない方針を踏襲する。
 *
 * @returns 解決でき可視なら `SignagePayload`、未登録/退役/不可視なら null（呼び出し側が無効表示にする）。
 */
export async function getSignageDisplayDataForMonitor(
  deviceId: string,
  date: string,
  designParam?: unknown,
): Promise<SignagePayload | null> {
  const dev = await resolveTvDeviceByDeviceId(getDb(), deviceId);
  if (!dev) {
    return null;
  }
  // 解決した school のみを載せた匿名テナント文脈で payload を組む（classToken 経路と同じ単一ソースの盤面ビルダー）。
  return await withTenantContext(getDb(), { schoolId: dev.schoolId }, (tx: TenantTx) =>
    dev.classId
      ? buildSignagePayloadForClass(tx, dev.schoolId, dev.classId, date, designParam, dev.monitorId)
      : buildSignagePayloadForMonitorOnly(
          tx,
          dev.schoolId,
          dev.monitorId,
          dev.label,
          date,
          designParam,
        ),
  );
}

/**
 * クラスに属さないモニタ（廊下等・classId 無し）の **ads-only** サイネージ payload を組む（Phase5 v2-PR3）。
 *
 * クラス系セクション（時間割/連絡/課題/来校者/呼び出し/センサ/黒画面）は持てない（クラスが無い）ため空にし、
 * 広告は当該モニタへの**直指定のみ**（`getEffectiveAdsForMonitor(tx, null, monitorId)`）。学校レベルのウィジェット
 * （天気/ニュース/鉄道）は classToken 版と同規約（天気は常時・他はパターン該当時）で fail-soft に読む。盤面の識別
 * ラベルにはモニタの設置場所名（`monitorLabel`・例「廊下」）を使う。`buildSignagePayloadForClass` が `daily` 不在で
 * null を返す挙動とは異なり、ads-only でも**必ず payload を返す**（廊下の広告表示が成立する）。
 *
 * tx は呼び出し側が `schoolId` の RLS 文脈を確立済みであること（ルール2）。
 */
async function buildSignagePayloadForMonitorOnly(
  tx: TenantTx,
  schoolId: string,
  monitorId: string,
  monitorLabel: string | null,
  date: string,
  designParam?: unknown,
): Promise<SignagePayload> {
  // display_settings は 1 回読んで学校既定デザインと期日表示形式の両方をパースする（classToken 版と同規約）。
  const displaySettings = await getSchoolDisplaySettings(tx);
  const designPattern: SignageDesignPattern = isSignageDesignPattern(designParam)
    ? designParam
    : parseSignageDesignPattern(displaySettings);
  const ads = await getEffectiveAdsForMonitor(tx, null, monitorId);
  // 天気は学校地域単位（クラス非依存）。fail-soft（取得失敗は null で枠だけ落とす）。
  const weather = await getSignageWeather(tx, schoolId, date).catch(() => null);
  // 鉄道/ニュースは学校横断の公開キャッシュ（read_all・クラス非依存）。パターン該当時のみ・fail-soft。
  const trainStatus = patternIncludesBlock(designPattern, "train")
    ? await getSignageRailwayStatus(tx).catch(() => null)
    : null;
  // pattern3 廊下フッタは要約優先＋不足時のみ見出し補完（getSignagePattern3News）、pattern2/4 は最新 N 件。
  const news = patternIncludesBlock(designPattern, "news")
    ? await (designPattern === "pattern3" ? getSignagePattern3News(tx) : getSignageNews(tx)).catch(
        () => ({ items: [], isStale: false }),
      )
    : null;
  // 防災・安全帯（気象警報/熱中症）は学校地域単位（クラス非依存）。クラス版と同規約で safety_alert
  // パターン該当時のみ・fail-soft。廊下端末でも防災情報は出す価値があるため同様に読む。
  const weatherWarnings = patternIncludesBlock(designPattern, "safety_alert")
    ? await getSignageWeatherWarnings(tx, schoolId).catch(() => null)
    : null;
  const heatAlerts = patternIncludesBlock(designPattern, "safety_alert")
    ? await getSignageHeatAlerts(tx, schoolId, date).catch(() => null)
    : null;
  return {
    date,
    designPattern,
    assignmentDeadlineFormat: parseAssignmentDeadlineFormat(displaySettings),
    // クラスが無いので日次は空（mergeDailySections([]) が全セクション空の EffectiveDailyData を返す）。
    daily: mergeDailySections(date, []),
    scheduleDays: [],
    ads,
    weather,
    // クラス文脈は無いので設置場所名を識別ラベルに充てる（学年/学科は null）。
    classContext: { className: monitorLabel, gradeName: null, departmentName: null },
    presenceCount: null,
    visitors: null,
    callouts: null,
    trainStatus,
    news,
    weatherWarnings,
    heatAlerts,
    blackout: false,
  } satisfies SignagePayload;
}
