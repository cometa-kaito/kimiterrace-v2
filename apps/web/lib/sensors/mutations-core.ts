import type { TenantRole } from "@kimiterrace/db";
import type { AuthUser } from "../auth/session";
import { canonicalizeMac } from "./switchbot";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **登録 / 編集** Server Action の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (mutations-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (ads-core.ts / hub-core.ts と同じ構成)。
 *
 * **書き込みロール (teacher は書けない)**: 一覧ページ `/admin/sensors` は read を `PUBLISHER_ROLES`
 * (school_admin / teacher) に開くが、**mutation は school_admin のみ** (`SENSOR_WRITE_ROLES`)。
 * センサーの設置/設定は自校の運用管理操作であり、school_admin に限定する。teacher は閲覧のみ。
 * system_admin の全校横断センサー操作は別面 (`/ops/sensors`、本スライス非対象) に分けるため
 * 本集合には含めない ([[rls-tenant-not-role-boundary]] / advertisers と同じ per-surface 方針)。
 * 実データ越境は `sensor_devices` の RLS (tenant_isolation、ADR-019) が DB レベルで止め、本集合は
 * UX 層の早期 gate (`requireRole`) と Server Action の認可第一層に使う (多層防御、CLAUDE.md ルール2)。
 *
 * **PII 非格納 (ルール4 / ADR-020)**: `location_label` は教室名等の設置場所ラベルで、生徒名・保護者名等の
 * PII を入れない。本検証は長さ/書式のみを見る (内容の PII 判定はしないが、自由文字列の暴走入力を上限で防ぐ)。
 */

/** Server Action の結果。失敗は throw せず `{ ok:false }` で返し、UI 側でメッセージ表示する。 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: "invalid" | "forbidden" | "conflict" | "not_found"; message: string };
    };

export type ActionError = Extract<ActionResult<never>, { ok: false }>;

export function invalid(message: string): ActionError {
  return { ok: false, error: { code: "invalid", message } };
}
export function forbidden(message: string): ActionError {
  return { ok: false, error: { code: "forbidden", message } };
}
export function conflict(message: string): ActionError {
  return { ok: false, error: { code: "conflict", message } };
}
export function notFound(message: string): ActionError {
  return { ok: false, error: { code: "not_found", message } };
}

/**
 * センサーを登録/編集できるロール。**自校の school_admin のみ**。teacher は閲覧のみ (書けない)。
 * system_admin の全校横断操作は別面 (本スライス非対象)。
 */
export const SENSOR_WRITE_ROLES = ["school_admin"] as const satisfies readonly TenantRole[];

/** mutation の実行者。`schoolId` は RLS WITH CHECK 充足 + 監査に使う (テナント外は不可)。 */
export type SensorActor = { userId: string; schoolId: string };

/**
 * AuthUser を mutation actor に変換する。school に属さない (school_id null) 場合は null
 * (呼出側が forbidden に変換する)。`SENSOR_WRITE_ROLES` は school_admin のみなので、ここに来る時点で
 * 自校 id を持つはずだが、型安全のため明示確認する。
 */
export function toSensorActor(user: AuthUser): SensorActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** location_label の実務上限 (schema の varchar(120) に合わせる)。 */
export const LOCATION_LABEL_MAX = 120;

/**
 * device_mac の検証 + 正規化 (register のみ。edit では MAC を変更させない)。
 *
 * 受け付ける表記: 6 オクテットの 16 進 MAC を コロン (`AA:BB:CC:DD:EE:FF`) / ハイフン / 区切り無し
 * (`AABBCCDDEEFF`) のいずれでも許容し、内部では `canonicalizeMac` (大文字・区切り無し) に正規化して
 * 保存する。webhook 取り込み (`sensor-presence.ts`) も同じ正規形で events に書くため、読み取り側
 * (`listSensorDeviceStatuses` の JOIN は両辺を `upper(replace(...))` に畳む) と一貫する。
 *
 * 注: F13 §3.1 は「小文字 + コロンなし」と表現するが、本サービスの永続値 (webhook ingest) は
 * canonicalizeMac の **大文字・区切り無し**で統一されているため、登録もそれに合わせる
 * (大小は JOIN 側 `upper()` で吸収されるが、保存値の表記を 1 つに固定して曖昧さを無くす)。
 */
export function validateAndNormalizeMac(value: unknown): { ok: true; mac: string } | { ok: false } {
  if (typeof value !== "string") {
    return { ok: false };
  }
  const canon = canonicalizeMac(value);
  // 6 オクテット = 12 桁の 16 進のみ許可 (区切り除去後)。
  if (!/^[0-9A-F]{12}$/.test(canon)) {
    return { ok: false };
  }
  return { ok: true, mac: canon };
}

/** location_label の検証 + 正規化。未指定 (空) は null。指定時は 1..120 文字 (前後空白除去)。 */
export function normalizeLocationLabel(
  value: unknown,
): { ok: true; label: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, label: null };
  }
  if (typeof value !== "string") {
    return { ok: false };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, label: null };
  }
  if (trimmed.length > LOCATION_LABEL_MAX) {
    return { ok: false };
  }
  return { ok: true, label: trimmed };
}

/** classId の検証。未指定 (空) は null。指定時は UUID 形式のみ (自校可視性は DB 側で再確認する)。 */
export function normalizeClassId(
  value: unknown,
): { ok: true; classId: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, classId: null };
  }
  if (!isUuid(value)) {
    return { ok: false };
  }
  return { ok: true, classId: value };
}

/** register の検証済み入力 (DB へそのまま渡せる正規化済みの値)。 */
export type CreateSensorInput = {
  deviceMac: string;
  locationLabel: string | null;
  classId: string | null;
};

/** edit の検証済み入力 (location_label / class_id のみ。MAC は変更不可)。 */
export type UpdateSensorInput = {
  locationLabel: string | null;
  classId: string | null;
};

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/** register 入力を検証・正規化する。1 項目でも不正なら全体を拒否 (部分保存しない)。 */
export function validateCreateSensorInput(raw: {
  deviceMac?: unknown;
  locationLabel?: unknown;
  classId?: unknown;
}): Validated<CreateSensorInput> {
  const mac = validateAndNormalizeMac(raw.deviceMac);
  if (!mac.ok) {
    return {
      ok: false,
      message: "MAC アドレスは 6 オクテットの 16 進 (例: AA:BB:CC:DD:EE:FF) を入力してください。",
    };
  }
  const label = normalizeLocationLabel(raw.locationLabel);
  if (!label.ok) {
    return {
      ok: false,
      message: `設置場所ラベルは ${LOCATION_LABEL_MAX} 文字以内で入力してください。`,
    };
  }
  const cls = normalizeClassId(raw.classId);
  if (!cls.ok) {
    return { ok: false, message: "クラスの指定が不正です。" };
  }
  return {
    ok: true,
    value: { deviceMac: mac.mac, locationLabel: label.label, classId: cls.classId },
  };
}

/** edit 入力を検証・正規化する (location_label / class_id)。 */
export function validateUpdateSensorInput(raw: {
  locationLabel?: unknown;
  classId?: unknown;
}): Validated<UpdateSensorInput> {
  const label = normalizeLocationLabel(raw.locationLabel);
  if (!label.ok) {
    return {
      ok: false,
      message: `設置場所ラベルは ${LOCATION_LABEL_MAX} 文字以内で入力してください。`,
    };
  }
  const cls = normalizeClassId(raw.classId);
  if (!cls.ok) {
    return { ok: false, message: "クラスの指定が不正です。" };
  }
  return { ok: true, value: { locationLabel: label.label, classId: cls.classId } };
}
