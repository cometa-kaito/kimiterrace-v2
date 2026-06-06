import {
  type TvConfigEditInput,
  type TvConfigEditPatch,
  isUuid,
  validateTvConfigEdit,
} from "./config-edit-core";

/**
 * F15 §4.3 (ADR-022 / ADR-008): TV デバイス新規登録（オンボーディング）の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (onboarding-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する（config-edit-core.ts / ads-core.ts と同じ構成）。client form もここから
 * 型・定数を import できる（postgres を引き込まない）。
 *
 * **設計判断 — 編集との共通フィールドは再利用**: 登録フォームの設定フィールド（label / signageUrl /
 * webhookUrl / targetMac / schedule / monitoringEnabled / notes）は編集 (config-edit) と完全に同一で、
 * SSRF 入力境界ガード（内部宛先拒否）や URL/長さ/schedule 検証も同じであるべき。よって本モジュールは
 * `validateTvConfigEdit` を**そのまま再利用**し、登録に固有な 2 フィールドだけを足す:
 *  - `schoolId`（必須）: 設置先テナント。**登録時のみ**オペレーター（system_admin）が選ぶ。編集では
 *    システム管理列として遮断される（テナント移動不可）。UUID 検証のみ（実在は FK / RLS が DB で担保）。
 *  - `deviceId`（任意）: TV 生成値の転記、または空欄なら Action が UUIDv4 を自動生成（F15 §4.3）。
 *
 * **認可境界（F15 §4.3）**: 新規登録は **system_admin 限定**。編集 (TV_CONFIG_EDIT_ROLES = school_admin /
 * system_admin) より狭い。登録は cross-tenant（任意校に設置）でテナント外操作のため school_admin には開けない。
 */

/** 新規登録できるロール。F15 §4.3 で **system_admin 限定**（編集より狭い、cross-tenant のため）。 */
export const ONBOARDING_ROLES = ["system_admin"] as const;

/**
 * device_id の最大長。schema は `text`（TV の素朴実装が任意文字列を送る余地、F15 §5）だが、暴走入力 / DoS
 * 抑止のため実務上の上限を設ける。UUIDv4（36 字）+ 余裕。
 */
export const DEVICE_ID_MAX = 128;

/** 登録フォーム入力。設定フィールドは config-edit と共通、それに deviceId(任意) / schoolId(必須) を足す。 */
export type TvOnboardingInput = TvConfigEditInput & {
  deviceId?: unknown;
  schoolId?: unknown;
};

/**
 * 検証・正規化後の登録値。`deviceId` が null のときは「自動生成」を意味し、Action が UUIDv4 を採番する
 * （core は乱数生成を持たず純粋に保つ）。`config` は config-edit と同じ正規化済みパッチ。
 */
export type TvOnboardingValidated = {
  deviceId: string | null;
  schoolId: string;
  config: TvConfigEditPatch;
};

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 登録入力を検証・正規化する。1 項目でも不正なら全体を拒否する。
 *
 * - `schoolId`: UUID 必須（フォームは listSchools のドロップダウンで埋めるが、自由入力 / 改竄に備え検証）。
 *   実在チェックは行わない（FK 違反 23503 を Action が invalid に写像、RLS が越境を弾く）。
 * - `deviceId`: trim 後に空なら null（= 自動生成）。非空なら長さ上限のみ検査（形式は text 列で緩く受ける）。
 * - 設定フィールド: `validateTvConfigEdit` に委譲（SSRF ガード / URL / 長さ / schedule をまとめて検証）。
 */
export function validateTvOnboarding(raw: TvOnboardingInput): Validated<TvOnboardingValidated> {
  if (!isUuid(raw.schoolId)) {
    return { ok: false, message: "設置先の学校を選択してください。" };
  }
  const schoolId = raw.schoolId;

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

  const config = validateTvConfigEdit(raw);
  if (!config.ok) {
    return { ok: false, message: config.message };
  }

  return { ok: true, value: { deviceId, schoolId, config: config.value } };
}
