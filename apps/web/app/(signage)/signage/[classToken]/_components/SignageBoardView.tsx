import { formatClassIdentity } from "@/lib/signage/class-identity";
import type { MergedSection, ScheduleDay } from "@/lib/signage/effective-daily-data";
import { isSpecialSlot, scheduleSlotSortKey } from "@/lib/editor/schedule-core";
import {
  DEFAULT_SIGNAGE_DESIGN_PATTERN,
  type SignageDesignPattern,
} from "@/lib/signage/design-pattern";
import {
  type SignageScheduleRow,
  formatSignageItem,
  parseAssignmentRow,
  parseScheduleRow,
} from "@/lib/signage/section-format";
import type { HeatAlertLevel, WarningLevel } from "@kimiterrace/db/schema";
import type { SignageHeatAlert } from "@/lib/signage/heat-alerts";
import { formatNewsDate, formatNewsUrl } from "@/lib/signage/news-format";
import type { SignagePayload } from "@/lib/signage/signage-display";
import type { SignageWeather, WeatherDay, WeatherIcon } from "@/lib/signage/weather";
import type { SignageWeatherWarning } from "@/lib/signage/weather-warnings";
import { AutoScroll } from "./AutoScroll";
import { NewsCarousel } from "./NewsCarousel";
import {
  BoardRegionEditButton,
  type EditRegion,
  type EditRegionsProps,
} from "./BoardRegionEditButton";
import editStyles from "./BoardRegionEditButton.module.css";
import { Pattern3NewsTicker } from "./Pattern3NewsTicker";
import styles from "./signage.module.css";

/**
 * サイネージ盤面の**純粋な描画層** (F・盤面ビューの再利用部品化)。`SignageClient`（再生制御 Client Island）が
 * 持っていた盤面の描画関数群（`Pattern1Board`/`Pattern2Board`/`BoardHeader`/`AdAside`/`ScheduleGrid`/
 * `NoticeList`/`AssignmentTable`/`Pattern2*` と描画専用ヘルパ）を **hooks/state/effect を一切持たない**形で
 * 切り出したもの。同一の `signage.module.css` を使い**クラス名は変えない**（既存 SignageClient.test の
 * region ドリフトガードを壊さないため＝実機サイネージの表示挙動は不変）。
 *
 * - **実機サイネージ（TV）**: `SignageClient` がポーリング/実時計/広告ローテーション/テレメトリ/blackout 等の
 *   再生制御を担い、確定状態を `SignageBoardView` に渡して描く（描画の移譲のみ・挙動不変）。
 * - **静的再利用（サムネ / エディタキャンバス）**: `ScaledSignageBoard` がスナップショット `SignagePayload` から
 *   `now=null`（時計非表示）・広告静止・タップ noop で `SignageBoardView` を縮小描画する（後続 A/B の土台）。
 *
 * **盤面レイアウトは旧キミテラス v1 を忠実移植**: 上段(横幅いっぱい)=予定(今後 N 平日の N 列・列数は
 * パターン別 `SIGNAGE_SCHEDULE_DAY_COUNT` 単一ソース＝pattern1 は 3・各列5行) /
 * 左下=連絡(5行) / 右下=提出物(表・5行) / 右=広告(70:30)。天気は予定列の日付ヘッダーにアイコンで内包し、
 * 静粛時間は盤面に出さない(2026-06-06 ユーザー確定)。
 *
 * 本モジュールは `"use client"` を**付けない**（hooks/effect を持たないので Server Component からも描画可能）。
 * 親（`SignageClient`）が client island のため実機経路では client として評価されるが、`ScaledSignageBoard`
 * 経由のサーバー描画も許容する設計。
 */
const MIN_ROWS = 5;

/**
 * 実セクション（予定 / 連絡 / 提出物の `<section>`）に編集モードを適用する属性を計算する純ヘルパ。
 *
 * - **非編集（`editRegions` 不在）**: `{ className: baseClass, "aria-label": ariaLabel }` を返す＝呼び出し側は従来
 *   どおり region 名付きで描く＝**出力は完全に不変**（live TV / モニタの壁を 1px も変えない）。`hideHeading=false`。
 * - **編集モード**: 実セクションを編集ボタンの配置基準にする `regionHost` を base クラスへ足し、section の
 *   `aria-label` を**外す**（＝named region landmark を消す。`role="region"` 名「予定/連絡/提出物」が編集器側 region と
 *   二重化しない）。**section 自体は `aria-hidden` にしない**（内側の編集ボタンを AT に残すため）。代わりに装飾見出し
 *   （h2）は呼び出し側が `hideHeading` で個別に `aria-hidden` 化し、`role="heading"`「連絡/提出物」が編集器見出し・
 *   既存 e2e の strict locator と二重化しないようにする。領域のアクセシブルな操作名は内側の編集ボタンの
 *   `aria-label="○○を編集"` が一手に担う。
 *
 * 返す `button` は編集モード時のみ JSX（実セクションの内側に置く）。非編集時は `null`＝何も描かない。
 */
function regionEditProps(
  region: EditRegion,
  // CSS module の class 参照は `string | undefined`（noUncheckedIndexedAccess）。そのまま受けて className に通す。
  baseClass: string | undefined,
  ariaLabel: string,
  editRegions: EditRegionsProps | undefined,
): {
  /** 実セクション `<section>` に展開する属性。非編集は region 名付き、編集モードは名前を外し host クラスを足す。 */
  sectionProps: { className: string; "aria-label"?: string };
  /** 編集モードでは装飾見出し（h2）を AT から隠すため `aria-hidden` を付ける。 */
  hideHeading: boolean;
  button: React.JSX.Element | null;
} {
  const base = baseClass ?? "";
  if (!editRegions) {
    return {
      sectionProps: { className: base, "aria-label": ariaLabel },
      hideHeading: false,
      button: null,
    };
  }
  return {
    // 編集モード: region 名（aria-label）を外して named landmark を消し、配置基準 regionHost を足す。
    // section 自体は aria-hidden にしない（内側の編集ボタンを操作可能に保つ）。可視テキスト・見た目は不変。
    sectionProps: { className: `${base} ${editStyles.regionHost}` },
    hideHeading: true,
    button: <BoardRegionEditButton region={region} editRegions={editRegions} />,
  };
}

/** 各デザインパターンの盤面が受け取る共通 props（再生制御は `SignageClient` 側、盤面は表示のみ）。 */
export type SignageBoardProps = {
  data: SignagePayload;
  ad: SignagePayload["ads"][number] | null;
  adLink: string | null;
  adCount: number;
  safeIndex: number;
  now: Date | null;
  onAdTap: (adId: string, slotIndex: number) => void;
  /**
   * **WYSIWYG「盤面を編集」の実エリア直接クリック配線**（Approach A・任意）。`undefined`（既定）なら出力は
   * **完全に不変**＝live TV（`SignageClient`）/ モニタの壁（`ScaledSignageBoard` 編集モード無し）は 1px も変えない。
   * 渡るのは WYSIWYG エディタ（client）からのみ。渡された時だけ、実セクション（予定 / 連絡 / 提出物）を
   * `position: relative` 化し `inset:0` の編集ボタンを内側に敷く（実描画要素そのものを覆う＝％近似のズレ無し）。
   * 編集モード時は盤面内部の装飾見出し（h2）/ region 名を AT から隠し、操作名は編集ボタンの `aria-label` が担う
   * （編集器側の見出し・既存 e2e の strict locator と二重化しない）。
   */
  editRegions?: EditRegionsProps;
};

/**
 * デザインパターン → 盤面コンポーネントの対応（**単一ソース**・デザインの拡張点）。`pattern1` = 旧キミテラス
 * v1 レイアウト（既定）/ `pattern2` = 予定・来校者・呼び出し・センサ・天気・鉄道の掲示盤面。**新パターン追加＝
 * ここに 1 行**足すだけで dispatch が追従する（`PATTERN_BLOCKS`（どのブロックを出すか）と同じ作法で、盤面の
 * 選択も `switch`/`if` のハードコード分岐を作らない・finding①）。出すブロックの集合は `PATTERN_BLOCKS` 側が
 * 単一ソースで持ち、本マップは「どのレイアウトで描くか」を持つ（両者は SignageClient.test の region ドリフト
 * ガードで一致を機械担保）。
 */
const PATTERN_BOARDS: Record<
  SignageDesignPattern,
  (props: SignageBoardProps) => React.JSX.Element
> = {
  pattern1: Pattern1Board,
  pattern2: Pattern2Board,
  // pattern3 = pattern2 の掲示盤面を「廊下設置」向けにデザイン最適化した版（pattern2 から時事ニュースを除く）。
  pattern3: Pattern3Board,
  // pattern4 = 教員入力最小（連絡のみ編集）・天気/ニュースを主役にした自動寄りの盤面。
  pattern4: Pattern4Board,
};

/**
 * 盤面ビューの公開エントリ。学校 / 端末が選んだデザインパターンに応じた盤面を描画する。未知 / 将来パターン
 * （型外の値が来た場合の保険）は既定 `pattern1` にフォールバックして必ず描画する（fail-soft、盤面を壊さない）。
 * 再生制御（ポーリング/ローテーション/テレメトリ/時計）は `SignageClient` が持ち、本ビューは表示専用で共通
 * props を受け取る。広告（右）と上部ヘッダーは両パターン共通。
 */
export function SignageBoardView(props: SignageBoardProps) {
  const Board =
    PATTERN_BOARDS[props.data.designPattern] ?? PATTERN_BOARDS[DEFAULT_SIGNAGE_DESIGN_PATTERN];
  return <Board {...props} />;
}

/** 全盤面共通のヘッダー帯（暗色）: 盤面日付 + 曜日 + 実時計 + クラス識別（#243）+ ブランディング。 */
function BoardHeader({ data, now }: { data: SignagePayload; now: Date | null }) {
  const { dateText, dayText } = formatBoardDate(data.date);
  const time = now ? formatClock(now) : "";
  // #243: このサイネージの識別ラベル（学科 学年 クラス）。時刻の横に出してどの端末か判別できるようにする。
  const classIdentity = formatClassIdentity(data.classContext);
  return (
    <header className={styles.adHeader}>
      <span className={styles.dateText}>{dateText}</span>
      <span className={styles.dayBadge}>{dayText}</span>
      {time ? <span className={styles.timeText}>{time}</span> : null}
      {classIdentity ? (
        <span className={styles.classIdentity} aria-label={`表示クラス: ${classIdentity}`}>
          {classIdentity}
        </span>
      ) : null}
      <span className={styles.headerBranding}>キミテラス by Rebounder</span>
    </header>
  );
}

/**
 * 全盤面共通の広告エリア（右 30%・暗色ゾーン + ぼかし背景 + 前景 media + キャプション + ドット）。
 * パターン2 でも「右側の広告はパターン1と同じ」（ユーザー指定）。再生制御は SignageClient が持ち、本部品は
 * 現在広告とタップ配線（#43 / F07）を受け取って描画する。
 */
function AdAside({
  ad,
  adLink,
  adCount,
  safeIndex,
  onAdTap,
  editRegions,
}: {
  ad: SignageBoardProps["ad"];
  adLink: string | null;
  adCount: number;
  safeIndex: number;
  onAdTap: SignageBoardProps["onAdTap"];
  /**
   * 編集モード（WYSIWYG エディタ）か否か。**渡るのはエディタプレビューのときだけ**で、live TV / モニタの壁は
   * undefined＝出力不変。編集モードかつ広告未設定のときだけ、空の広告枠に「広告枠（広告管理で設定）」の
   * 明示ラベルを出し、教員が黒帯を「壊れ／未表示」と誤認するのを防ぐ（指摘 v2-ed-ai5）。live TV では従来どおり
   * 控えめなウォーターマーク（`.adArea::after`）のままにし、実機の見た目は 1px も変えない。
   */
  editRegions?: EditRegionsProps;
}) {
  const hasMedia = ad != null;
  // 編集モード（editRegions あり）かつ広告未設定のときだけ、空枠が「広告の場所」だと分かるラベルを出す。
  const showEmptyLabel = editRegions != null && !hasMedia;
  return (
    <aside
      aria-label="広告"
      className={`${styles.adArea} ${hasMedia ? styles.adAreaHasMedia : ""}`}
    >
      {ad ? (
        adLink ? (
          // 広告領域**全体**をタップで遷移（管理で設定した linkUrl）。新規タブ + reverse tabnabbing
          // 防止 (noopener noreferrer)。タップで tap テレメトリを送る（遷移は阻害しない）。adId は
          // ingest 側で当該クラスの実効広告に実在照合される（水増しは DB 層でも弾く）。
          <a
            href={adLink}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.adAreaLink}
            aria-label={ad.caption ? `広告: ${ad.caption}` : "広告を開く"}
            onClick={() => onAdTap(ad.adId, safeIndex)}
          >
            <AdInner ad={ad} />
          </a>
        ) : (
          <AdInner ad={ad} />
        )
      ) : (
        <div className={styles.adContainer}>
          <div className={styles.adForeground}>
            {showEmptyLabel ? (
              // 編集モードだけのプレースホルダ（live TV では出ない）。黒帯を「広告の入る場所」と明示する。
              <p className={styles.adEditorPlaceholder}>
                <span className={styles.adEditorPlaceholderTitle}>広告枠</span>
                <span className={styles.adEditorPlaceholderSub}>広告管理で設定します</span>
              </p>
            ) : (
              <p className={styles.adEmpty}>　</p>
            )}
          </div>
        </div>
      )}
      {adCount > 1 ? <Dots count={adCount} active={safeIndex} /> : null}
    </aside>
  );
}

/**
 * パターン1: 旧キミテラス v1 レイアウト盤面（既定）。
 *   上段（横幅いっぱい）= 予定（今後3平日の3列5行）/ 左下 = 連絡 / 右下 = 提出物（表）/ 右 = 広告（70:30）/
 *   天気は予定列の日付横。`pattern1`（既定）選択時に描画される。
 */
function Pattern1Board({
  data,
  ad,
  adLink,
  adCount,
  safeIndex,
  now,
  onAdTap,
  editRegions,
}: SignageBoardProps) {
  return (
    <div className={styles.signageRoot}>
      <BoardHeader data={data} now={now} />
      <div className={styles.container}>
        <main className={styles.infoArea}>
          {/* 防災・安全帯（ADR-044）: アクティブな警報/熱中症がある時だけ予定の直上（最上部）に出す。
              無アラート時は SafetyAlertBand が null を返し帯ごと出ない＝予定以下の既存レイアウトは不変。 */}
          <SafetyAlertBand
            warning={data.weatherWarnings ?? null}
            heatAlert={data.heatAlerts ?? null}
          />
          <div className={styles.contentGrid}>
            <ScheduleGrid
              days={data.scheduleDays}
              today={data.date}
              weather={data.weather ?? null}
              editRegions={editRegions}
            />
            <NoticeList section={data.daily.notices} editRegions={editRegions} />
            <AssignmentTable
              section={data.daily.assignments}
              today={data.date}
              editRegions={editRegions}
            />
          </div>
        </main>
        <AdAside
          ad={ad}
          adLink={adLink}
          adCount={adCount}
          safeIndex={safeIndex}
          onAdTap={onAdTap}
          editRegions={editRegions}
        />
        {/* モバイル限定フッター（順序: タブ→広告→予定→連絡→提出物→フッター）。デスクトップは非表示。 */}
        <footer className={styles.mobileFooter}>キミテラス by Rebounder</footer>
      </div>
    </div>
  );
}

/**
 * パターン2: 掲示盤面（予定 / 生徒呼び出し / 来校者一覧 / 鉄道 / 人感センサ）。右側の広告はパターン1と同一
 * （`AdAside` 共有・ユーザー指定）。
 *
 * **レイアウトは「優先順位 = 面積」の縦 3 段構成**（2026-06-13 ユーザーとデザイン確定）:
 *   第1段 = 予定（主役・横幅いっぱい・今後3平日の3列・天気を日付ヘッダーにアイコンで内包）
 *   第2段 = 人に関わる情報（生徒呼び出し ＋ 来校者一覧 を 2 列で対に）
 *   第3段 = ステータス帯（鉄道 ＋ 人感センサを小さく 2 列。指標が予定より目立つ逆転を避け降格）
 * 旧 2 列均質グリッドの「右下空きセル」を解消し、面積で素直に優先順位を表す。各ウィジェットは取得失敗・
 * 不在を fail-soft 表示にする（盤面を壊さない）。
 */
function Pattern2Board({
  data,
  ad,
  adLink,
  adCount,
  safeIndex,
  now,
  onAdTap,
  editRegions,
}: SignageBoardProps) {
  return (
    <div className={styles.signageRoot}>
      <BoardHeader data={data} now={now} />
      <div className={styles.container}>
        <main className={styles.infoArea}>
          <div className={styles.p2Grid}>
            <Pattern2Schedule
              days={data.scheduleDays}
              today={data.date}
              weather={data.weather ?? null}
              editRegions={editRegions}
            />
            <div className={styles.p2People}>
              <Pattern2Callouts callouts={data.callouts} editRegions={editRegions} />
              <Pattern2Visitors visitors={data.visitors} editRegions={editRegions} />
            </div>
            <div className={styles.p2Status}>
              <Pattern2Train train={data.trainStatus} />
              <Pattern2SensorCount count={data.presenceCount} />
            </div>
            <Pattern2News news={data.news} />
          </div>
        </main>
        <AdAside
          ad={ad}
          adLink={adLink}
          adCount={adCount}
          safeIndex={safeIndex}
          onAdTap={onAdTap}
          editRegions={editRegions}
        />
        <footer className={styles.mobileFooter}>キミテラス by Rebounder</footer>
      </div>
    </div>
  );
}

/**
 * パターン3: 廊下設置に最適化した掲示盤面。**表示ブロック・データ・順序・広告は pattern2 から時事ニュースを
 * 除いたもの**（廊下運用ではニュース枠を外し予定・人物情報に集中・2026-06-20 ユーザー確定）で、廊下の
 * 「通り過ぎながら遠目で一瞥」に効く**デザイン層**を足す版（2026-06-17 ベース）:
 *   (1) 時刻を主役にした大型ヘッダー（{@link Pattern3Header}）— 通行者が最も見る情報を最大化。
 *   (2) 主要テキスト（予定／氏名／鉄道／センサ）を遠距離可読まで拡大（CSS `.p3Root` の上書き）。
 *   (3) 「今日」列を枠で面強調 ＋ 週間天気帯（{@link Pattern3WeeklyWeather}）。
 * 盤面の各リージョン（予定／呼び出し／来校者／鉄道／センサ）と広告は **pattern2 の部品をそのまま再利用**し、
 * region aria-label・fail-soft・編集配線・ドリフトガード（SignageClient.test）・データ取得ゲートを共有する
 * （DRY。pattern2 は無改修＝既存教室端末は不変）。差分はラッパの `p3Root` クラス・専用ヘッダー・週間天気帯・
 * 時事ニュース非表示（`PATTERN_BLOCKS.pattern3` から news を外したので {@link Pattern2News} を呼ばない）。
 */
function Pattern3Board({
  data,
  ad,
  adLink,
  adCount,
  safeIndex,
  now,
  onAdTap,
  editRegions,
}: SignageBoardProps) {
  return (
    <div className={`${styles.signageRoot} ${styles.p3Root}`}>
      <Pattern3Header data={data} now={now} />
      <div className={styles.container}>
        <main className={styles.infoArea}>
          <div className={styles.p2Grid}>
            <Pattern3WeeklyWeather weather={data.weather ?? null} today={data.date} />
            <Pattern3Schedule
              days={data.scheduleDays}
              today={data.date}
              editRegions={editRegions}
            />
            <div className={styles.p2People}>
              <Pattern3Callouts callouts={data.callouts} editRegions={editRegions} />
              <Pattern3Visitors visitors={data.visitors} editRegions={editRegions} />
            </div>
            <Pattern3Footer
              news={data.news}
              train={data.trainStatus}
              presenceCount={data.presenceCount}
            />
          </div>
        </main>
        <AdAside
          ad={ad}
          adLink={adLink}
          adCount={adCount}
          safeIndex={safeIndex}
          onAdTap={onAdTap}
          editRegions={editRegions}
        />
        <footer className={styles.mobileFooter}>キミテラス by Rebounder</footer>
      </div>
    </div>
  );
}

/**
 * パターン4: **教員入力を最小化した自動寄りの盤面**（pattern3 の対）。天気・ニュースを主役の自動コンテンツに
 * 据え、教員が入力するのは**連絡（フリーワード）のみ**。それ以外は全自動／API（防災・安全＝条件付き帯／鉄道／
 * 人感センサ／広告）で教員入力ゼロ（2026-06-20 ユーザー確定）。**予定・呼び出し・来校者・提出物は出さない**
 * （`PATTERN_BLOCKS.pattern4` に含めない＝`editableBlocksForPattern` は `[notice]` のみ）。
 *
 * 盤面の各リージョン（連絡／時事ニュース／鉄道／人感センサ）・防災帯・広告は **既存部品をそのまま再利用**し、
 * region aria-label・fail-soft・ドリフトガード（SignageClient.test）・データ取得ゲートを共有する（DRY。pattern1/2/3
 * は無改修）。差分はラッパ `p4Root` クラス・縦積みの `p4Grid` レイアウト・天気ヒーロー（{@link Pattern4WeatherHero}）・
 * 大型ヘッダー（pattern3 流用）のみ。連絡だけ `editRegions` を渡す（WYSIWYG「盤面を編集」で連絡のみクリック編集可）。
 *
 * ヘッダーは **pattern3 の大型ヘッダー（`Pattern3Header`・時刻主役）を流用**（2026-06-20 ユーザー指示）。盤面の
 * `--header-height` は `.p4Root` でも 58px に上書きして大型ヘッダー分の上余白を確保する（CSS 参照）。
 */
function Pattern4Board({
  data,
  ad,
  adLink,
  adCount,
  safeIndex,
  now,
  onAdTap,
  editRegions,
}: SignageBoardProps) {
  return (
    <div className={`${styles.signageRoot} ${styles.p4Root}`}>
      <Pattern3Header data={data} now={now} />
      <div className={styles.container}>
        <main className={styles.infoArea}>
          <div className={styles.p4Grid}>
            {/* 防災・安全帯（ADR-044）: アクティブな警報/熱中症がある時だけ最上部に出す（無い時は帯ごと出ない）。 */}
            <SafetyAlertBand
              warning={data.weatherWarnings ?? null}
              heatAlert={data.heatAlerts ?? null}
            />
            {/* 主役①: 天気ヒーロー（日付/曜日/天気マークを主・気温/降水を従に・本日以降7日）。fail-soft で null。 */}
            <Pattern4WeatherHero weather={data.weather ?? null} today={data.date} />
            {/* 主役②: 時事ニュース（自動取得キャッシュ・ADR-043）。pattern4 は 1 記事ずつ横スライドのカルーセル
                で見せ、CC BY ソース（経産省 METI）の公式要約（先頭文抽出）を添える（showSummary・carousel）。 */}
            <Pattern2News news={data.news} showSummary carousel />
            {/* 下段（2026-06-20 ユーザー指示）: 連絡は横長だと読みにくいので左に縦長で大きく、鉄道・人感センサは
                右に縦積みで小さく。連絡は唯一の教員入力（editRegions でクリック編集可）で、一定数を超えたら
                オートスクロールで全件見せる（scroll）。 */}
            <div className={styles.p4Bottom}>
              <NoticeList section={data.daily.notices} editRegions={editRegions} scroll />
              <div className={styles.p4SideStatus}>
                <Pattern2Train train={data.trainStatus} />
                <Pattern2SensorCount count={data.presenceCount} />
              </div>
            </div>
          </div>
        </main>
        <AdAside
          ad={ad}
          adLink={adLink}
          adCount={adCount}
          safeIndex={safeIndex}
          onAdTap={onAdTap}
          editRegions={editRegions}
        />
        <footer className={styles.mobileFooter}>キミテラス by Rebounder</footer>
      </div>
    </div>
  );
}

/**
 * パターン4 専用の**天気ヒーロー**（主役）。`data.weather.days` の本日以降（最大 7 日）を 1 行のストリップで出す。
 * 各日 = **曜日（今日は「今日」）／日付（M/D）／天気マーク**を**主役（大）**に、**気温（最高/最低）／降水確率**を
 * **サブ（小）**として添える（2026-06-20 ユーザー指示「日にち・曜日・天気マークをメイン、気温・降雨率をサブ」）。
 *
 * ## 設計上の不変条件
 * - **region landmark を作らない**: weather は {@link SIGNAGE_BLOCK_META} で `hasRegion=false`。盤面 region
 *   ドリフトガード（描画 region 集合 ↔ hasRegion ブロック集合の一致）を崩さぬよう、`<section aria-label>` では
 *   なく `role="group"` でまとめる（pattern1 防災帯 / pattern3 週間天気帯と同作法）。aria-label は「天気」。
 * - **pattern3 週間天気帯（"週間天気" group）とは別物**: 本ヒーローは "天気" group で、pattern3 専用の
 *   `Pattern3WeeklyWeather`（"週間天気" group）とは名前で区別する（テストの取り違え防止）。
 * - **NFR05（色非依存）**: 気温は色だけでなく必ず数値を添え、天気グリフは `aria-label` で意味を担保。
 * - **fail-soft**: `weather=null` や本日以降の予報が 0 件なら帯ごと出さない（盤面を壊さない）。降水確率・気温が
 *   欠落した日はその要素だけ出さない（盤面を詰めて見せる）。
 */
function Pattern4WeatherHero({
  weather,
  today,
}: {
  weather: SignageWeather | null;
  today: string;
}) {
  const days = weather ? weather.days.slice(0, 7) : [];
  if (days.length === 0) {
    return null;
  }
  return (
    // 非フォームの関連項目まとめ。region landmark を増やさぬよう <section aria-label> でなく role="group"。
    // biome-ignore lint/a11y/useSemanticElements: 盤面 region ドリフトガードを崩さぬため role="group" を使う
    <div className={styles.p4Weather} role="group" aria-label="天気">
      {days.map((day) => {
        const { weekday, monthDay } = weeklyWeatherLabel(day.forecastDate, today);
        const isToday = day.forecastDate === today;
        return (
          <div
            key={day.forecastDate}
            className={`${styles.p4WxCell} ${isToday ? styles.p4WxCellToday : ""}`}
          >
            {/* 主役: 曜日（今日は「今日」）／日付（M/D）／天気マーク（大）。 */}
            <span className={styles.p4WxDow}>{weekday}</span>
            <span className={styles.p4WxDate}>{monthDay}</span>
            <span className={styles.p4WxIcon} aria-label={day.weatherText ?? day.iconLabel}>
              <span aria-hidden="true">{WEATHER_ICON_GLYPH[day.icon]}</span>
            </span>
            {/* サブ: 気温（最高=暖色／最低=寒色・小）。色だけに依らず数値併記（NFR05）。 */}
            {day.tempMax != null || day.tempMin != null ? (
              <span className={styles.p4WxTemps}>
                <span className={styles.p4WxHigh}>
                  {day.tempMax != null ? `${day.tempMax}°` : "—"}
                </span>
                <span className={styles.p4WxLow}>
                  {day.tempMin != null ? `${day.tempMin}°` : "—"}
                </span>
              </span>
            ) : null}
            {/* サブ: 降水確率（小）。欠落日は出さない。 */}
            {day.pop != null ? (
              <span className={styles.p4WxPop} aria-label={`降水確率 ${day.pop}％`}>
                <span aria-hidden="true">☂</span>
                {day.pop}%
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * パターン3（廊下版）の大型ヘッダー。`BoardHeader` と**同じ情報**（実時計／盤面日付／クラス識別／ブランド）に
 * **当日の気温**（最高/最低）を時刻の隣に添え、廊下の通行者が遠目で一瞥できるよう**時刻を主役に大型化**する。
 * 天気アイコン（マーク）は週間天気帯（{@link Pattern3WeeklyWeather}）の「今日」セルが既に出すので、ヘッダーでは
 * **重複を避けて出さない**（2026-06-18 ユーザー指示）。気温だけ残すので weather 条件の `aria-label` も付けない
 * （視覚＝数値・読み上げ＝数値で一致）。当日予報が無い／最高気温が無ければ気温サマリを出さない（fail-soft）。
 */
function Pattern3Header({ data, now }: { data: SignagePayload; now: Date | null }) {
  const { dateText, dayText } = formatBoardDate(data.date);
  const time = now ? formatClock(now) : "";
  const classIdentity = formatClassIdentity(data.classContext);
  const weatherToday = data.weather?.days.find((d) => d.forecastDate === data.date) ?? null;
  return (
    <header className={styles.p3Header}>
      {classIdentity ? (
        <span className={styles.p3HeaderLoc} aria-label={`表示クラス: ${classIdentity}`}>
          {classIdentity}
        </span>
      ) : null}
      {time ? <span className={styles.p3HeaderClock}>{time}</span> : null}
      <span className={styles.p3HeaderDate}>
        <span className={styles.p3HeaderDateMain}>{dateText}</span>
        <span className={styles.p3HeaderDay}>{dayText}曜日</span>
      </span>
      {weatherToday && weatherToday.tempMax != null ? (
        <span className={styles.p3HeaderWx}>
          <span className={styles.p3HeaderWxTemp}>
            {weatherToday.tempMax}°
            {weatherToday.tempMin != null ? ` / ${weatherToday.tempMin}°` : ""}
          </span>
        </span>
      ) : null}
      <span className={styles.p3HeaderBrand}>キミテラス by Rebounder</span>
    </header>
  );
}

/**
 * パターン3（廊下版）専用の**週間天気帯**。`data.weather.days` の本日以降（最大 7 日）を情報エリア（`.p2Grid`）
 * の先頭に 1 行で出す。各日 = 曜日／日付 ＋ 単色天気グリフ ＋ 最高（暖色）／最低（寒色）気温 ＋ 降水確率。
 * 廊下の通行者が「今日この先 1 週間の天気と気温の高低」を遠目で一瞥できることを狙う（2026-06-18 ユーザー確定。
 * 当初案にあった折れ線グラフは面積過多のため不採用＝数値で高低を示す）。
 *
 * ## 設計上の不変条件
 * - **広告 9:16 列は不変**: 本帯は左 70% の情報エリア内だけに収め、右 30% の広告（`.adContainer` の 9:16）は
 *   一切削らない（ユーザー指示 2026-06-18）。
 * - **pattern3 のみが描画**: pattern2（教室端末）は無改修。weather ブロック自体は既に PATTERN_BLOCKS に含まれ
 *   データ取得は共有なので、本コンポーネントは純デザイン層の追加（データ層・取得ゲートは無改修）。
 * - **region landmark を作らない**: weather は {@link SIGNAGE_BLOCK_META} で `hasRegion=false`（予定列ヘッダー
 *   内包が原型）。盤面 region ドリフトガード（SignageClient.test の region 集合一致）を崩さぬよう、本帯は
 *   `<section aria-label>` ではなく `role="group"` でまとめる（group は landmark ではない）。
 * - **NFR05（色非依存）**: 気温は色だけでなく必ず数値を添え、天気グリフは `aria-label` で意味を担保（既存の
 *   予定列ヘッダー #847 と同作法）。
 * - **fail-soft**: `weather=null` や本日以降の予報が 0 件なら帯ごと出さない（盤面を壊さない）。
 */
function Pattern3WeeklyWeather({
  weather,
  today,
}: {
  weather: SignageWeather | null;
  today: string;
}) {
  const days = weather ? weather.days.slice(0, 7) : [];
  if (days.length === 0) {
    return null;
  }
  return (
    // 非フォームの関連項目まとめ。<fieldset> はフォーム用で不適、<section aria-label> は region landmark を
    // 増やし盤面 region ドリフトガード（SignageClient.test）を崩すため、landmark でない role="group" を使う。
    // biome-ignore lint/a11y/useSemanticElements: 上記理由で <fieldset>/<section> ではなく role="group"
    <div className={styles.p3WeeklyWx} role="group" aria-label="週間天気">
      {days.map((day) => {
        const { weekday, monthDay } = weeklyWeatherLabel(day.forecastDate, today);
        const isToday = day.forecastDate === today;
        return (
          <div
            key={day.forecastDate}
            className={`${styles.p3WxCell} ${isToday ? styles.p3WxCellToday : ""}`}
          >
            {/* 1 段目: 曜日 + 日付を横並び（縦積みの段数を減らし無駄な余白を削る）。 */}
            <span className={styles.p3WxHead}>
              <span className={styles.p3WxDow}>{weekday}</span>
              <span className={styles.p3WxDate}>{monthDay}</span>
            </span>
            {/* 2 段目: 天気アイコン（意味は aria-label が担保・色非依存 NFR05）。 */}
            <span className={styles.p3WxIcon} aria-label={day.weatherText ?? day.iconLabel}>
              <span aria-hidden="true">{WEATHER_ICON_GLYPH[day.icon]}</span>
            </span>
            {/* 3 段目: 最高/最低/降水確率を 1 行に横並び。 */}
            <span className={styles.p3WxData}>
              <span className={styles.p3WxHigh}>
                {day.tempMax != null ? `${day.tempMax}°` : "—"}
              </span>
              <span className={styles.p3WxLow}>
                {day.tempMin != null ? `${day.tempMin}°` : "—"}
              </span>
              {day.pop != null ? (
                <span
                  className={`${styles.p3WxPop} ${day.pop >= 50 ? styles.p3WxPopHigh : ""}`}
                  aria-label={`降水確率 ${day.pop}％`}
                >
                  <span aria-hidden="true">☂</span>
                  {day.pop}%
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** pattern3（廊下版）予定で「1 列に何コマまで出すか」。これを超える日は CSS で自動縦スクロールする。 */
const P3_SCHEDULE_VISIBLE_ROWS = 5;

/**
 * パターン3（廊下版）専用の予定。pattern2 の 3 列とは別物で、廊下の「遠目・一瞥」に最適化する（2026-06-22 ユーザー確定）:
 *   - **平日 5 日**を 5 列で出す（データ層が pattern3 だけ 5 平日を供給。pattern1/2 は 3 列のまま無改修）。
 *   - **箱をやめ**、日ごとは**縦線**（列の border-left）、コマは**横線**（行の border-bottom）で区切る。
 *   - 日付は **`M/D(曜)`** 表記（{@link p3ScheduleHeaderLabel}）。**天気アイコンは出さない**（週間天気帯が担う）。
 *   - 1 列 **5 コマ**まで表示し、超える日は **CSS のみで自動縦スクロール**（{@link P3_SCHEDULE_VISIBLE_ROWS} /
 *     `.p3SchScrollerAuto`）。hooks を持たないので `SignageBoardView` の server 描画可能性（ScaledSignageBoard）は不変。
 *
 * region は pattern2 と同じ `aria-label="予定"`（編集配線 `regionEditProps("schedules", …)` を共有＝WYSIWYG「盤面を
 * 編集」もそのまま効く・盤面 region ドリフトガードと整合）。
 */
function Pattern3Schedule({
  days,
  today,
  editRegions,
}: {
  days: ScheduleDay[];
  today: string;
  editRegions?: EditRegionsProps;
}) {
  const { sectionProps, button } = regionEditProps(
    "schedules",
    styles.p3Schedule,
    "予定",
    editRegions,
  );
  return (
    <section
      {...sectionProps}
      // 列数は表示日数に自動追従（単一ソース = SIGNAGE_SCHEDULE_DAY_COUNT）。0 件時は CSS 既定に委ねる。
      style={
        days.length > 0
          ? ({ "--p3-schedule-cols": String(days.length) } as React.CSSProperties)
          : undefined
      }
    >
      {button}
      {days.map((day) => {
        const rows = sortByPeriod(day.schedule.items).map((item) => parseScheduleRow(item));
        const isToday = day.date === today;
        const overflow = rows.length > P3_SCHEDULE_VISIBLE_ROWS;
        return (
          <div
            key={day.date}
            className={`${styles.p3SchDay} ${isToday ? styles.p3SchDayToday : ""}`}
          >
            <div className={styles.p3SchDate}>{p3ScheduleHeaderLabel(day.date)}</div>
            <div className={styles.p3SchRows}>
              {rows.length === 0 ? (
                <span className={styles.p3SchEmpty}>予定はありません</span>
              ) : (
                <div
                  className={`${styles.p3SchScroller} ${overflow ? styles.p3SchScrollerAuto : ""}`}
                  // 超過時のみ: 行数を CSS 変数で渡し、スクロール距離（(行数-可視数)×行高）と所要時間を CSS 側で算出する。
                  style={
                    overflow
                      ? ({ "--p3-sch-rows": String(rows.length) } as React.CSSProperties)
                      : undefined
                  }
                >
                  {rows.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
                    <Pattern3ScheduleRow key={i} row={row} />
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** pattern3 予定の 1 コマ（固定行高・単一行）。時限 + 内容を 1 行で出す（はみ出しは省略）。 */
function Pattern3ScheduleRow({ row }: { row: SignageScheduleRow }) {
  return (
    <div className={styles.p3SchItem}>
      <span className={styles.p3SchMain}>
        {row.periodLabel ? <span className={styles.scheduleTime}>{row.periodLabel}</span> : null}
        {row.content}
      </span>
    </div>
  );
}

/** pattern3（廊下版）人物エリアで「1 列に何件まで出すか」。これを超えると CSS で自動縦スクロールする
 *  （2026-06-23 ユーザー指示で 4→5 に +1。時事ニュース縮小で空いた縦を充当）。 */
const P3_PEOPLE_VISIBLE_ROWS = 5;

/**
 * パターン3（廊下版）専用の生徒呼び出し。pattern2 の `card`（囲み枠）はやめ、見出し（アクセント下線の名札）＋
 * 固定高ビューポートで出し、{@link P3_PEOPLE_VISIBLE_ROWS} 件を超える日は **CSS のみで自動縦スクロール**する
 * （予定 §11c-2 と同作法・hooks なし＝server 描画可能性は不変）。region は pattern2 と同じ `aria-label="生徒呼び出し"`
 * （盤面 region ドリフトガードと整合）。実名表示の境界は ADR-034（Vertex 非送信＝payload 直返しのみ）。
 */
function Pattern3Callouts({
  callouts,
  editRegions,
}: {
  callouts: SignagePayload["callouts"];
  editRegions?: EditRegionsProps;
}) {
  const list = callouts ?? [];
  const overflow = list.length > P3_PEOPLE_VISIBLE_ROWS;
  const { sectionProps, hideHeading, button } = regionEditProps(
    "callouts",
    styles.p3Person,
    "生徒呼び出し",
    editRegions,
  );
  return (
    <section {...sectionProps}>
      {button}
      {/* biome-ignore lint/a11y/useHeadingContent: 編集モード時のみ意図的に AT から隠す装飾見出し（重複回避・操作名は編集ボタンが担保）。 */}
      <h2 className={styles.p3PersonTitle} aria-hidden={hideHeading || undefined}>
        生徒呼び出し
      </h2>
      <div className={styles.p3PersonRows}>
        {list.length === 0 ? (
          <span className={styles.p3SchEmpty}>呼び出しはありません</span>
        ) : (
          <div
            className={`${styles.p3PersonScroller} ${overflow ? styles.p3PersonScrollerAuto : ""}`}
            style={
              overflow
                ? ({ "--p3-person-rows": String(list.length) } as React.CSSProperties)
                : undefined
            }
          >
            {list.map((c) => (
              <div key={c.id} className={styles.p3PersonItem}>
                <span className={styles.p3PersonMain}>
                  {c.scheduledTime ? (
                    <span className={styles.scheduleTime}>{c.scheduledTime}</span>
                  ) : null}
                  <span className={styles.p3PersonName}>{c.studentName}</span>
                  {c.location ? <span className={styles.p3PersonTo}>→ {c.location}</span> : null}
                </span>
                {c.reason ? <span className={styles.p3PersonMeta}>{c.reason}</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * パターン3（廊下版）専用の来校者一覧。{@link Pattern3Callouts} と同じく囲み枠をやめ、固定高ビューポート＋
 * {@link P3_PEOPLE_VISIBLE_ROWS} 件超の自動縦スクロールにする。region は pattern2 と同じ `aria-label="来校者一覧"`。氏名は当該クラスの端末に
 * のみ表示され RLS で自校スコープ（class-visitors の「個人情報について」・2026-06-10 ユーザー確定）。
 */
function Pattern3Visitors({
  visitors,
  editRegions,
}: {
  visitors: SignagePayload["visitors"];
  editRegions?: EditRegionsProps;
}) {
  const list = visitors ?? [];
  const overflow = list.length > P3_PEOPLE_VISIBLE_ROWS;
  const { sectionProps, hideHeading, button } = regionEditProps(
    "visitors",
    styles.p3Person,
    "来校者一覧",
    editRegions,
  );
  return (
    <section {...sectionProps}>
      {button}
      {/* biome-ignore lint/a11y/useHeadingContent: 編集モード時のみ意図的に AT から隠す装飾見出し（重複回避・操作名は編集ボタンが担保）。 */}
      <h2 className={styles.p3PersonTitle} aria-hidden={hideHeading || undefined}>
        来校者一覧
      </h2>
      <div className={styles.p3PersonRows}>
        {list.length === 0 ? (
          <span className={styles.p3SchEmpty}>本日の来校者はありません</span>
        ) : (
          <div
            className={`${styles.p3PersonScroller} ${overflow ? styles.p3PersonScrollerAuto : ""}`}
            style={
              overflow
                ? ({ "--p3-person-rows": String(list.length) } as React.CSSProperties)
                : undefined
            }
          >
            {list.map((v) => (
              <div key={v.id} className={styles.p3PersonItem}>
                <span className={styles.p3PersonMain}>
                  {v.scheduledTime ? (
                    <span className={styles.scheduleTime}>{v.scheduledTime}</span>
                  ) : null}
                  <span className={styles.p3PersonName}>{v.visitorName}</span>
                  {v.affiliation ? (
                    <span className={styles.p3PersonAffil}>（{v.affiliation}）</span>
                  ) : null}
                </span>
                {v.purpose || v.host ? (
                  <span className={styles.p3PersonMeta}>
                    {v.purpose ? <span>{v.purpose}</span> : null}
                    {v.purpose && v.host ? (
                      <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
                        ／
                      </span>
                    ) : null}
                    {v.host ? <span>対応: {v.host}</span> : null}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * パターン3（廊下版）の**フッタ帯**（情報エリア最下段・左下）。従来の「鉄道・人感センサのステータス帯」と
 * 「工学ニュースのカード」を 1 本のスリムなフッタに集約する（2026-06-22 ユーザー確定）:
 *   - **工学ニュース** = 主役。{@link Pattern3NewsTicker}（client island）が 1 件ずつ自動で切り替える。
 *   - **鉄道 / 人感センサ** = 付属情報として右端に小さく常時表示。
 * 右 30% の広告は不変（フッタは左 70% の情報エリア内に収め、広告を覆わない＝「広告は隠さない」ユーザー指示）。
 * 鉄道・人感センサは {@link SIGNAGE_BLOCK_META} で `hasRegion=true` なので `<section aria-label>` の region を保つ
 * （盤面 region ドリフトガードと整合）。取得失敗・不在は fail-soft 表示に倒す（盤面を壊さない）。
 */
function Pattern3Footer({
  news,
  train,
  presenceCount,
}: {
  news: SignagePayload["news"];
  train: SignagePayload["trainStatus"];
  presenceCount: number | null;
}) {
  return (
    <div className={styles.p3Foot}>
      <Pattern3NewsTicker news={news} />
      <div className={styles.p3FootSide}>
        <section aria-label="鉄道" className={styles.p3FootChip}>
          <span className={styles.p3FootChipLabel}>
            鉄道{train ? `・${train.operatorName}` : ""}
          </span>
          {train == null ? (
            <span className={styles.p3FootMuted}>取得できていません</span>
          ) : (
            <span className={styles.p3FootChipBody}>
              <span
                className={`${styles.p3FootChipVal} ${train.hasDisruption ? styles.p3FootChipAlert : ""}`}
              >
                {train.statusText}
              </span>
              {train.isStale ? (
                <span className={styles.p3FootMuted} role="status">
                  （古い可能性）
                </span>
              ) : null}
            </span>
          )}
        </section>
        <section aria-label="人感センサカウンタ" className={styles.p3FootChip}>
          <span className={styles.p3FootChipLabel}>本日の検知</span>
          {presenceCount == null ? (
            <span className={styles.p3FootMuted}>計測なし</span>
          ) : (
            <span className={`${styles.p3FootChipVal} ${styles.p3FootChipValNum}`}>
              {presenceCount.toLocaleString("ja-JP")}
              <span className={styles.p3FootChipUnit}>回</span>
            </span>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * pattern1（既定盤面）専用の**防災・安全帯**（ADR-044）。自校地域の **気象警報・注意報**（JMA）と **熱中症
 * 警戒アラート**（環境省）を、**アクティブな時だけ**予定の直上（最も目立つ位置）に 1 帯で出す。
 *
 * ## 設計上の不変条件
 * - **条件付き表示（fail-soft）**: 警報 `maxLevel='none'`／熱中症 `alertLevel='none'`／両方 null（地域未解決・
 *   キャッシュ無し・取得失敗）のときは **帯ごと出さない**（`return null`）。安全情報なので「無いのに枠だけ出す」
 *   ことはせず、盤面の他要素（予定/連絡/提出物/広告）を壊さない。アクティブな時だけ目立たせる。
 * - **pattern1 のみ**: pattern2/3 はデータ層が `weatherWarnings`/`heatAlerts` を取得せず null を渡すため自動的に
 *   描画されない（盤面コード上も pattern1 の `Pattern1Board` だけが本帯を呼ぶ）。pattern2/3 は無改修。
 * - **region landmark を作らない**: safety_alert は {@link SIGNAGE_BLOCK_META} で `hasRegion=false`。盤面 region
 *   ドリフトガード（描画 region 集合 ↔ hasRegion ブロック集合の一致）を崩さぬよう、本帯は `<section aria-label>`
 *   ではなく `role="group"` でまとめる（pattern3 週間天気帯と同じ作法）。`aria-label` は本 label「防災・安全」と
 *   一致させる（ドリフトガードと整合）。
 * - **NFR05（色だけに依存しない）**: 段階は色に加え必ず**段階ラベル（注意報/警報/特別警報・警戒/特別警戒）と
 *   アイコン・テキスト**を併記する。サイネージは遠距離視認なので大きめタイポ。AA コントラストはトークン
 *   （`--urgent-color`/`--accent-color` 等、いずれも白地で 4.5:1 超）で担保。
 * - **鮮度**: キャッシュが古い時は「○時時点」注記（天気/鉄道/ニュースと同作法）。
 */
function SafetyAlertBand({
  warning,
  heatAlert,
}: {
  warning: SignageWeatherWarning | null;
  heatAlert: SignageHeatAlert | null;
}) {
  // アクティブ判定: 警報は maxLevel≠'none'、熱中症は alertLevel≠'none' のときだけ目立たせる（要件）。
  const warningActive = warning != null && warning.maxLevel !== "none";
  const heatActive = heatAlert != null && heatAlert.alertLevel !== "none";
  if (!warningActive && !heatActive) {
    // 両方とも非アクティブ（または両 null）→ 帯ごと出さない（fail-soft、盤面を壊さない）。
    return null;
  }
  return (
    // region landmark は作らない（safety_alert は hasRegion=false／ドリフトガード不変）→ group でまとめる。
    // biome-ignore lint/a11y/useSemanticElements: 盤面 region ドリフトガードを崩さぬため role="group" を使う
    <div className={styles.safetyBand} role="group" aria-label="防災・安全">
      {warningActive && warning ? <SafetyWarningRow warning={warning} /> : null}
      {heatActive && heatAlert ? <SafetyHeatRow heatAlert={heatAlert} /> : null}
    </div>
  );
}

/** 気象警報・注意報の 1 行（最大段階バッジ + 個別警報名 + 鮮度注記）。色非依存に段階ラベルを必ず添える。 */
function SafetyWarningRow({ warning }: { warning: SignageWeatherWarning }) {
  // 表示する個別警報名（解除済みは読取層で除外済み・名前が解決できたものだけ）。重複名は畳む。
  const names = Array.from(
    new Set(
      warning.warnings
        .map((w) => w.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0),
    ),
  );
  return (
    <div className={`${styles.safetyRow} ${styles.safetyRowWarning}`}>
      <span className={styles.safetyIcon} aria-hidden="true">
        ⚠
      </span>
      <span className={styles.safetyLabel}>気象{WARNING_LEVEL_LABEL[warning.maxLevel]}</span>
      <span className={styles.safetyBody}>
        {names.length > 0 ? (
          <span className={styles.safetyBodyText}>{names.join("・")}</span>
        ) : warning.headline ? (
          <span className={styles.safetyBodyText}>{warning.headline}</span>
        ) : null}
        {warning.areaName ? (
          <span className={styles.safetyArea}>（{warning.areaName}）</span>
        ) : null}
      </span>
      {warning.isStale ? (
        <span className={styles.safetyStale} role="status">
          {formatSafetyStale(warning.fetchedAt)}
        </span>
      ) : null}
    </div>
  );
}

/** 熱中症警戒アラートの 1 行（段階バッジ + WBGT 値 + 鮮度注記）。色非依存に段階ラベル・WBGT 数値を必ず添える。 */
function SafetyHeatRow({ heatAlert }: { heatAlert: SignageHeatAlert }) {
  return (
    <div className={`${styles.safetyRow} ${styles.safetyRowHeat}`}>
      <span className={styles.safetyIcon} aria-hidden="true">
        🌡
      </span>
      <span className={styles.safetyLabel}>熱中症{HEAT_LEVEL_LABEL[heatAlert.alertLevel]}</span>
      <span className={styles.safetyBody}>
        <span className={styles.safetyBodyText}>適切な水分・塩分補給と休憩を</span>
        {heatAlert.wbgtMax != null ? (
          <span className={styles.safetyWbgt} aria-label={`暑さ指数 WBGT ${heatAlert.wbgtMax}`}>
            <span aria-hidden="true">WBGT {heatAlert.wbgtMax}</span>
          </span>
        ) : null}
      </span>
      {heatAlert.isStale ? (
        <span className={styles.safetyStale} role="status">
          {formatSafetyStale(heatAlert.fetchedAt)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 気象警戒段階 → 色非依存の段階ラベル（NFR05）。`satisfies Record<WarningLevel, string>` で enum とのズレを
 * コンパイル時に固定する（段階を足したらここで型エラー＝表示漏れを機械的に検知）。`none` は帯を出さないので
 * 実際には使わないが、網羅性のため空でない安全側ラベルにしておく。
 */
const WARNING_LEVEL_LABEL = {
  none: "情報",
  advisory: "注意報",
  warning: "警報",
  emergency: "特別警報",
} satisfies Record<WarningLevel, string>;

/**
 * 熱中症警戒段階 → 色非依存の段階ラベル（NFR05）。`satisfies Record<HeatAlertLevel, string>` で enum との
 * ズレをコンパイル時に固定する。`none` は帯を出さないので実際には使わない。
 */
const HEAT_LEVEL_LABEL = {
  none: "情報",
  warning: "警戒アラート",
  emergency: "特別警戒アラート",
} satisfies Record<HeatAlertLevel, string>;

/** 鮮度注記「○時時点」を JST 時刻で組む（天気/鉄道/ニュースと同思想）。fetchedAt 不明は汎用注記に倒す。 */
function formatSafetyStale(fetchedAt: Date | null): string {
  if (fetchedAt == null || Number.isNaN(fetchedAt.getTime())) {
    return "（情報が古い可能性）";
  }
  const hh = fetchedAt.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    minute: "2-digit",
  });
  return `（${hh}時点）`;
}

/**
 * パターン2の予定（主役・横幅いっぱい・今後3平日の3列）。**見出し「予定」と外枠は持たず 3 列をそのまま開放
 * 配置**して主役を強調する（自己説明できる日付＋時限ヘッダーがラベルを兼ねる）。見える見出しは外すが section の
 * `aria-label="予定"` で領域名・読み上げは維持（NFR05）。各列は day/曜（列ヘッダー）+ 時限 + 内容（科目・補足）に
 * 加え、**場所 / 対象者**（任意・教員入力）を各コマの下に小さく添える。天気は当日の予報を**列ヘッダーにアイコン
 * のみ**で内包する（パターン1 #847 と同作法。意味は aria-label が担保し色非依存・NFR05）。未設定の場所/対象者・
 * 該当日の予報無しは出さない（fail-soft、盤面を詰めて見せる）。
 */
function Pattern2Schedule({
  days,
  today,
  weather,
  editRegions,
}: {
  days: ScheduleDay[];
  today: string;
  weather: SignageWeather | null;
  editRegions?: EditRegionsProps;
}) {
  const { sectionProps, button } = regionEditProps(
    "schedules",
    styles.p2Schedule,
    "予定",
    editRegions,
  );
  return (
    <section
      {...sectionProps}
      // 列数は表示日数に自動追従（単一ソース = SIGNAGE_SCHEDULE_DAY_COUNT）。0 件時は CSS 既定に委ねる。
      style={
        days.length > 0
          ? ({ "--schedule-cols": String(days.length) } as React.CSSProperties)
          : undefined
      }
    >
      {button}
      {days.map((day) => {
        const rows = sortByPeriod(day.schedule.items).map((item) => parseScheduleRow(item));
        const isToday = day.date === today;
        const weatherDay = weather?.days.find((d) => d.forecastDate === day.date) ?? null;
        return (
          <div
            key={day.date}
            className={`${styles.p2ScheduleDay} ${isToday ? styles.p2ScheduleToday : ""}`}
          >
            <div className={styles.p2ScheduleDate}>
              <span className={styles.p2ScheduleDateLabel}>{scheduleHeaderLabel(day.date)}</span>
              {weatherDay ? (
                <span
                  className={styles.p2ScheduleWeather}
                  aria-label={weatherDay.weatherText ?? weatherDay.iconLabel}
                >
                  <span aria-hidden="true" className={styles.p2ScheduleWeatherGlyph}>
                    {WEATHER_ICON_GLYPH[weatherDay.icon]}
                  </span>
                </span>
              ) : null}
            </div>
            <div className={styles.p2ScheduleRows}>
              {rows.length === 0 ? (
                <span className={styles.p2Muted}>予定はありません</span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
                rows.map((row, i) => <Pattern2ScheduleRow key={i} row={row} />)
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** パターン2 予定の 1 コマ: 時限 + 内容、その下に 場所 / 対象者（あるものだけ）を小さく添える。 */
function Pattern2ScheduleRow({ row }: { row: SignageScheduleRow }) {
  const hasMeta = row.location != null || row.targetAudience != null;
  return (
    <div className={styles.p2ScheduleItem}>
      <span className={styles.p2ScheduleMain}>
        {row.periodLabel ? <span className={styles.scheduleTime}>{row.periodLabel}</span> : null}
        {row.content}
      </span>
      {hasMeta ? (
        <span className={styles.p2ScheduleMeta}>
          {row.location ? <span>場所: {row.location}</span> : null}
          {row.location && row.targetAudience ? (
            <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
              ／
            </span>
          ) : null}
          {row.targetAudience ? <span>対象: {row.targetAudience}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * パターン2の来校者一覧（クラス×当日）。時刻 + 氏名（+ 所属）を上段に、用件 / 対応者を下段に小さく出す。
 * 来校者無し・取得失敗（`null`）はともに「本日の来校者はありません」（fail-soft）。氏名は当該クラスの端末に
 * のみ表示され RLS で自校スコープ（class-visitors の「個人情報について」参照・2026-06-10 ユーザー確定）。
 */
function Pattern2Visitors({
  visitors,
  editRegions,
}: {
  visitors: SignagePayload["visitors"];
  editRegions?: EditRegionsProps;
}) {
  const list = visitors ?? [];
  const { sectionProps, hideHeading, button } = regionEditProps(
    "visitors",
    styles.card,
    "来校者一覧",
    editRegions,
  );
  return (
    <section {...sectionProps}>
      {button}
      {/* biome-ignore lint/a11y/useHeadingContent: 編集モード時のみ意図的に AT から隠す装飾見出し（重複回避・操作名は編集ボタンが担保）。 */}
      <h2 className={styles.cardTitle} aria-hidden={hideHeading || undefined}>
        来校者一覧
      </h2>
      {list.length === 0 ? (
        <p className={styles.p2Muted}>本日の来校者はありません</p>
      ) : (
        <ul className={styles.p2VisitorList}>
          {list.map((v) => (
            <li key={v.id} className={styles.p2VisitorItem}>
              <span className={styles.p2VisitorMain}>
                {v.scheduledTime ? (
                  <span className={styles.scheduleTime}>{v.scheduledTime}</span>
                ) : null}
                <span className={styles.p2VisitorName}>{v.visitorName}</span>
                {v.affiliation ? (
                  <span className={styles.p2VisitorAffil}>（{v.affiliation}）</span>
                ) : null}
              </span>
              {v.purpose || v.host ? (
                <span className={styles.p2ScheduleMeta}>
                  {v.purpose ? <span>{v.purpose}</span> : null}
                  {v.purpose && v.host ? (
                    <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
                      ／
                    </span>
                  ) : null}
                  {v.host ? <span>対応: {v.host}</span> : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * パターン2の生徒呼び出し（クラス×当日）。時刻 + 生徒**フルネーム**を上段に、呼び出し先 / 用件を下段に出す。
 * 呼び出し無し・取得失敗（`null`）はともに「呼び出しはありません」（fail-soft）。実名表示は ADR-034 の境界下
 * （当該クラス端末・RLS 自校・Vertex 非送信。出席番号でなく実名なのは呼び出しの取り違え防止）。
 */
function Pattern2Callouts({
  callouts,
  editRegions,
}: {
  callouts: SignagePayload["callouts"];
  editRegions?: EditRegionsProps;
}) {
  const list = callouts ?? [];
  // 呼び出しが 1 件以上ある時だけ左にアクセント線を立て、名指しされた生徒が気づきやすくする（提出物の
  // 期限切れ行と同じ inset box-shadow 作法）。0 件は線なしで他カードと等価に保つ（ユーザー指定 2026-06-13）。
  const hasCallouts = list.length > 0;
  const { sectionProps, hideHeading, button } = regionEditProps(
    "callouts",
    `${styles.card} ${hasCallouts ? styles.p2CalloutsActive : ""}`,
    "生徒呼び出し",
    editRegions,
  );
  return (
    <section {...sectionProps}>
      {button}
      {/* biome-ignore lint/a11y/useHeadingContent: 編集モード時のみ意図的に AT から隠す装飾見出し（重複回避・操作名は編集ボタンが担保）。 */}
      <h2 className={styles.cardTitle} aria-hidden={hideHeading || undefined}>
        生徒呼び出し
      </h2>
      {list.length === 0 ? (
        <p className={styles.p2Muted}>呼び出しはありません</p>
      ) : (
        <ul className={styles.p2VisitorList}>
          {list.map((c) => (
            <li key={c.id} className={styles.p2VisitorItem}>
              <span className={styles.p2VisitorMain}>
                {c.scheduledTime ? (
                  <span className={styles.scheduleTime}>{c.scheduledTime}</span>
                ) : null}
                <span className={styles.p2VisitorName}>{c.studentName}</span>
                {c.location ? <span className={styles.p2CalloutTo}>→ {c.location}</span> : null}
              </span>
              {c.reason ? <span className={styles.p2ScheduleMeta}>{c.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * パターン2の人感センサカウンタ（F13 / ADR-020）。このクラスの **本日の検知回数（累計）** を表示する。
 * PIR は瞬間検知で滞在時間を測れない（ADR-020）ため「在室人数」ではなく「本日何回検知したか」を出す
 * （2026-06-10 ユーザー確定）。件数は `getTodayPresenceCount`（RLS 自校限定）由来。取得失敗（`null`）は
 * 「計測なし」表示に倒す（fail-soft）。検知ゼロは `0 回` を出す（センサーは在るが今日まだ反応なし）。
 */
function Pattern2SensorCount({ count }: { count: number | null }) {
  return (
    <section aria-label="人感センサカウンタ" className={styles.p2StatusTile}>
      <span className={styles.p2StatusLabel}>本日の検知</span>
      {count == null ? (
        <span className={styles.p2Muted}>計測なし</span>
      ) : (
        <span className={styles.p2SensorValue}>
          <span className={styles.p2SensorNum}>{count.toLocaleString("ja-JP")}</span>
          <span className={styles.p2SensorUnit}>回</span>
        </span>
      )}
    </section>
  );
}

/**
 * パターン2の鉄道（運行情報）。対象事業者（当面=名鉄/笠松駅）の現況をキャッシュ（railway_status）から表示する。
 * 端末は閉域で名鉄サイトを直叩きしない（バックエンド取得 Job が更新・ADR-035）。取得 Job 未稼働・取得失敗
 * （`null`）は「運行情報は取得できていません」（fail-soft）。運行に乱れがある時は強調、キャッシュが古い時は注記。
 */
function Pattern2Train({ train }: { train: SignagePayload["trainStatus"] }) {
  return (
    <section aria-label="鉄道" className={styles.p2StatusTile}>
      <span className={styles.p2StatusLabel}>
        {train ? `${train.operatorName}・笠松駅の運行状況` : "名鉄・笠松駅の運行状況"}
      </span>
      {train == null ? (
        <span className={styles.p2Muted}>運行情報は取得できていません</span>
      ) : (
        <span className={styles.p2TrainBody}>
          <span
            className={`${styles.p2TrainStatus} ${train.hasDisruption ? styles.p2TrainDisrupted : ""}`}
          >
            {train.statusText}
          </span>
          {train.isStale ? (
            <span className={styles.p2TrainStale} role="status">
              （情報が古い可能性）
            </span>
          ) : null}
        </span>
      )}
    </section>
  );
}

/**
 * パターン2/4 の時事ニュース（ADR-043。旧称「工学ニュース」を 2026-06-20 に「時事ニュース」へ全体改称・
 * ユーザー指定）。外部取得キャッシュ（news_items）の最新見出しを**見出し + 発表元 + 公開日 + 出典 URL**で
 * 1 行ずつ出す。**本文は転載しない**（著作権方針・news_items 自体が本文を持たない）。**出典明記（発表元
 * ラベル）は必須**（CC BY の条件かつ礼儀）。端末は閉域で、バックエンド取得 Job が更新したキャッシュを読むだけ
 * （RSS 直叩きしない）。記事無し・取得失敗（`null` / `items` 空）はともに「ニュースを取得できていません」
 * （fail-soft）。キャッシュが古い時は注記する（鉄道 `Pattern2Train` と同作法）。pattern3 は news 非表示（#1080）。
 *
 * `showSummary`（pattern4 のみ true）が立つと、**CC BY ソースの公式要約**（`item.summary`・経産省 METI のみ非
 * null・gate は取得 Job 済）を見出しの下に **箇条書きで先頭最大 2 文**添える（`splitNewsSummary`・①抽出/AI 不使用・
 * 2026-06-20 ユーザー指示）。`showSummary` 無し（pattern2）は従来どおり見出しのみ＝出力不変。`carousel`（pattern4）
 * では一覧の縦スクロールでなく 1 記事ずつ横スライドのカルーセル（{@link NewsCarousel}）で見せる。要約の出典は
 * 既存の発表元ラベル（`p2NewsSource`）が担う（CC BY の出典明記要件）。
 */
function Pattern2News({
  news,
  showSummary = false,
  carousel = false,
}: {
  news: SignagePayload["news"];
  showSummary?: boolean;
  /** pattern4: 一覧の縦スクロールでなく「1 記事ずつ横スライドで差し替える」カルーセルで見せる。既定 false。 */
  carousel?: boolean;
}) {
  const items = news?.items ?? [];
  return (
    <section aria-label="時事ニュース" className={`${styles.card} ${styles.p2News}`}>
      <h2 className={styles.cardTitle}>
        時事ニュース
        {news?.isStale ? (
          <span className={styles.p2NewsStale} role="status">
            （情報が古い可能性）
          </span>
        ) : null}
      </h2>
      {items.length === 0 ? (
        <p className={styles.p2Muted}>ニュースを取得できていません</p>
      ) : carousel ? (
        // pattern4: 1 記事だけ縦に収め、一定間隔で次の記事が横から「しゅん」とスライドして差し替わる
        // （2026-06-20 ユーザー指示）。全件 DOM 保持で順送り＝文字切れせず 1 記事ずつ大きく読ませる。
        <NewsCarousel>
          {items.map((item) => (
            <NewsItemBody key={item.id} item={item} showSummary={showSummary} />
          ))}
        </NewsCarousel>
      ) : (
        // pattern2: 一覧を縦オートスクロールで順に見せる（収まる時は静的＝回帰なし）。
        <AutoScroll>
          <ul className={styles.p2NewsList}>
            {items.map((item) => (
              <li key={item.id} className={styles.p2NewsItem}>
                <NewsItemBody item={item} showSummary={showSummary} />
              </li>
            ))}
          </ul>
        </AutoScroll>
      )}
    </section>
  );
}

/**
 * 1 記事の中身（見出し ＋ 要約箇条書き ＋ 発表元/公開日 ＋ 出典ドメイン）。一覧（pattern2 の `<li>`）と
 * カルーセル（pattern4 のスライド `<div>`）で**同一の中身を再利用**するため部品化（DRY）。要約は
 * `showSummary`（pattern4）かつ CC BY ソースで要約がある記事だけ、`splitNewsSummary`（先頭文を抽出・AI 不使用）
 * で「。」分割した箇条書き。出典明記（発表元ラベル）は ADR-043 で必須。
 */
function NewsItemBody({
  item,
  showSummary,
}: {
  item: NonNullable<SignagePayload["news"]>["items"][number];
  showSummary: boolean;
}) {
  const summarySentences = showSummary && item.summary ? splitNewsSummary(item.summary) : [];
  return (
    <>
      <span className={styles.p2NewsTitle}>{item.title}</span>
      {/* 出典明記（発表元ラベル）は ADR-043 で必須。**見出し直後**に置き、要約が長くてカルーセルのスライドから
          溢れても出典・公開日が必ず見える位置にする（2026-06-21 修正・旧: 要約の下で見切れていた）。 */}
      <span className={styles.p2NewsMeta}>
        <span className={styles.p2NewsSource}>{item.sourceLabel}</span>
        {item.publishedAt ? (
          <>
            <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
              ／
            </span>
            <span>{formatNewsDate(item.publishedAt)}</span>
          </>
        ) : null}
        {/* 出典 URL（記事原文）の出典ドメイン。QR の生成元にもなる。出典明記の一部として発表元の隣に置く。 */}
        <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
          ／
        </span>
        <span className={styles.p2NewsUrl}>{formatNewsUrl(item.url)}</span>
      </span>
      {summarySentences.length > 0 ? (
        <ul className={styles.p2NewsSummary}>
          {summarySentences.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 不変リスト（1 記事内の文分割）の描画
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * 要約（公式配信の説明文）を「。」で文分割し、各文末に「。」を付け直して**先頭最大 2 文**返す（2026-06-20
 * ユーザー指示・①抽出方式＝AI 不使用）。公式配信は要点を先頭に書くため、先頭 1〜2 文がそのまま短い要約になる。
 * カルーセルが 1 記事ずつ時間をかけて見せるので、長文を詰め込まず先頭文だけで読み切れる量に絞る。**生成・要約は
 * 行わず原文の文をそのまま使う**（官公庁の公式文の正確性を保ち、CC BY「公式要約を出典明記で転載」の整理を維持）。
 * 空要素は捨てる。「。」を含まない 1 文だけの要約はその 1 件を返す（末尾「。」付与）。
 */
function splitNewsSummary(summary: string): string[] {
  return summary
    .split("。")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 2)
    .map((s) => `${s}。`);
}

/**
 * 予定（今後3平日の3列グリッド）。上段に横幅いっぱいで配置 (v1 ScheduleGrid 移植)。
 * 各列の日付ヘッダーに当日の天気を横並びで表示する（2026-06-07 ユーザー）。天気が古い場合は
 * F14 §3 要件に従い「古い予報」バッジをセクション右端に表示する。aria-label は
 * 残し、スクリーンリーダ/領域名としての識別は維持する（NFR05）。
 */
function ScheduleGrid({
  days,
  today,
  weather,
  editRegions,
}: {
  days: ScheduleDay[];
  today: string;
  weather: SignageWeather | null;
  editRegions?: EditRegionsProps;
}) {
  const { sectionProps, button } = regionEditProps(
    "schedules",
    `${styles.card} ${styles.scheduleSection}`,
    "予定",
    editRegions,
  );
  return (
    <section {...sectionProps}>
      {button}
      {weather?.isStale ? (
        <span className={styles.scheduleStaleNotice} role="status" aria-live="polite">
          古い予報
        </span>
      ) : null}
      <div
        className={styles.scheduleGridContainer}
        // 列数は表示日数に自動追従（単一ソース = SIGNAGE_SCHEDULE_DAY_COUNT）。0 件時は CSS 既定に委ねる。
        style={
          days.length > 0
            ? ({ "--schedule-cols": String(days.length) } as React.CSSProperties)
            : undefined
        }
      >
        {days.map((day) => {
          const weatherDay = weather?.days.find((d) => d.forecastDate === day.date) ?? null;
          return (
            <ScheduleColumn
              key={day.date}
              day={day}
              isToday={day.date === today}
              weatherDay={weatherDay}
            />
          );
        })}
      </div>
    </section>
  );
}

/** 予定の 1 日分（1 列）。日付ヘッダー（今日は黒地強調）に天気を横並びで表示。5 行分の予定行（空きはプレースホルダー）。 */
function ScheduleColumn({
  day,
  isToday,
  weatherDay,
}: {
  day: ScheduleDay;
  isToday: boolean;
  weatherDay: WeatherDay | null;
}) {
  const rows = sortByPeriod(day.schedule.items).map((item) => parseScheduleRow(item));
  const placeholders = Math.max(0, MIN_ROWS - rows.length);
  return (
    <div className={`${styles.scheduleDayColumn} ${isToday ? styles.isToday : ""}`}>
      <div className={styles.scheduleDateHeader}>
        <span className={styles.scheduleDateLabel}>{scheduleHeaderLabel(day.date)}</span>
        {weatherDay ? (
          <span
            className={styles.scheduleWeatherInline}
            aria-label={weatherDay.weatherText ?? weatherDay.iconLabel}
          >
            <span aria-hidden="true" className={styles.scheduleWeatherGlyph}>
              {WEATHER_ICON_GLYPH[weatherDay.icon]}
            </span>
          </span>
        ) : null}
      </div>
      <div className={styles.scheduleScrollArea}>
        {rows.map((row, i) => (
          // 予定は再並びしない静的リスト。index key で十分。
          // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
          <ScheduleRow key={i} row={row} />
        ))}
        {Array.from({ length: placeholders }, (_, i) => {
          // 空きスロットは罫線だけ見せる固定数のプレースホルダー。
          const cls = `${styles.scheduleListItem} ${styles.schedulePlaceholder}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定数プレースホルダー
            <div key={`ph-${i}`} className={cls}>
              &nbsp;
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScheduleRow({ row }: { row: SignageScheduleRow }) {
  return (
    <div className={styles.scheduleListItem}>
      <span className={styles.scheduleRowInner}>
        {row.periodLabel ? <span className={styles.scheduleTime}>{row.periodLabel}</span> : null}
        <span className={styles.scheduleContent}>{row.content}</span>
      </span>
    </div>
  );
}

/**
 * 連絡事項。重要マーク(isHighlight)は赤強調 + 【重要】。
 *
 * - **既定（pattern1・グリッド）**: 左下・5 行固定。提出物表と行を揃えるため空きはプレースホルダーで 5 行を保つ。
 * - **`scroll`（pattern4・フロー）**: 5 行固定をやめ全連絡を自然高さで縦に積み、枠に収まらなければ {@link AutoScroll}
 *   で縦オートスクロールして全文を順に見せる（教員が入れた長文が切れて一部見えなくなる事象の解消・2026-06-20
 *   ユーザー報告）。編集モード（`editRegions`）では動かさず静的（クリック編集を妨げない）。
 */
function NoticeList({
  section,
  editRegions,
  scroll = false,
}: {
  section: MergedSection;
  editRegions?: EditRegionsProps;
  /** pattern4: 5 行固定をやめフロー＋オートスクロールで全連絡を切らずに見せる。既定 false（従来のグリッド）。 */
  scroll?: boolean;
}) {
  const lines = section.items.map((item) => formatSignageItem("notices", item));
  // フロー（scroll）はプレースホルダーで詰めない（自然高さで積みオートスクロールに委ねる）。
  const placeholders = scroll ? 0 : Math.max(0, MIN_ROWS - lines.length);
  const { sectionProps, hideHeading, button } = regionEditProps(
    "notices",
    styles.card,
    "連絡",
    editRegions,
  );
  const list = (
    <ul className={scroll ? styles.noticeFlow : styles.listGroup}>
      {lines.length === 0 ? (
        <li className={styles.empty}>連絡事項はありません</li>
      ) : (
        <>
          {lines.map((line, i) => {
            const cls = `${styles.listItem} ${line.emphasis ? styles.itemEmphasis : ""}`;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
              <li key={i} className={cls}>
                {line.emphasis ? "【重要】" : ""}
                {line.text}
              </li>
            );
          })}
          {Array.from({ length: placeholders }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定数プレースホルダー
            <li key={`ph-${i}`} className={styles.noticePlaceholder}>
              &nbsp;
            </li>
          ))}
        </>
      )}
    </ul>
  );
  return (
    <section {...sectionProps}>
      {button}
      {/* 編集モードでは見出しを AT から外し、編集器側の「連絡」見出し / 既存 e2e の strict locator と二重化させない
          （可視テキストは残し、操作のアクセシブル名は編集ボタンの aria-label が担う）。非編集（live/壁）では
          aria-hidden を一切付けず従来どおり heading として読む（出力不変）。 */}
      {/* biome-ignore lint/a11y/useHeadingContent: 編集モード時のみ意図的に AT から隠す装飾見出し（重複回避・操作名は編集ボタンが担保）。 */}
      <h2 className={styles.cardTitle} aria-hidden={hideHeading || undefined}>
        連絡
        <SourceBadge source={section.source} />
      </h2>
      {scroll ? <AutoScroll play={!editRegions}>{list}</AutoScroll> : list}
    </section>
  );
}

/** 提出物（右下・表・5行）。期限/科目/提出物の3列。期限切れは赤行、当日/翌日締切は赤文字。空きは行プレースホルダー。 */
function AssignmentTable({
  section,
  today,
  editRegions,
}: {
  section: MergedSection;
  today: string;
  editRegions?: EditRegionsProps;
}) {
  const rows = section.items
    .map((item) => parseAssignmentRow(item, today))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const placeholders = Math.max(0, MIN_ROWS - rows.length);
  const { sectionProps, hideHeading, button } = regionEditProps(
    "assignments",
    styles.card,
    "提出物",
    editRegions,
  );
  return (
    <section {...sectionProps}>
      {button}
      {/* 編集モードでは見出しを AT から外し、編集器側の「提出物」見出し / 既存 e2e の strict locator と二重化させない。
          非編集（live/壁）では aria-hidden を一切付けず従来どおり heading として読む（出力不変）。 */}
      {/* biome-ignore lint/a11y/useHeadingContent: 編集モード時のみ意図的に AT から隠す装飾見出し（重複回避・操作名は編集ボタンが担保）。 */}
      <h2 className={styles.cardTitle} aria-hidden={hideHeading || undefined}>
        提出物
        <SourceBadge source={section.source} />
      </h2>
      <div className={styles.tableWrapper}>
        <table className={styles.taskTable}>
          <thead>
            <tr>
              <th>期限</th>
              <th>科目</th>
              <th>提出物</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className={styles.noAssignment}>
                  提出物はありません
                </td>
              </tr>
            ) : (
              <>
                {rows.map((row, i) => (
                  // 提出物は再並びしない静的リスト。index key で十分。
                  // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
                  <tr key={i} className={row.isOverdue ? styles.overdueRow : ""}>
                    <td>
                      <span
                        className={
                          row.isOverdue || row.isUrgent ? styles.daysUrgent : styles.daysLeft
                        }
                      >
                        {row.daysLeft || row.deadlineShort}
                      </span>
                    </td>
                    <td>{row.subject}</td>
                    <td>{row.task}</td>
                  </tr>
                ))}
                {Array.from({ length: placeholders }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 固定数プレースホルダー
                  <tr key={`ph-${i}`} className={styles.assignmentPlaceholder}>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** セクション採用元バッジ（学校共通 / 学科共通 / 学年共通）。class 由来・未設定は出さない。 */
function SourceBadge({ source }: { source: MergedSection["source"] }) {
  if (!source || source === "class") {
    return null;
  }
  return <span className={styles.sourceBadge}>{SOURCE_BADGE_LABEL[source]}</span>;
}

/** 採用元 scope → サイネージ継承バッジ文言。class は出さないので含めない。 */
const SOURCE_BADGE_LABEL: Record<"school" | "department" | "grade", string> = {
  school: "学校共通",
  department: "学科共通",
  grade: "学年共通",
};

/**
 * 予定要素を時限 (period) 昇順に並べる。並びは morning < 1..12 < lunch < afterschool
 * （{@link scheduleSlotSortKey} 単一ソース）。period 欠損/不正は末尾へ。元配列は破壊しない。
 */
function sortByPeriod(items: unknown[]): unknown[] {
  return [...items].sort((a, b) => periodOf(a) - periodOf(b));
}

function periodOf(item: unknown): number {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const p = (item as Record<string, unknown>).period;
    if (typeof p === "number" && Number.isFinite(p)) {
      return scheduleSlotSortKey(p);
    }
    if (isSpecialSlot(p)) {
      return scheduleSlotSortKey(p);
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** 予定列の日付ヘッダー: `MM/DD (曜)`。不正値は素のまま返す。 */
function scheduleHeaderLabel(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return date;
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return date;
  }
  const dow = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${mm}/${dd} (${dow})`;
}

/**
 * pattern3（廊下版）予定の日付ヘッダー: **`M/D(曜)`**（先頭ゼロなし・括弧前スペースなし。例: `6/23(火)`。
 * 2026-06-22 ユーザー指定）。pattern1/2 の {@link scheduleHeaderLabel}（`MM/DD (曜)`）とは別表記。不正値は素返し。
 */
function p3ScheduleHeaderLabel(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return date;
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return date;
  }
  const dow = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return `${m}/${d}(${dow})`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** ヘッダーの盤面日付ラベル。`data.date` を「YYYY年M月D日」と曜日に整形する (TZ ドリフト回避に Date.UTC)。 */
function formatBoardDate(date: string): { dateText: string; dayText: string } {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return { dateText: date, dayText: "" };
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return { dateText: date, dayText: "" };
  }
  const dow = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return { dateText: `${y}年${m}月${d}日`, dayText: dow };
}

/**
 * 週間天気帯（{@link Pattern3WeeklyWeather}）1 セルの曜日・日付ラベル。`date`（'YYYY-MM-DD'）から曜日（当日は
 * 「今日」）と `M/D` を返す。TZ ドリフト回避に Date.UTC を使う（他の日付ヘルパーと同作法）。不正値は素返し。
 */
function weeklyWeatherLabel(date: string, today: string): { weekday: string; monthDay: string } {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return { weekday: "", monthDay: date };
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return { weekday: "", monthDay: date };
  }
  const dow = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return { weekday: date === today ? "今日" : dow, monthDay: `${m}/${d}` };
}

/** 実時計 HH:MM (JST)。 */
function formatClock(d: Date): string {
  return d.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * 絵文字 glyph (装飾) なので aria-hidden で出す。意味は親 span の aria-label が担保する:
 * pattern1・pattern2 いずれも予定列ヘッダーにアイコンのみを添え、可視テキストは出さない（2026-06-13 統一）。
 * 色でなく形状で区別できる単色グリフ + 代替テキスト（aria-label）で NFR05（色非依存）を満たす。
 */
const WEATHER_ICON_GLYPH: Readonly<Record<WeatherIcon, string>> = {
  sunny: "☀",
  cloudy: "☁",
  rainy: "☂",
  snowy: "❄",
  thunder: "⚡",
  unknown: "？",
};

/**
 * 広告の中身（ぼかし背景 + 前景 media + キャプション）。リンク有無で <a> でラップされ広告領域全体を
 * タップ可能にするため、中身を共通部品に切り出す。ad 変更で AdBackdrop/AdMedia の key を変えて差し替える。
 */
function AdInner({ ad }: { ad: SignagePayload["ads"][number] }) {
  return (
    <div className={styles.adContainer}>
      <AdBackdrop key={`bd-${ad.adId}`} ad={ad} />
      <div className={styles.adForeground}>
        <AdMedia key={ad.adId} ad={ad} />
      </div>
      {ad.caption ? (
        <div
          className={styles.adCaption}
          style={{ "--ad-caption-scale": String(ad.captionFontScale) } as React.CSSProperties}
        >
          {ad.caption}
        </div>
      ) : null}
    </div>
  );
}

/** 広告の背景ぼかし (v1 adBackdrop)。前景と同じ media を cover + blur で敷き余白を隠す。 */
function AdBackdrop({ ad }: { ad: SignagePayload["ads"][number] }) {
  if (ad.mediaType === "video") {
    return (
      // 装飾用の背景ぼかし動画。controls 無し = フォーカス不可で、前景動画の複製なので AT から隠す。
      // biome-ignore lint/a11y/noAriaHiddenOnFocusable: controls 無しの装飾複製背景（非フォーカス）
      <video
        className={styles.adBackdrop}
        src={ad.mediaUrl}
        muted
        autoPlay
        loop
        playsInline
        aria-hidden="true"
      />
    );
  }
  return <img className={styles.adBackdrop} src={ad.mediaUrl} alt="" aria-hidden="true" />;
}

/** 広告の前景 media (image/video)。リンク有無で <a> でラップされるため共通部品に切り出す。 */
function AdMedia({ ad }: { ad: SignagePayload["ads"][number] }) {
  if (ad.mediaType === "video") {
    return <video src={ad.mediaUrl} autoPlay muted loop playsInline className={styles.adMedia} />;
  }
  return <img src={ad.mediaUrl} alt={ad.caption ?? ""} className={styles.adMedia} />;
}

/** ローテーション位置のドット表示 (現在位置を塗り、他を半透明に)。 */
function Dots({ count, active }: { count: number; active: number }) {
  return (
    <div className={styles.adDots} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const cls = `${styles.dot} ${i === active ? styles.dotActive : ""}`;
        // 固定長の装飾ドット列。index key で十分。
        // biome-ignore lint/suspicious/noArrayIndexKey: 不変ドット列の描画
        return <span key={i} className={cls} />;
      })}
    </div>
  );
}
