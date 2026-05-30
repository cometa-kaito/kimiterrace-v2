/**
 * V1 Firestore エクスポートの入力契約 (#48-D)。
 *
 * 実際の Firebase エクスポートは `schools/{s}/grades/{g}/classes/{c}` のネスト構造。
 * 本移行は、その**ネストをそのまま反映した正規化 JSON** (1 ファイル) を入力に取る
 * (`docs/architecture/v1-v2-mapping.md` の Firestore→PG 対応表に準拠)。Firestore からの
 * 生エクスポート (NDJSON 等) → この形への整形は前段の取り出しスクリプトの責務とし、本ジョブは
 * 「整形済み JSON → PostgreSQL の冪等インポート」に専念する (transform を純粋に保ちテスト可能にする)。
 *
 * すべて V1 の文字列キー (`id`) を保持し、transform 側で決定論的 UUID (ids.ts) に変換する。
 */

export type V1MediaType = "image" | "video";

/** V1 `displaySettings.ads[]` の 1 要素。 */
export type V1Ad = {
  mediaUrl: string;
  mediaType: V1MediaType;
  /** 画像の表示秒数。未指定は V1 デフォルト 5。 */
  durationSec?: number;
  linkUrl?: string;
  caption?: string;
  /** V1: 0.85 / 1.0 / 1.3 / 1.6。未指定は 1。 */
  captionFontScale?: number;
  /** 配列内の表示順。未指定は配列 index を使う。 */
  displayOrder?: number;
};

/** V1 日次ドキュメント (`master_daily_data/{date}` ないしクラス別 `daily_data/{date}`)。 */
export type V1DailyDoc = {
  /** YYYY-MM-DD。 */
  date: string;
  schedules?: unknown[];
  notices?: unknown[];
  assignments?: unknown[];
  quietHours?: unknown[];
};

/** V1 設定 (`config/{kind}`)。kind は 3 種。value は本体 JSON。 */
export type V1Config = {
  kind: "display_settings" | "quiet_hours" | "schedule_templates";
  value: unknown;
};

export type V1Class = {
  id: string;
  name: string;
  academicYear: number;
  /** 学年の数値 (1〜)。 */
  grade: number;
  ads?: V1Ad[];
  dailyData?: V1DailyDoc[];
  configs?: V1Config[];
};

export type V1Grade = {
  id: string;
  name: string;
  displayOrder?: number;
  /** クラスを持たない学年は false (学年自体が 1 表示単位)。未指定は true。 */
  hasClasses?: boolean;
  /** 学科モード校で親学科を指す V1 deptId。 */
  departmentId?: string;
  classes?: V1Class[];
  ads?: V1Ad[];
  dailyData?: V1DailyDoc[];
  configs?: V1Config[];
};

export type V1Department = {
  id: string;
  name: string;
  displayOrder?: number;
  ads?: V1Ad[];
  configs?: V1Config[];
};

export type V1School = {
  id: string;
  name: string;
  /** V1 では任意。未指定は移行時に空文字を避けるため "不明" を入れる (schools.prefecture は NOT NULL)。 */
  prefecture?: string;
  code?: string;
  departments?: V1Department[];
  grades?: V1Grade[];
  /** 学校全体デフォルトの日次 (master_daily_data)。 */
  masterDailyData?: V1DailyDoc[];
  /** 学校スコープの設定・広告。 */
  configs?: V1Config[];
  ads?: V1Ad[];
};

/** 移行ジョブの入力ルート。 */
export type V1Export = {
  schools: V1School[];
};
