/**
 * F13 (#391, ADR-020): 岐阜県立岐南工業高等学校「電子工学科 1〜3 年」に **現在設置されている**
 * SwitchBot 人感センサー（PIR）を v2 の `sensor_devices`（センサー管理）へ登録するための
 * **シードデータ（純データ・副作用なし）**。実投入は {@link ./seed-ginan-sensors-cli.ts} が行う。
 *
 * ## 出典（真実ソース）
 * MAC は PoC 本番（LP / Turso）の TV 設定レジストリ `tv_devices.target_mac`（各教室に紐づく
 * BLE スキャン対象センサー MAC）を `GET /api/tv/config` で取得した実値。3 台とも直近で発報中。
 *   - 電子工学科 1年: DC:A5:B3:C2:98:D7
 *   - 電子工学科 2年: EF:64:49:02:A1:0D
 *   - 電子工学科 3年: E2:E2:E8:85:3A:32
 *
 * ## MAC 正規化（webhook ingest と一致させる）
 * v2 は device_mac を **大文字・区切り無し** の正規形で保存する（`mutations-core.ts`
 * validateAndNormalizeMac / webhook ingest `sensor-presence.ts` と同形）。これにより、登録した
 * デバイスと将来流入する presence events が解決クエリの JOIN（両辺を upper(replace(...)) に畳む）で
 * 結合する。下記 `canonicalizeMac` の真実ソースは apps/web/lib/sensors/switchbot.ts だが、packages/db は
 * apps/web に依存できないため同一ロジックを再掲し、本ファイルのユニットテストで挙動を固定する。
 *
 * ## PII 非格納（ルール4 / ADR-020）
 * `locationLabel` は「電子工学科 N年」という設置場所ラベルのみ。生徒名・保護者名・電話等の PII は
 * 一切入れない。PIR はカメラ非搭載・個人識別なし（ADR-020 §6）。
 */

/** 1 台分のシード定義。`grade` は電子工学科の学年（1〜3）。 */
export interface GinanSensorSeedDevice {
  /** 学年（電子工学科 1〜3 年）。class 解決と location_label の根拠。 */
  grade: 1 | 2 | 3;
  /** SwitchBot 表記の MAC（コロン区切り）。出典: LP 本番 tv_devices.target_mac。可読性のため保持。 */
  rawMac: string;
  /** v2 保存形（大文字・区切り無し）。`canonicalizeMac(rawMac)` と一致する（テストで固定）。 */
  deviceMac: string;
  /** 設置場所ラベル（自由文字列・PII 非格納・<=120 文字）。 */
  locationLabel: string;
}

/**
 * device MAC 正規化（大文字化 + `:` / `-` / 空白の区切り除去）。
 * 真実ソースは apps/web/lib/sensors/switchbot.ts の `canonicalizeMac`（packages/db からは依存方向の
 * 都合で import できないため同一ロジックを再掲）。webhook ingest と同じ正規形に揃えるのが目的。
 */
export function canonicalizeMac(mac: string): string {
  return mac.replace(/[\s:-]/g, "").toUpperCase();
}

/** 解決キー: 学校名（`schools.name`）。env `SEED_GINAN_SCHOOL_NAME` で上書き可。 */
export const GINAN_SCHOOL_NAME = "岐阜県立岐南工業高等学校";

/** 解決キー: 学科名（`departments.name`）。env `SEED_GINAN_DEPARTMENT_NAME` で上書き可。 */
export const GINAN_ECE_DEPARTMENT_NAME = "電子工学科";

/** location_label の上限（schema の varchar(120) に合わせる）。 */
export const LOCATION_LABEL_MAX = 120;

/**
 * 岐南工業 電子工学科 1〜3 年の設置済み SwitchBot 人感センサー（PoC 本番の実 MAC）。
 * 増設時は本配列に追記し、ユニットテストの学年カバレッジを更新する。
 */
export const GINAN_ECE_SENSOR_DEVICES: readonly GinanSensorSeedDevice[] = [
  {
    grade: 1,
    rawMac: "DC:A5:B3:C2:98:D7",
    deviceMac: "DCA5B3C298D7",
    locationLabel: "電子工学科 1年",
  },
  {
    grade: 2,
    rawMac: "EF:64:49:02:A1:0D",
    deviceMac: "EF644902A10D",
    locationLabel: "電子工学科 2年",
  },
  {
    grade: 3,
    rawMac: "E2:E2:E8:85:3A:32",
    deviceMac: "E2E2E8853A32",
    locationLabel: "電子工学科 3年",
  },
];

/**
 * シード配列の自己整合性を検証する（CLI は DB 接触前にこれで fail-fast、テストでも実行）。
 *   - deviceMac が rawMac の正規形と一致
 *   - deviceMac が 12 桁 16進（6 オクテット）の正規形
 *   - deviceMac がグローバル一意（解決の一意写像。ADR-020 のテナント越境防止と同趣旨）
 *   - locationLabel が 1..120 文字
 *   - 配列が空でない
 */
export function validateGinanSeedDevices(
  devices: readonly GinanSensorSeedDevice[] = GINAN_ECE_SENSOR_DEVICES,
): void {
  if (devices.length === 0) {
    throw new Error("[seed-ginan] device list is empty");
  }
  const seenMac = new Set<string>();
  for (const d of devices) {
    if (canonicalizeMac(d.rawMac) !== d.deviceMac) {
      throw new Error(
        `[seed-ginan] grade ${d.grade}: deviceMac (${d.deviceMac}) != canonicalizeMac(rawMac=${d.rawMac})`,
      );
    }
    if (!/^[0-9A-F]{12}$/.test(d.deviceMac)) {
      throw new Error(
        `[seed-ginan] grade ${d.grade}: deviceMac not canonical 6-octet hex: ${d.deviceMac}`,
      );
    }
    if (seenMac.has(d.deviceMac)) {
      throw new Error(`[seed-ginan] duplicate deviceMac: ${d.deviceMac}`);
    }
    if (d.locationLabel.length === 0 || d.locationLabel.length > LOCATION_LABEL_MAX) {
      throw new Error(`[seed-ginan] grade ${d.grade}: locationLabel length out of range`);
    }
    seenMac.add(d.deviceMac);
  }
}
