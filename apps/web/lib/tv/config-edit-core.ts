// 型は **client-safe な /schema サブパス**からのみ import する。barrel (`@kimiterrace/db`) は
// client.ts 経由で postgres ドライバを引き込み、"use client" なフォームにバンドルされると Turbopack が
// fs/net/tls を解決できず next build が落ちる (quiet-hours-core.ts と同じ #148 の罠)。/schema は型定義のみで
// postgres を含まないため client component / core から安全に使える。
import type { TvSchedule } from "@kimiterrace/db/schema";
import type { AuthUser } from "../auth/session";
import {
  DEFAULT_SIGNAGE_DESIGN_PATTERN,
  applyDesignPatternToUrl,
  isSignageDesignPattern,
} from "../signage/design-pattern";

/**
 * F15 §4.2 (ADR-022): TV デバイス設定編集の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (config-edit-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (quiet-hours-core.ts / ads-core.ts と同じ構成)。client form もここから
 * 型・検証を import できる（postgres を引き込まない）。
 *
 * **編集可能フィールド（オペレーター編集可能）**: `label` / `signageUrl` / `targetMac` / `webhookUrl` /
 * `scheduleJson` / `monitoringEnabled` / `notes`。これらだけを検証・正規化して DB パッチに渡す。
 * **システム管理列**（`deviceId` / `schoolId` / `version` / `lastSeenAt` / `lastKnownIp` / `lastBootAt` /
 * `appVersion` / `alertState` / `deletedAt` / 監査列 / 教室 FK）は本検証が**受け付けない**（入力に紛れても
 * 黙殺し、DB パッチへ漏らさない）。`version` は query 層が +1（ADR-022）。
 *
 * **型の単一ソース (ルール3)**: `TvSchedule` は `@kimiterrace/db/schema` から import し、手書きで再定義
 * しない。PII を入れない（`label` は設置場所ラベル、ルール4）。
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
 * TV 設定を編集できるロール。自校の school_admin と学校横断の system_admin。
 * teacher は不可 — 設定変更（サイネージ URL / センサー MAC / スケジュール）は運用権限を要するため、
 * クラス静粛時間編集 (QUIET_HOURS_ROLES) と同一境界に揃える（F15 §4.2 は school_admin によるスケジュール
 * 編集を想定、teacher は閲覧のみ）。閲覧専用の一覧 (`/app/tv-devices`) は ADMIN_ROLES（teacher 含む）の
 * ままで、書き込みだけをこの集合に絞る（多層防御の role 境界、ルール2）。
 */
export const TV_CONFIG_EDIT_ROLES = ["school_admin", "system_admin"] as const;

/**
 * TV デバイス mutation（設定編集 / コマンド発行）の実行者。
 *
 * - `userId`: **users.id**（テナントロール = school_admin）。**system_admin は `users` 行でなく
 *   `system_admins` 行**（`uid = system_admins.id`）なので、users(id) FK を持つ列
 *   （`tv_devices.updated_by` / `tv_device_commands.issued_by` / `audit_log.created_by` 等、
 *   migration 0016/0019/0004）に uid を入れると FK 違反になる → **null**（システム操作扱い、
 *   `createTvDevice` / onboarding-actions と同じ cross-tenant 監査パターン）。
 * - `identityUid`: Identity Platform UID（常に存在）。FK を持たない `audit_log.actor_identity_uid` に
 *   残し、system_admin 操作でも「誰が」を追跡可能にする（NFR04 / ルール1）。
 */
export type TvConfigEditActor = { userId: string | null; identityUid: string };

/**
 * AuthUser を TV mutation actor に変換する。`TV_CONFIG_EDIT_ROLES`（school_admin / system_admin）で
 * gate された後に呼ぶ前提（role 境界は呼出側 `requireRole` が強制する＝ルール2 多層防御の第一層。
 * `tv_devices` の RLS は school 境界のみで role を見ないため、role gate はアプリ層が担う）。
 *
 * - **system_admin**: school に属さない cross-tenant 運用者（ADR-019: 全テナント横断アクセスが必要）。
 *   `users` 行でないため FK 列に入れる `userId` は null、IdP uid を `identityUid` に載せる。書き込みは
 *   `system_admin_full_access` policy が任意校に許可する（新規登録 = onboarding と同じ cross-tenant 経路。
 *   「設定編集だけ自校未選択だと不可」という非対称＝本バグを解消する）。
 * - **school_admin**: `uid` は `users` 行。`schoolId` は `normalizeClaims` が UUID を保証済（テナントロールは
 *   school_id 必須）。RLS の `tenant_isolation` が自校に限定する（従来どおり）。
 */
export function toTvConfigEditActor(user: AuthUser): TvConfigEditActor {
  if (user.role === "system_admin") {
    return { userId: null, identityUid: user.uid };
  }
  return { userId: user.uid, identityUid: user.uid };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "HH:MM" を分換算する範囲だが schedule は hour-of-day 単位（0-23）。 */
const HOUR_MIN = 0;
const HOUR_MAX = 23;

/** 入力上限（暴走入力 / DoS 抑止、DB の varchar 長とも整合）。 */
export const LABEL_MAX = 200;
export const TARGET_MAC_MAX = 64;
/** signage_url / webhook_url は text 列だが実務上の上限を設ける（巨大入力拒否）。 */
export const URL_MAX = 2048;
export const NOTES_MAX = 2000;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 編集可能 URL（`signageUrl` / `webhookUrl`）の検証結果。
 * - `ok`: http(s) かつ外部の公開ホスト。
 * - `invalid_scheme`: パース不能 / 相対 / `javascript:` 等の非 http(s)。
 * - `internal_host`: 内部・ループバック・リンクローカル・プライベート・既知内部ホスト名（SSRF ガード）。
 */
type EditableUrlCheck = "ok" | "invalid_scheme" | "internal_host";

/**
 * **SSRF 入力境界ガード (PR #494 Reviewer Low-1 / ADR-022)**:
 * `signageUrl` / `webhookUrl` はオペレーターの自由入力。現状はサーバ側 fetch シンクが存在せず
 * （TV 端末自身がクライアント側で webhook_url を叩き signage_url を描画する＝ADR-022）、保存された
 * `http://169.254.169.254/...` は今日は不活性。だが**将来スライスがサーバ側 fetch を追加した瞬間**
 * （webhook 死活確認 / signage プレビュー検証 / F15「TV 画面キャプチャ」/ 保存 URL の任意のサーバ取得）、
 * Cloud Run のメタデータサーバ（`169.254.169.254` / `metadata.google.internal`）から SA トークンを盗む
 * HIGH severity SSRF に化ける。安価な入力境界ハードニングとして、保存時に内部宛先を弾いておく。
 *
 * ⚠️ **SSRF: これらの保存 URL を将来サーバ側で fetch する場合、保存時検証に依存してはならない。**
 * DNS-rebinding（公開ホスト名が解決のたびに内部 IP へ切り替わる攻撃）は保存時検証を素通りするため、
 * **fetch 時に解決済み IP を再検証**し（lookup を pin して接続先 IP を内部レンジと突合）、リダイレクトを
 * 追わない / 追うなら各 hop を再検証すること。実装時は `isBlockedInternalHost` を fetch 時の IP 検証にも
 * 再利用する。
 *
 * 戻り値が `true` のホストはブロック対象。`URL.hostname`（WHATWG パーサで 8/16/10 進・short-form の
 * IPv4 は dotted-decimal へ正規化済み、IPv6 は角括弧つき）を受け取る。
 */
export function isBlockedInternalHost(rawHostname: string): boolean {
  // 小文字化 → IPv6 の角括弧除去 → FQDN 絶対表記の末尾ドット 1 個除去（`metadata.google.internal.`
  // のようなサフィックス一致回避を塞ぐ）。
  let host = rawHostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }

  // 既知内部ホスト名（完全一致・サフィックス一致）。`metadata.google.internal` は GCP メタデータ。
  if (host === "localhost" || host === "metadata.google.internal") return true;
  if (host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return true;
  }

  // IPv4 リテラル（正規化済み dotted-decimal）。
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);

  // IPv6 リテラル。
  if (host.includes(":")) return isBlockedIpv6(host);

  return false;
}

/** dotted-decimal の IPv4 を `[a,b,c,d]` に。各オクテット 0-255 でなければ null。 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
  if (octets.some((o) => o > 255)) return null;
  return [octets[0], octets[1], octets[2], octets[3]];
}

/** 内部・予約 IPv4 か（loopback / link-local(+メタデータ) / RFC1918 / 0.0.0.0/8）。 */
function isBlockedIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — "this network"、多くのスタックで localhost に解決する迂回路
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local（169.254.169.254 = GCP メタデータ）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  return false;
}

/** 内部・予約 IPv6 か（loopback / unspecified / link-local / unique-local / IPv4-mapped・compatible）。 */
function isBlockedIpv6(addr: string): boolean {
  // 埋め込み IPv4 を持つ形（IPv4-mapped `::ffff:` / 廃止 IPv4-compatible `::`）は IPv4 規則で判定。
  const mapped = extractEmbeddedIpv4(addr);
  if (mapped) return isBlockedIpv4(mapped);

  if (addr === "::1") return true; // loopback
  if (addr === "::") return true; // unspecified
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  return false;
}

/**
 * 埋め込み IPv4 を持つ IPv6 から IPv4 を取り出す。
 * - IPv4-mapped `::ffff:a.b.c.d`（正規化後 `::ffff:HHHH:HHHH`）。
 * - IPv4-compatible `::a.b.c.d`（RFC4291 で deprecated、正規化後 `::HHHH:HHHH`。例:
 *   `http://[::169.254.169.254]/` → `[::a9fe:a9fe]` がメタデータ IP に化ける迂回路）。
 * dotted / 16bit hex×2 の両形に対応。`::1` / `::`（単一グループ）は本関数では拾わず呼出側で判定する。
 */
function extractEmbeddedIpv4(addr: string): [number, number, number, number] | null {
  // より具体的な `::ffff:` を先に剥がす（`::` でも startsWith するため順序重要）。
  let rest: string | null = null;
  if (addr.startsWith("::ffff:")) {
    rest = addr.slice("::ffff:".length);
  } else if (addr.startsWith("::")) {
    rest = addr.slice("::".length);
  }
  if (rest === null) return null;
  const dotted = parseIpv4(rest);
  if (dotted) return dotted;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex || hex[1] === undefined || hex[2] === undefined) return null;
  const g1 = Number.parseInt(hex[1], 16);
  const g2 = Number.parseInt(hex[2], 16);
  return [(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff];
}

/**
 * 編集可能 URL を検証する。http(s) の絶対 URL かつ外部公開ホストのみ `ok`。
 * 空文字はクリア扱いのため呼出側で `null` 判定済み（本関数には非空文字列だけ渡す）。
 */
function checkEditableUrl(value: string): EditableUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "invalid_scheme";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "invalid_scheme";
  }
  if (isBlockedInternalHost(parsed.hostname)) {
    return "internal_host";
  }
  return "ok";
}

/** weekday マスク（0=日..6=土）の配列か。重複・範囲外は拒否。 */
function validWeekdays(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  if (value.length > 7) return false;
  const seen = new Set<number>();
  for (const d of value) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) return false;
    if (seen.has(d)) return false;
    seen.add(d);
  }
  return true;
}

/** hour-of-day（0-23）の整数か。 */
function validHour(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= HOUR_MIN && value <= HOUR_MAX
  );
}

/**
 * schedule_json の入力を検証・正規化する（TvSchedule の形に収める）。null/undefined は「スケジュール無し」。
 * `enabled` 必須（boolean）。`onHour`/`offHour` は 0-23 の整数（任意）、`weekdays` は 0-6 の重複なし配列（任意）。
 * 余剰キーは落とす（既知フィールドのみ通す）。
 */
export function validateSchedule(raw: unknown): Validated<TvSchedule | null> {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "object") {
    return { ok: false, message: "スケジュールの形式が不正です。" };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.enabled !== "boolean") {
    return { ok: false, message: "スケジュールの enabled は真偽値で指定してください。" };
  }
  const out: TvSchedule = { enabled: rec.enabled };
  if (rec.onHour !== undefined) {
    if (!validHour(rec.onHour)) {
      return { ok: false, message: "表示開始時刻は 0〜23 の整数で指定してください。" };
    }
    out.onHour = rec.onHour;
  }
  if (rec.offHour !== undefined) {
    if (!validHour(rec.offHour)) {
      return { ok: false, message: "表示終了時刻は 0〜23 の整数で指定してください。" };
    }
    out.offHour = rec.offHour;
  }
  if (rec.weekdays !== undefined) {
    if (!validWeekdays(rec.weekdays)) {
      return { ok: false, message: "曜日は 0(日)〜6(土) の重複なし配列で指定してください。" };
    }
    out.weekdays = [...rec.weekdays].sort((a, b) => a - b);
  }
  return { ok: true, value: out };
}

/**
 * --- 編集フォーム ↔ TvSchedule の純変換（client-safe・単体テスト可能） ---------------------------
 *
 * client フォーム（TvConfigEditForm）が schedule を編集する際の素朴な state ⇔ `TvSchedule` の往復を
 * **純関数**として core に置く。理由: ①フォーム内インラインだと React 19 transition 絡みで RTL が flaky
 * （[[feedback_react19_transition_pending_test_flaky]]）なので変換ロジックを切り出して決定的に unit する、
 * ②表示時間（hour）と表示曜日（weekday）の UI を加える本機能（F15 §4.2）のロジック単一ソース化。
 */

/** 曜日ラベル（index 0=日 .. 6=土）。schema の weekdays（0=日..6=土）に揃える。 */
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/**
 * 編集フォームの schedule state。hour 入力は文字列で保持し送信時に数値化（空欄=未指定）。
 * `weekdays` は長さ 7 の boolean[]（index 0=日..6=土）で各曜日のチェック状態を持つ。
 */
export type TvScheduleFormState = {
  enabled: boolean;
  onHour: string;
  offHour: string;
  weekdays: boolean[];
};

/** `TvSchedule | null` をフォーム state に展開する。weekdays 未指定（=全曜日）は全チェックなしで表現。 */
export function scheduleToFormState(s: TvSchedule | null): TvScheduleFormState {
  const set = new Set(s?.weekdays ?? []);
  return {
    enabled: s?.enabled ?? false,
    onHour: s?.onHour === undefined ? "" : String(s.onHour),
    offHour: s?.offHour === undefined ? "" : String(s.offHour),
    weekdays: Array.from({ length: 7 }, (_, i) => set.has(i)),
  };
}

/** 文字列の hour 入力を数値 or undefined に。空欄は undefined、非数は NaN（Server 検証で弾く）。 */
function parseHourInput(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * フォーム state を送信用 `TvSchedule | null` に変換する。全項目が空（無効・時刻未入力・曜日未選択）なら
 * `null`（スケジュール無し）。曜日は**部分選択時のみ**配列化し、全選択 or 未選択は `weekdays` を省略する
 * （schema: 未指定 = 全曜日）。範囲・整合の最終検証は Server 側 `validateSchedule` が行う。
 */
export function formStateToScheduleInput(form: TvScheduleFormState): TvSchedule | null {
  const onHour = parseHourInput(form.onHour);
  const offHour = parseHourInput(form.offHour);
  const selectedWeekdays = form.weekdays
    .map((checked, i) => (checked ? i : -1))
    .filter((i) => i >= 0);
  // 全曜日（7 個）/ 未選択（0 個）は「毎日」とみなし weekdays を省略（冗長な全曜日配列を保存しない）。
  const includeWeekdays = selectedWeekdays.length > 0 && selectedWeekdays.length < 7;
  const hasSchedule =
    form.enabled || onHour !== undefined || offHour !== undefined || selectedWeekdays.length > 0;
  if (!hasSchedule) {
    return null;
  }
  return {
    enabled: form.enabled,
    ...(onHour !== undefined ? { onHour } : {}),
    ...(offHour !== undefined ? { offHour } : {}),
    ...(includeWeekdays ? { weekdays: selectedWeekdays } : {}),
  };
}

/**
 * 編集可能フィールドのみを取り出して検証・正規化したパッチ（query 層 `TvDeviceConfigPatch` 互換）。
 * 文字列フィールドは trim し、空文字は `null`（クリア）に正規化する。
 */
export type TvConfigEditPatch = {
  label: string | null;
  targetMac: string | null;
  signageUrl: string | null;
  webhookUrl: string | null;
  scheduleJson: TvSchedule | null;
  monitoringEnabled: boolean;
  notes: string | null;
};

export type TvConfigEditInput = {
  label?: unknown;
  targetMac?: unknown;
  signageUrl?: unknown;
  webhookUrl?: unknown;
  schedule?: unknown;
  monitoringEnabled?: unknown;
  notes?: unknown;
  /**
   * 端末別デザインパターン（`pattern1` / `pattern2` …）。**専用列は持たず** `signageUrl` の `?design=` に
   * 合成して保存する（`tv_devices` スキーマ非変更で端末別切替を実現。design-pattern.ts 参照）。未知値・
   * 未指定は既定 `pattern1`（= パラメータ無し）に倒す。`signageUrl` が空（クリア）なら design は無効。
   */
  design?: unknown;
};

/** trim 後に空なら null、長さ超過は超過フラグを返す内部ヘルパ。 */
function normStr(value: unknown, max: number): { value: string | null; tooLong: boolean } {
  if (typeof value !== "string") return { value: null, tooLong: false };
  const t = value.trim();
  if (t === "") return { value: null, tooLong: false };
  return { value: t, tooLong: t.length > max };
}

/**
 * 編集フォーム入力を検証・正規化する。**編集可能フィールドのみ**を受け取り、システム管理列は型レベルで
 * 入ってこない（万一余剰キーが来ても本関数は読まないため DB に漏れない）。1 項目でも不正なら全体を拒否。
 */
export function validateTvConfigEdit(raw: TvConfigEditInput): Validated<TvConfigEditPatch> {
  const label = normStr(raw.label, LABEL_MAX);
  if (label.tooLong) {
    return { ok: false, message: `ラベルは ${LABEL_MAX} 文字までです。` };
  }
  const targetMac = normStr(raw.targetMac, TARGET_MAC_MAX);
  if (targetMac.tooLong) {
    return { ok: false, message: `センサー MAC は ${TARGET_MAC_MAX} 文字までです。` };
  }
  const signageUrl = normStr(raw.signageUrl, URL_MAX);
  if (signageUrl.tooLong) {
    return { ok: false, message: `サイネージ URL は ${URL_MAX} 文字までです。` };
  }
  if (signageUrl.value !== null) {
    const check = checkEditableUrl(signageUrl.value);
    if (check === "invalid_scheme") {
      return { ok: false, message: "サイネージ URL は http(s) の絶対 URL を指定してください。" };
    }
    if (check === "internal_host") {
      return {
        ok: false,
        message: "サイネージ URL に内部・ローカルアドレスは指定できません。",
      };
    }
  }
  // 端末別デザインパターンを **検証済みの素の signageUrl** に合成する（host は不変なので SSRF 検証の後で
  // 安全に追記できる。pattern1（既定）は `?design` を付けない＝後方互換・URL を汚さない）。未知値・未指定は
  // 既定 pattern1 に倒す。signageUrl が null（クリア）なら design は載せる先が無いので無視する。
  const design = isSignageDesignPattern(raw.design) ? raw.design : DEFAULT_SIGNAGE_DESIGN_PATTERN;
  const composedSignageUrl =
    signageUrl.value !== null ? applyDesignPatternToUrl(signageUrl.value, design) : null;
  const webhookUrl = normStr(raw.webhookUrl, URL_MAX);
  if (webhookUrl.tooLong) {
    return { ok: false, message: `Webhook URL は ${URL_MAX} 文字までです。` };
  }
  if (webhookUrl.value !== null) {
    const check = checkEditableUrl(webhookUrl.value);
    if (check === "invalid_scheme") {
      return { ok: false, message: "Webhook URL は http(s) の絶対 URL を指定してください。" };
    }
    if (check === "internal_host") {
      return {
        ok: false,
        message: "Webhook URL に内部・ローカルアドレスは指定できません。",
      };
    }
  }
  const notes = normStr(raw.notes, NOTES_MAX);
  if (notes.tooLong) {
    return { ok: false, message: `メモは ${NOTES_MAX} 文字までです。` };
  }

  if (raw.monitoringEnabled !== undefined && typeof raw.monitoringEnabled !== "boolean") {
    return { ok: false, message: "死活監視の有効/無効は真偽値で指定してください。" };
  }
  const monitoringEnabled = raw.monitoringEnabled === undefined ? true : raw.monitoringEnabled;

  const schedule = validateSchedule(raw.schedule);
  if (!schedule.ok) {
    return schedule;
  }

  return {
    ok: true,
    value: {
      label: label.value,
      targetMac: targetMac.value,
      signageUrl: composedSignageUrl,
      webhookUrl: webhookUrl.value,
      scheduleJson: schedule.value,
      monitoringEnabled,
      notes: notes.value,
    },
  };
}
