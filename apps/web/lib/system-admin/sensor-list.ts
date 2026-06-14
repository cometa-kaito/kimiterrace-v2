import {
  type AllSensorDeviceStatus,
  type SensorHealthStatus,
  listAllSensorStatuses,
} from "@kimiterrace/db";
import {
  type ListParams,
  type SortDir,
  dateRangeBounds,
  pageWindow,
} from "@/app/_components/datalist/list-params";

/**
 * UIUX-03: システム管理者のセンサー一覧 (`/ops/sensors`) の検索/ソート/ページング層。
 * `school-list.ts` と同じく `apps/web/lib` に置く (packages/db は編集しない、並行レーン回避)。
 *
 * ## ★ SQL 側ではなく **メモリ内**でフィルタ/ソート/ページングする (意図的なフォールバック)
 * 元データは `listAllSensorStatuses` (packages/db) で、presence イベントを **MAC 正規形の
 * LEFT JOIN + GROUP BY** で畳み込み、ヘルス状態を **DB now() 基準の CASE 集計**で判定する。
 * 「直近検知」「24h 検知数」「稼働状態」は集計列のため、SQL 側で絞る場合は HAVING +
 * グループ化済みサブクエリの count が必要になり、ヘルス判定のしきい値セマンティクスを
 * apps/web 側へ複製することになる (二重管理)。
 *
 * 一方 `sensor_devices` は **1 行 = 物理 PIR センサー 1 台**の台帳で、行数は設置ハードウェアに
 * 物理的に拘束される (1 校あたり教室数台、全校でも高々数百行オーダー。現行本番は数台)。
 * 既存ページも全件を materialize して描画していたため、全件取得 → メモリ内絞り込みでも
 * DB コストは従来と同じで、集計セマンティクスは packages/db に単一ソースのまま残る。
 * よって本モジュールは既存クエリを呼んだ後にメモリ内で処理する。
 *
 * ## テナント分離 (ルール2)
 * `school_id` / role の条件は書かない — `listAllSensorStatuses` が RLS 委譲済み
 * (system_admin context では全校可視)。本層が足すのは検索条件のみ。
 */

/** SELECT だけできれば良い (既存クエリの引数型に合わせる)。 */
type Selectable = Parameters<typeof listAllSensorStatuses>[0];

/**
 * ソート可能列の allowlist (`parseListParams` の sortKeys と {@link sortValue} を 1 箇所で対応)。
 * device (MAC) はマスク表示前提の擬似識別子のためソート対象にしない。
 */
export const SENSOR_SORT_KEYS: readonly string[] = [
  "school",
  "location",
  "class",
  "installedAt",
  "lastDetectedAt",
  "detections24h",
  "status",
];

/** 稼働状態フィルタ/ソートの順序付け (運用上の注目度: 稼働中 → 静観 → 応答なし → 未検知)。 */
const STATUS_RANK: Record<SensorHealthStatus, number> = {
  healthy: 0,
  quiet: 1,
  dead: 2,
  never: 3,
};

const STATUS_FILTER_VALUES: ReadonlySet<string> = new Set(Object.keys(STATUS_RANK));

/** ヘッダの全体サマリ (フィルタ**前**の全件で算出。絞り込んでも全体像が読めるよう温存)。 */
export type SensorListSummary = {
  /** センサーが登録されている学校数。 */
  schoolCount: number;
  /** 稼働中 (未撤去) のセンサー台数。 */
  activeCount: number;
  /** 登録センサー総数 (撤去済み含む)。 */
  sensorCount: number;
};

/** 一覧 1 ページ分 + フィルタ後総件数 + フィルタ前サマリ。 */
export type SensorListPage = {
  rows: AllSensorDeviceStatus[];
  total: number;
  summary: SensorListSummary;
};

/**
 * 全校横断センサー一覧を検索 (学校名/設置場所/クラス名/デバイス MAC)・稼働状態/撤去状態フィルタ・
 * 設置日範囲・列ソート・ページングで取得する。可視範囲は RLS (呼出側 `withSession`) が決める。
 */
export async function listSensorsPage(db: Selectable, params: ListParams): Promise<SensorListPage> {
  const all = await listAllSensorStatuses(db);

  const summary: SensorListSummary = {
    schoolCount: new Set(all.map((s) => s.schoolId)).size,
    activeCount: all.filter((s) => s.decommissionedAt == null).length,
    sensorCount: all.length,
  };

  const { since, untilExclusive } = dateRangeBounds(params);
  const filtered = all.filter((s) => matches(s, params, since, untilExclusive));
  filtered.sort((a, b) => compareRows(a, b, params.sort, params.dir));

  const { limit, offset } = pageWindow(params);
  return { rows: filtered.slice(offset, offset + limit), total: filtered.length, summary };
}

/** 1 行が検索条件 (q / status / state / 設置日範囲) を満たすか。 */
function matches(
  s: AllSensorDeviceStatus,
  params: ListParams,
  since: Date | null,
  untilExclusive: Date | null,
): boolean {
  if (params.q) {
    const needle = params.q.toLowerCase();
    const textHit = [s.schoolName, s.locationLabel, s.className].some(
      (v) => v != null && v.toLowerCase().includes(needle),
    );
    // MAC は表記ゆれ (コロン/ハイフン/大小文字) を双方正規形に畳んで突き合わせる
    // (sensor-devices-status.ts の JOIN 正規形と同じ思想)。
    const macNeedle = needle.replace(/[^0-9a-z]/g, "");
    const macHit =
      macNeedle !== "" &&
      s.deviceMac
        .toLowerCase()
        .replace(/[^0-9a-z]/g, "")
        .includes(macNeedle);
    if (!textHit && !macHit) {
      return false;
    }
  }
  const status = params.filters.status;
  if (status !== undefined && STATUS_FILTER_VALUES.has(status) && s.status !== status) {
    return false;
  }
  const state = params.filters.state;
  if (state === "active" && s.decommissionedAt != null) {
    return false;
  }
  if (state === "decommissioned" && s.decommissionedAt == null) {
    return false;
  }
  // 設置日範囲 (JST 境界は dateRangeBounds が解決済み)。
  if (since && s.installedAt < since) {
    return false;
  }
  if (untilExclusive && s.installedAt >= untilExclusive) {
    return false;
  }
  return true;
}

/** ソートキー → 比較値。null は {@link compareNullable} が方向に関わらず末尾へ送る。 */
function sortValue(key: string, s: AllSensorDeviceStatus): string | number | null {
  switch (key) {
    case "school":
      return s.schoolName;
    case "location":
      return s.locationLabel;
    case "class":
      return s.className;
    case "installedAt":
      return s.installedAt.getTime();
    case "lastDetectedAt":
      return s.lastDetectedAt?.getTime() ?? null;
    case "detections24h":
      return s.detections24h;
    case "status":
      return STATUS_RANK[s.status];
    default:
      return s.schoolName;
  }
}

/** null を方向に関わらず末尾に置く比較 (SQL の `nulls last` 相当)。文字列は日本語照合。 */
function compareNullable(
  a: string | number | null,
  b: string | number | null,
  dir: SortDir,
): number {
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  const base =
    typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b, "ja")
      : (a as number) - (b as number);
  return dir === "asc" ? base : -base;
}

/**
 * 選択列で比較し、同値は既存クエリの既定並び (学校名昇順 → 稼働中先 → 直近検知が新しい順
 * → id 昇順) でタイブレークして決定的にする。
 */
function compareRows(
  a: AllSensorDeviceStatus,
  b: AllSensorDeviceStatus,
  sort: string,
  dir: SortDir,
): number {
  const primary = compareNullable(sortValue(sort, a), sortValue(sort, b), dir);
  if (primary !== 0) {
    return primary;
  }
  const school = a.schoolName.localeCompare(b.schoolName, "ja");
  if (school !== 0) {
    return school;
  }
  const active = Number(a.decommissionedAt != null) - Number(b.decommissionedAt != null);
  if (active !== 0) {
    return active;
  }
  const last = compareNullable(
    a.lastDetectedAt?.getTime() ?? null,
    b.lastDetectedAt?.getTime() ?? null,
    "desc",
  );
  if (last !== 0) {
    return last;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
