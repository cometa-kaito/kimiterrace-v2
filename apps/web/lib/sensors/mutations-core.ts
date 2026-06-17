import type { TenantRole } from "@kimiterrace/db";
import type { AuthUser } from "../auth/session";
import { canonicalizeMac } from "./switchbot";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **登録 / 編集** Server Action の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (mutations-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (ads-core.ts / hub-core.ts と同じ構成)。
 *
 * **書き込みロール (teacher は書けない)**: 自校の school_admin と、**特定校スコープの system_admin**
 * (`SENSOR_WRITE_ROLES`、ADR-041 D3)。teacher は閲覧のみ。
 * 当初は「センサーの設置/設定は自校の運用管理操作」として school_admin に限定し system_admin を**意図的に
 * 除外**していた (system_admin が `users` 行を持たず `school_id` も持たない構造制約への対処)。ADR-041 D3 で
 * これを覆し、運営によるセンサー設置代行・初期構築支援のため、system_admin も P1 パターン (明示
 * `targetSchoolId` + `tenantScoped` 降格 + 三系統 actor) で特定校のセンサーを登録/編集できるようにした
 * (ads/quiet_hours/editor と同型)。
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
 * センサーを登録/編集できるロール。自校の school_admin と、特定校スコープの system_admin (ADR-041 D3)。
 * teacher は閲覧のみ (書けない)。system_admin は `targetSchoolId` 明示時のみ実書き込み可 (越境防止は
 * `toSensorActor` + `withSession` の降格でゲート、ads-core.ts の `ADS_ROLES` と同型)。
 */
export const SENSOR_WRITE_ROLES = [
  "school_admin",
  "system_admin",
] as const satisfies readonly TenantRole[];

/**
 * mutation の実行者。`schoolId` は RLS WITH CHECK 充足 + 監査の school_id に使う (テナント外は不可)。
 *
 * **監査 actor の三系統 (CLAUDE.md ルール1 / system_admin は users 表に行を持たない、[[system-admin-not-in-users-table]])**:
 * ads-core.ts の `AdsActor` と同思想。
 * - `actorUserId`: `audit_log.actor_user_id` の操作者 uid。`tenantScoped` 降格後 (system_admin →
 *   school_admin) は `audit_log_insert` policy (0005) が `actor_user_id = app.current_user_id` を
 *   要求するため常に acting uid を入れる (school_admin はこれが users.id でもある)。FK は無い。
 * - `userRef`: `sensor_devices.created_by` / `updated_by` (users.id への FK、0014)。system_admin は
 *   users 行を持たないため **null** (FK 違反 23503 回避)。school_admin は自身の users.id。
 * - `identityUid`: `audit_log.actor_identity_uid` (IdP uid キャッシュ)。system_admin のみ記録し、
 *   school_admin は従来どおり null。
 */
export type SensorActor = {
  actorUserId: string;
  userRef: string | null;
  identityUid: string | null;
  schoolId: string;
};

/**
 * AuthUser を mutation actor に変換する (ads-core.ts の `toAdsActor` と同規律)。
 * - **system_admin**: テナント外 (session schoolId は null) のため、対象校 `targetSchoolId` を**明示**で
 *   受け取りそれを actor の schoolId にする。未指定 / UUID でないときは null (呼出側が forbidden 化)。
 *   `userRef` は null (users 行が無い → created_by/updated_by の FK 回避)、`identityUid` に uid を残す。
 * - **tenant ロール (school_admin)**: `targetSchoolId` は**無視**し必ず自校 (`user.schoolId`) に固定する
 *   (越境防止)。自校が無ければ null。
 */
export function toSensorActor(user: AuthUser, targetSchoolId?: string): SensorActor | null {
  if (user.role === "system_admin") {
    if (!isUuid(targetSchoolId)) {
      return null;
    }
    return {
      actorUserId: user.uid,
      userRef: null,
      identityUid: user.uid,
      schoolId: targetSchoolId,
    };
  }
  if (!user.schoolId) {
    return null;
  }
  return { actorUserId: user.uid, userRef: user.uid, identityUid: null, schoolId: user.schoolId };
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
