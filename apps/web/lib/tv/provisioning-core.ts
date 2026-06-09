import {
  type TvConfigEditInput,
  type TvConfigEditPatch,
  isUuid,
  validateTvConfigEdit,
} from "./config-edit-core";

/**
 * C方式 TV プロビジョニング: ジョブ作成フォームの純粋検証ロジック・型。
 *
 * `"use server"` (provisioning-actions.ts) は async 関数しか export できない Next 制約のため、検証・型は
 * ここに分離する（onboarding-core / config-edit-core と同構成）。client form (PR3) もここから型を import
 * できる（postgres を引き込まない）。
 *
 * **設計判断 — 設定フィールドは編集と共通ゆえ再利用**: `label` / `targetMac` / `schedule` /
 * `monitoringEnabled` / `notes` は config-edit と同一の検証で良いので `validateTvConfigEdit` をそのまま使う。
 * プロビジョニング固有を足す:
 *  - `schoolId`（必須 UUID）: 設置先テナント。
 *  - `classId`（必須 UUID）: サイネージ表示のクラス文脈 + 発行する magic link のスコープ。
 *  - `deviceId`（任意）: TV 生成値の転記、空欄なら Action が UUIDv4 を採番。
 *  - `targetIp`（任意）: 現地 LAN の TV の IP（`adb connect <ip>:5555` 用）。IPv4 形式のみ検証。
 * **`signageUrl` は入力でなく Action が発行する**ため core では受け取らない（config.signageUrl は常に null）。
 */

/** device_id の最大長（onboarding と同値）。 */
export const DEVICE_ID_MAX = 128;

export type ProvisioningInput = TvConfigEditInput & {
  schoolId?: unknown;
  classId?: unknown;
  deviceId?: unknown;
  targetIp?: unknown;
};

export type ProvisioningValidated = {
  schoolId: string;
  classId: string;
  /** null = 自動採番（Action が UUIDv4 を生成）。 */
  deviceId: string | null;
  targetIp: string | null;
  config: TvConfigEditPatch;
};

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * dotted-decimal の IPv4 か（4 オクテット・各 0-255）。adb 接続先の素朴な形式チェック（厳密な正規化は不要、
 * 現地オペレーターが手入力する LAN IP の typo を弾く程度）。
 */
export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * プロビジョニング入力を検証・正規化する。1 項目でも不正なら全体を拒否する。
 *
 * - `schoolId` / `classId`: UUID 必須（実在は FK / RLS が DB で担保。class が school に属すことは
 *   magic_links の composite FK (class_id, school_id) が INSERT 時に強制する）。
 * - `deviceId`: trim 後空なら null（= 自動採番）。非空は長さ上限のみ（形式は text 列で緩く受ける）。
 * - `targetIp`: trim 後空なら null。非空は IPv4 形式を要求。
 * - 設定フィールド: `validateTvConfigEdit` に委譲（signageUrl/webhookUrl は入力に含めないため null）。
 */
export function validateProvisioningInput(
  raw: ProvisioningInput,
): Validated<ProvisioningValidated> {
  if (!isUuid(raw.schoolId)) {
    return { ok: false, message: "設置先の学校を選択してください。" };
  }
  if (!isUuid(raw.classId)) {
    return { ok: false, message: "設置先のクラスを選択してください。" };
  }
  const schoolId = raw.schoolId;
  const classId = raw.classId;

  let deviceId: string | null = null;
  if (typeof raw.deviceId === "string") {
    const trimmed = raw.deviceId.trim();
    if (trimmed !== "") {
      if (trimmed.length > DEVICE_ID_MAX) {
        return { ok: false, message: `device_id は ${DEVICE_ID_MAX} 文字までです。` };
      }
      deviceId = trimmed;
    }
  }

  let targetIp: string | null = null;
  if (typeof raw.targetIp === "string") {
    const trimmed = raw.targetIp.trim();
    if (trimmed !== "") {
      if (!isValidIpv4(trimmed)) {
        return {
          ok: false,
          message: "TV の IP アドレスは IPv4 形式（例: 192.168.1.50）で入力してください。",
        };
      }
      targetIp = trimmed;
    }
  }

  // 設定フィールド（label/targetMac/schedule/monitoring/notes）は config-edit と共通。signageUrl/webhookUrl は
  // プロビジョニングでは入力しない（signageUrl は Action が発行、config_endpoint はエージェントが prefs 注入）。
  const config = validateTvConfigEdit({
    label: raw.label,
    targetMac: raw.targetMac,
    schedule: raw.schedule,
    monitoringEnabled: raw.monitoringEnabled,
    notes: raw.notes,
  });
  if (!config.ok) {
    return { ok: false, message: config.message };
  }

  return { ok: true, value: { schoolId, classId, deviceId, targetIp, config: config.value } };
}
