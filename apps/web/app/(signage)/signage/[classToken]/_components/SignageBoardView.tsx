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
import type { SignagePayload } from "@/lib/signage/signage-display";
import type { SignageWeather, WeatherDay, WeatherIcon } from "@/lib/signage/weather";
import {
  BoardRegionEditButton,
  type EditRegion,
  type EditRegionsProps,
} from "./BoardRegionEditButton";
import editStyles from "./BoardRegionEditButton.module.css";
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
 * **盤面レイアウトは旧キミテラス v1 を忠実移植**: 上段(横幅いっぱい)=予定(今後3平日の3列・各列5行) /
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
}: {
  ad: SignageBoardProps["ad"];
  adLink: string | null;
  adCount: number;
  safeIndex: number;
  onAdTap: SignageBoardProps["onAdTap"];
}) {
  const hasMedia = ad != null;
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
            <p className={styles.adEmpty}>　</p>
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
              <Pattern2Callouts callouts={data.callouts} />
              <Pattern2Visitors visitors={data.visitors} />
            </div>
            <div className={styles.p2Status}>
              <Pattern2Train train={data.trainStatus} />
              <Pattern2SensorCount count={data.presenceCount} />
            </div>
          </div>
        </main>
        <AdAside
          ad={ad}
          adLink={adLink}
          adCount={adCount}
          safeIndex={safeIndex}
          onAdTap={onAdTap}
        />
        <footer className={styles.mobileFooter}>キミテラス by Rebounder</footer>
      </div>
    </div>
  );
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
    <section {...sectionProps}>
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
function Pattern2Visitors({ visitors }: { visitors: SignagePayload["visitors"] }) {
  const list = visitors ?? [];
  return (
    <section aria-label="来校者一覧" className={styles.card}>
      <h2 className={styles.cardTitle}>来校者一覧</h2>
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
function Pattern2Callouts({ callouts }: { callouts: SignagePayload["callouts"] }) {
  const list = callouts ?? [];
  // 呼び出しが 1 件以上ある時だけ左にアクセント線を立て、名指しされた生徒が気づきやすくする（提出物の
  // 期限切れ行と同じ inset box-shadow 作法）。0 件は線なしで他カードと等価に保つ（ユーザー指定 2026-06-13）。
  const hasCallouts = list.length > 0;
  return (
    <section
      aria-label="生徒呼び出し"
      className={`${styles.card} ${hasCallouts ? styles.p2CalloutsActive : ""}`}
    >
      <h2 className={styles.cardTitle}>生徒呼び出し</h2>
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
      <span className={styles.p2StatusLabel}>鉄道{train ? `・${train.operatorName}` : ""}</span>
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
      <div className={styles.scheduleGridContainer}>
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

/** 連絡事項（左下・5行）。重要マーク(isHighlight)は赤強調 + 【重要】。空きはプレースホルダーで 5 行を保つ。 */
function NoticeList({
  section,
  editRegions,
}: {
  section: MergedSection;
  editRegions?: EditRegionsProps;
}) {
  const lines = section.items.map((item) => formatSignageItem("notices", item));
  const placeholders = Math.max(0, MIN_ROWS - lines.length);
  const { sectionProps, hideHeading, button } = regionEditProps(
    "notices",
    styles.card,
    "連絡",
    editRegions,
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
      <ul className={styles.listGroup}>
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
