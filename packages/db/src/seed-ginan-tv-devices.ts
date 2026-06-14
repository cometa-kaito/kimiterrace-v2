/**
 * F15 (#... , ADR-022): 岐阜県立岐南工業高等学校「電子工学科 1〜3 年」の教室に設置する
 * **Google TV サイネージ端末**（自作 Android アプリ `com.kimiterrace.tvbridge` 稼働）を
 * v2 の `tv_devices`（TV デバイス管理）へ登録するための **シードデータ（純データ・副作用なし）**。
 * 実投入は {@link ./seed-ginan-tv-devices-cli.ts} が行う。
 *
 * ## sensor_devices シード（F13）との関係 — 別物
 * {@link ./seed-ginan-sensors.ts} は **BLE/PIR 人感センサー**の MAC レジストリ（webhook 解決用）。
 * 本ファイルは **TV 端末**そのもののリモート設定レジストリ（ポーリング設定配信 + 死活心拍、F15/ADR-022）。
 * 両者は同じ「電子工学科 1〜3 年」を対象にするが、テーブル・識別子・ライフサイクルが異なる
 * （TV は `device_id` で解決、センサーは `device_mac` で解決）。TV が BLE スキャンする対象センサー MAC を
 * `target_mac` に持たせ、両シードの対象学年が一致する（同じ教室の TV とセンサー）。
 *
 * ## device_id（ポーリング解決キー）の出典と staging 方針
 * 本番（LP / Turso）の `tv_devices.device_id` は **TV が初回起動時に生成した UUIDv4** で、Turso DB にのみ
 * 存在し本リポジトリには未コミット（取得には live TV / Turso へのアクセスが要る）。本シードの投入先は
 * **staging（合成データ）**であり実機 TV ではないため、**決定的（deterministic）な UUID 形式の値**を採番する。
 * これにより再実行が冪等になり（`ON CONFLICT (device_id) DO NOTHING`）、staging で UI / ポーリングの
 * 動作確認ができる。実機 TV への cutover 時は各 TV が自前生成した device_id で再登録する（本シードの値は使わない）。
 *
 * ## target_mac の形式（TV の BLE スキャナが消費する生の MAC）
 * `target_mac` は TV 側 BLE スキャナ（ble_recorder の `TARGET_MAC`）がそのまま使うため、**コロン区切りの
 * 生 MAC**（例 `DC:A5:B3:C2:98:D7`）を保存する（LP 本番 tv_devices.target_mac と同形）。これは webhook
 * 解決用に正規化（大文字・区切り無し）して保存する sensor_devices.device_mac とは**意図的に別形式**。
 * 値の出典は sensor シードと同じ PoC 本番実 MAC（{@link ./seed-ginan-sensors.ts} の出典コメント参照）。
 *
 * ## schedule（表示時間・曜日）の既定値
 * `scheduleJson` に学校運用の妥当な既定（平日 08:00 点灯 / 17:00 消灯）を入れる。曜日・時刻は登録後に
 * 管理 UI（/ops/tv-devices/[id]/edit）から変更できる（本機能と同時に追加）。
 *
 * ## PII 非格納（ルール4） / 監査（ルール1） / 秘密（ルール5）
 * `label` は「電子工学科 N年」という設置場所ラベルのみ（生徒名等の PII は入れない）。created_by/updated_by は
 * NULL（システム作成）。`signage_url` / `webhook_url`（秘密キーを含みうる）は本シードでは設定せず NULL とし、
 * 運用者が後から UI / Secret 経由で設定する（ルール5: 秘密をコードに焼かない）。
 */

import {
  GINAN_ECE_DEPARTMENT_NAME,
  GINAN_SCHOOL_NAME,
  canonicalizeMac,
} from "./seed-ginan-sensors.js";
import type { TvSchedule } from "./schema/tv-devices.js";

/** ラベルの上限（schema の varchar(200) に合わせる）。 */
export const TV_LABEL_MAX = 200;

/** target_mac の上限（schema の varchar(64) に合わせる）。 */
export const TV_TARGET_MAC_MAX = 64;

/**
 * TV デバイスの既定スケジュール（表示時間・曜日）。平日（月〜金）08:00〜17:00 表示。
 * weekdays は 0=日 .. 6=土（schema の TvSchedule に準拠）。登録後 UI から変更可。
 */
export const GINAN_TV_DEFAULT_SCHEDULE: TvSchedule = {
  enabled: true,
  onHour: 8,
  offHour: 17,
  weekdays: [1, 2, 3, 4, 5],
};

/** 1 台分のシード定義。`grade` は電子工学科の学年（1〜3）。 */
export interface GinanTvSeedDevice {
  /** 学年（電子工学科 1〜3 年）。class 解決と label の根拠。 */
  grade: 1 | 2 | 3;
  /**
   * ポーリング解決キー（device_id）。staging 用の決定的 UUID（出典コメント参照）。
   * 実機 cutover 時は TV 自前生成値で再登録するため、本値は staging 限定。
   */
  deviceId: string;
  /** 表示用ラベル（自由文字列・PII 非格納・<=200 文字）。 */
  label: string;
  /** BLE スキャン対象センサー MAC（コロン区切りの生形式。TV の BLE スキャナが消費）。 */
  targetMac: string;
}

/** 解決キー定数は sensor シードと共有（同じ学校・学科）。再 export して参照を一元化。 */
export { GINAN_SCHOOL_NAME, GINAN_ECE_DEPARTMENT_NAME };

/**
 * 岐南工業 電子工学科 1〜3 年に設置する TV サイネージ端末（staging 登録分）。
 * device_id は決定的 UUID（再実行冪等）。target_mac は同教室のセンサー実 MAC（コロン区切り）。
 * 増設時は本配列に追記し、ユニットテストの学年カバレッジを更新する。
 */
export const GINAN_ECE_TV_DEVICES: readonly GinanTvSeedDevice[] = [
  {
    grade: 1,
    deviceId: "0e1c0001-5ace-4b0e-9c00-000000000001",
    label: "電子工学科 1年",
    targetMac: "DC:A5:B3:C2:98:D7",
  },
  {
    grade: 2,
    deviceId: "0e1c0002-5ace-4b0e-9c00-000000000002",
    label: "電子工学科 2年",
    targetMac: "EF:64:49:02:A1:0D",
  },
  {
    grade: 3,
    deviceId: "0e1c0003-5ace-4b0e-9c00-000000000003",
    label: "電子工学科 3年",
    targetMac: "E2:E2:E8:85:3A:32",
  },
];

/** UUID（任意バージョン）形式の素朴な検証。device_id の体裁を固定する。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * シード配列の自己整合性を検証する（CLI は DB 接触前にこれで fail-fast、テストでも実行）。
 *   - device_id が UUID 形式かつグローバル一意（ポーリング解決の一意写像）
 *   - target_mac が 6 オクテットの MAC（コロン区切り）かつ <=64 文字
 *   - label が 1..200 文字
 *   - 配列が空でない / 学年が 1〜3 で重複しない
 */
export function validateGinanTvSeedDevices(
  devices: readonly GinanTvSeedDevice[] = GINAN_ECE_TV_DEVICES,
): void {
  if (devices.length === 0) {
    throw new Error("[seed-ginan-tv] device list is empty");
  }
  const seenDeviceId = new Set<string>();
  const seenGrade = new Set<number>();
  for (const d of devices) {
    if (!UUID_RE.test(d.deviceId)) {
      throw new Error(`[seed-ginan-tv] grade ${d.grade}: device_id not a UUID: ${d.deviceId}`);
    }
    if (seenDeviceId.has(d.deviceId)) {
      throw new Error(`[seed-ginan-tv] duplicate device_id: ${d.deviceId}`);
    }
    if (d.grade < 1 || d.grade > 3) {
      throw new Error(`[seed-ginan-tv] grade out of range: ${d.grade}`);
    }
    if (seenGrade.has(d.grade)) {
      throw new Error(`[seed-ginan-tv] duplicate grade: ${d.grade}`);
    }
    // target_mac は コロン区切りの生 MAC（正規化すると 12 桁 hex になることで形式を担保）。
    if (!/^[0-9A-Fa-f]{12}$/.test(canonicalizeMac(d.targetMac))) {
      throw new Error(
        `[seed-ginan-tv] grade ${d.grade}: target_mac not a 6-octet MAC: ${d.targetMac}`,
      );
    }
    if (d.targetMac.length > TV_TARGET_MAC_MAX) {
      throw new Error(`[seed-ginan-tv] grade ${d.grade}: target_mac too long: ${d.targetMac}`);
    }
    if (d.label.length === 0 || d.label.length > TV_LABEL_MAX) {
      throw new Error(`[seed-ginan-tv] grade ${d.grade}: label length out of range`);
    }
    seenDeviceId.add(d.deviceId);
    seenGrade.add(d.grade);
  }
}

/** 学年 → 既定ラベルの写像（env override 時にラベルを既定値から再利用し一貫させる）。 */
const DEFAULT_LABEL_BY_GRADE: ReadonlyMap<number, string> = new Map(
  GINAN_ECE_TV_DEVICES.map((d) => [d.grade, d.label]),
);

/** env override JSON の 1 要素の期待形（label はサーバ側で学年から導出するため受け取らない）。 */
interface TvDeviceOverrideEntry {
  grade: 1 | 2 | 3;
  deviceId: string;
  targetMac: string;
}

/** override 要素が期待形（grade 1〜3 / deviceId・targetMac が非空文字列）かを検証する。 */
function isOverrideEntry(value: unknown): value is TvDeviceOverrideEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    (v.grade === 1 || v.grade === 2 || v.grade === 3) &&
    typeof v.deviceId === "string" &&
    v.deviceId.length > 0 &&
    typeof v.targetMac === "string" &&
    v.targetMac.length > 0
  );
}

/**
 * 投入対象の TV デバイス一覧を解決する（純関数・副作用なし）。
 *
 * 本番（prod）では LP 実機が自前生成した **本物の device_id** を登録する必要があり、
 * staging のプレースホルダ（`0e1c000N…`）は使えない。env `SEED_GINAN_TV_DEVICES_JSON` を渡せば
 * コード編集なしで device_id / target_mac を差し替えられる（ルール5 の秘密ではなく、PII でもない
 * device 識別子なので env 投入で可）。
 *
 *  - `json` が undefined / 空文字 → 既定の {@link GINAN_ECE_TV_DEVICES} をそのまま返す（staging 既定）。
 *  - それ以外 → JSON.parse し、`Array<{ grade:1|2|3, deviceId:string, targetMac:string }>` を期待。
 *    `label` は受け取らず、学年ごとの既定ラベルを再利用して一貫させる（{@link DEFAULT_LABEL_BY_GRADE}）。
 *
 * 構築後は {@link validateGinanTvSeedDevices}（UUID / MAC / 重複 / ラベル長を検査）で必ず検証してから返す。
 * 不正な JSON / 未知の学年は `[seed-ginan-tv]` 付きの明示エラーで throw する（DB 接触前に fail-fast）。
 */
export function resolveGinanTvDevices(json: string | undefined): readonly GinanTvSeedDevice[] {
  if (json === undefined || json.trim().length === 0) {
    return GINAN_ECE_TV_DEVICES;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`[seed-ginan-tv] SEED_GINAN_TV_DEVICES_JSON is not valid JSON: ${reason}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("[seed-ginan-tv] SEED_GINAN_TV_DEVICES_JSON must be a JSON array");
  }

  const devices: GinanTvSeedDevice[] = parsed.map((entry, index) => {
    if (!isOverrideEntry(entry)) {
      throw new Error(
        `[seed-ginan-tv] SEED_GINAN_TV_DEVICES_JSON[${index}] must be { grade: 1|2|3, deviceId: string, targetMac: string }`,
      );
    }
    const label = DEFAULT_LABEL_BY_GRADE.get(entry.grade);
    if (label === undefined) {
      // grade は 1|2|3 に絞り込み済みだが、既定配列に該当学年が無い場合の防御（未知の学年）。
      throw new Error(
        `[seed-ginan-tv] SEED_GINAN_TV_DEVICES_JSON[${index}]: unknown grade ${entry.grade} (no default label)`,
      );
    }
    return {
      grade: entry.grade,
      deviceId: entry.deviceId,
      label,
      targetMac: entry.targetMac,
    };
  });

  // 既定経路と同じ自己整合性チェック（UUID / MAC / 重複 / ラベル長 / 学年範囲）を override にも適用。
  validateGinanTvSeedDevices(devices);
  return devices;
}
