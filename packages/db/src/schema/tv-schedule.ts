/**
 * サイネージ TV の ON/OFF スケジュールの **型・純ロジック（単一ソース）**。
 *
 * このファイルは **drizzle / postgres を一切 import しない**。理由: `tv_devices.schedule_json` の型と
 * 解決ロジックは、サーバ（`tv-liveness` の表示制御・`lp-compat` の端末配信）だけでなく **client コンポーネント**
 * （`config-edit-core` 経由で `TvConfigEditForm "use client"` にバンドルされる）からも使う。drizzle を含む
 * `schema/index`（barrel）から VALUE を import すると pg-core が client バンドルに巻き込まれ next build が
 * 落ちる（#148 の罠）。そこで純ロジックだけをこのファイルへ隔離し、`@kimiterrace/db/tv-schedule` の専用
 * サブパスから client-safe に import できるようにする。`tv-devices.ts` はここから型を取り込み jsonb 列の
 * `$type` に使う（ルール3: 値の形も schema 由来）。
 *
 * ## 時刻の粒度・複数時間帯（2026-06 拡張）
 * 旧仕様は `onHour/offHour`（時単位・単一窓）のみ。実機 TV ブリッジ（com.kimiterrace.tvbridge）は当初から
 * 分単位（`on_minute/off_minute`）を解釈できるため、`onMinute/offMinute` を足して**分単位**を端末まで通す。
 * 複数時間帯は `windows`（{@link TvScheduleWindow} の配列）で表現する。**`windows` があればそれが正準**で、
 * legacy `onHour/offHour` より優先する（{@link resolveScheduleWindows}）。単一窓は legacy フィールドのまま
 * 保存し（既存データと完全に同形＝差分ゼロ）、複数窓のときだけ `windows` を使う。
 */

/**
 * サイネージ表示の 1 つの ON/OFF 窓（**分単位**）。`onHour:onMinute` 〜 `offHour:offMinute`（JST）に表示。
 * 複数窓（昼休み消灯など）は `TvSchedule.windows` に並べる。各窓は同日内（onTime < offTime）を前提とする
 * （日跨ぎ窓は legacy 単一窓 `onHour/offHour` のみが扱う。複数窓は同日窓に限定して曖昧さを排除する）。
 */
export type TvScheduleWindow = {
  /** 表示開始 時（JST, 0-23）。 */
  onHour: number;
  /** 表示開始 分（0-59）。 */
  onMinute: number;
  /** 表示終了 時（JST, 0-23）。 */
  offHour: number;
  /** 表示終了 分（0-59）。 */
  offMinute: number;
};

/** 複数窓の上限（端末側 AlarmManager 予約数 / UI 暴走入力の抑止）。 */
export const MAX_SCHEDULE_WINDOWS = 6;

/**
 * `schedule_json` のスキーマ型（単一ソース）。TV のサイネージ ON/OFF スケジュール（ADR-022 応答例の
 * `schedule` フィールド）。曜日マスクや時刻は PoC 運用で調整余地があるため緩く保持し、TV 側 ConfigPoller
 * がフィールドを解釈する。
 */
export type TvSchedule = {
  /** サイネージ表示を有効化するか。false なら黒画面（夜間・休日）。 */
  enabled: boolean;
  /** 表示開始時刻（JST hour-of-day, 0-23）。legacy 単一窓。`windows` があればそちらが優先。 */
  onHour?: number;
  /** 表示開始の分（0-59）。省略時は 0 分。 */
  onMinute?: number;
  /** 表示終了時刻（JST hour-of-day, 0-23）。 */
  offHour?: number;
  /** 表示終了の分（0-59）。省略時は 0 分。 */
  offMinute?: number;
  /**
   * 複数の表示時間帯（分単位）。指定時はこれが正準で legacy `onHour/offHour` より優先する。
   * 例: 昼休みに消灯したい → `[{08:00-12:00},{13:00-17:00}]`。各窓は同日内（onTime < offTime）。
   */
  windows?: TvScheduleWindow[];
  /**
   * 曜日マスク（0=日 .. 6=土）。指定曜日のみ ON。未指定は全曜日。F16 の死活誤報抑制（OFF 時間帯の
   * 閾値緩和、別スライス）が参照する。
   */
  weekdays?: number[];
};

/**
 * `schedule` を正準な窓リストへ解決する（純関数）。`windows` があればそれを、無ければ legacy 単一窓
 * （`onHour/offHour`、分は省略時 0）を 1 要素配列で返す。時刻指定が一切無ければ空配列（= 終日 ON）。
 * 表示制御（`isSignageOffHours`）・LP 互換変換・編集フォームが共通で使う単一ソース。
 */
export function resolveScheduleWindows(schedule: TvSchedule): TvScheduleWindow[] {
  if (schedule.windows && schedule.windows.length > 0) {
    return schedule.windows;
  }
  if (schedule.onHour !== undefined && schedule.offHour !== undefined) {
    return [
      {
        onHour: schedule.onHour,
        onMinute: schedule.onMinute ?? 0,
        offHour: schedule.offHour,
        offMinute: schedule.offMinute ?? 0,
      },
    ];
  }
  return [];
}

/** 窓を「当日 0 時からの分」(on/off, 0-1439) に展開する純関数。 */
export function scheduleWindowToMinutes(w: TvScheduleWindow): { on: number; off: number } {
  return { on: w.onHour * 60 + w.onMinute, off: w.offHour * 60 + w.offMinute };
}
