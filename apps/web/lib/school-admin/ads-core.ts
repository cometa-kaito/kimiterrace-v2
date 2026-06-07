// adMediaType は **client-safe な /schema サブパス**から import する。barrel (`@kimiterrace/db`) は
// client.ts 経由で postgres ドライバを引き込み、"use client" な AdsManager にバンドルされると
// Turbopack が fs/net/tls を解決できず next build が落ちる (#48-J Reviewer Critical-1)。
// /schema は enum/テーブル定義のみで postgres を含まないため client component から安全に使える。
import { adMediaType } from "@kimiterrace/db/schema";
import type { AuthUser } from "../auth/session";

/**
 * クラススコープ広告管理 (#48-J) の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (ads-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (hub-core.ts と同じ構成)。
 *
 * **型の単一ソース (ルール3)**: `mediaType` の許容値は `@kimiterrace/db` の `adMediaType`
 * enum (`enumValues`) から取得し、手書きで列挙しない。広告自体は PII を含まない (広告主提供の
 * 表示メディア) が、`mediaUrl` / `caption` をログへ無制限出力しない (ルール4 の精神)。
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
 * 広告を編集できるロール。自校の school_admin と学校横断の system_admin。
 * teacher は広告 (広告主コンテンツ = 収益に直結) を編集不可 (hub の階層編集と同じ境界)。
 */
export const ADS_ROLES = ["school_admin", "system_admin"] as const;

/** mutation の実行者。`schoolId` は RLS WITH CHECK 充足 + 監査に使う (テナント外は不可)。 */
export type AdsActor = { userId: string; schoolId: string };

/**
 * AuthUser を mutation actor に変換する。school に属さない (school_id null = テナント未選択の
 * system_admin) 場合は null。呼出側が forbidden に変換する。
 */
export function toAdsActor(user: AuthUser): AdsActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

/** 広告メディア種別 (image / video)。enum 単一ソースから派生 (ルール3)。 */
export type AdMediaType = (typeof adMediaType.enumValues)[number];

/** V1 が許容した文字サイズ倍率 (0.85 / 1.0 / 1.3 / 1.6)。これ以外は不正。 */
export const CAPTION_FONT_SCALES = [0.85, 1.0, 1.3, 1.6] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTION_MAX = 60; // schema の varchar(60) に合わせる
const URL_MAX = 2048; // text だが暴走入力を防ぐ実務上限
const DURATION_MIN = 1; // ck_ads_duration_positive (> 0)
const DURATION_MAX = 300; // 画像 1 枚で 5 分を上限とする (暴走防止)
const ORDER_MAX = 32767; // smallint 相当の実務上限 (hub と同じ)

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** http(s) の絶対 URL のみ許可 (javascript: 等のスキームを弾く)。1..URL_MAX 文字。 */
function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > URL_MAX) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  return trimmed;
}

/** 任意 caption: 未指定は null、指定時は 1..60 文字 (前後空白除去)。 */
function normalizeCaption(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined; // 不正 (呼出側でエラーに)
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > CAPTION_MAX) {
    return undefined;
  }
  return trimmed;
}

function normalizeInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    return null;
  }
  return n;
}

/** displayOrder: 未指定は 0。整数 0..32767 のみ。 */
function normalizeOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  return normalizeInt(value, 0, ORDER_MAX);
}

/** durationSec: 未指定は 30 秒（既定）。整数 1..300 のみ。 */
function normalizeDuration(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return 30;
  }
  return normalizeInt(value, DURATION_MIN, DURATION_MAX);
}

/** captionFontScale: 未指定は 1.0。CAPTION_FONT_SCALES のいずれかのみ。 */
function normalizeFontScale(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return 1.0;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || Number.isNaN(n)) {
    return null;
  }
  return (CAPTION_FONT_SCALES as readonly number[]).includes(n) ? n : null;
}

function isMediaType(value: unknown): value is AdMediaType {
  return typeof value === "string" && (adMediaType.enumValues as readonly string[]).includes(value);
}

/** 検証済みの広告入力 (DB へそのまま渡せる正規化済みの値)。 */
export type AdInput = {
  mediaUrl: string;
  mediaType: AdMediaType;
  durationSec: number;
  linkUrl: string | null;
  caption: string | null;
  captionFontScale: number;
  displayOrder: number;
};

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 広告入力を検証・正規化する (create / update 共通)。
 * 1 項目でも不正なら全体を拒否 (部分保存しない)。
 */
export function validateAdInput(raw: {
  mediaUrl?: unknown;
  mediaType?: unknown;
  durationSec?: unknown;
  linkUrl?: unknown;
  caption?: unknown;
  captionFontScale?: unknown;
  displayOrder?: unknown;
}): Validated<AdInput> {
  const mediaUrl = normalizeUrl(raw.mediaUrl);
  if (!mediaUrl) {
    return { ok: false, message: "メディア URL は http(s) の URL を入力してください。" };
  }
  if (!isMediaType(raw.mediaType)) {
    return { ok: false, message: "メディア種別は image / video のいずれかです。" };
  }
  const durationSec = normalizeDuration(raw.durationSec);
  if (durationSec === null) {
    return { ok: false, message: `表示秒数は ${DURATION_MIN}〜${DURATION_MAX} の整数です。` };
  }
  // linkUrl は任意。指定時は http(s) URL。
  let linkUrl: string | null = null;
  if (raw.linkUrl !== undefined && raw.linkUrl !== null && raw.linkUrl !== "") {
    const u = normalizeUrl(raw.linkUrl);
    if (!u) {
      return { ok: false, message: "リンク URL は http(s) の URL を入力してください。" };
    }
    linkUrl = u;
  }
  const caption = normalizeCaption(raw.caption);
  if (caption === undefined) {
    return { ok: false, message: `キャプションは ${CAPTION_MAX} 文字以内で入力してください。` };
  }
  const captionFontScale = normalizeFontScale(raw.captionFontScale);
  if (captionFontScale === null) {
    return { ok: false, message: "文字サイズは 0.85 / 1.0 / 1.3 / 1.6 のいずれかです。" };
  }
  const displayOrder = normalizeOrder(raw.displayOrder);
  if (displayOrder === null) {
    return { ok: false, message: "表示順は 0 以上の整数で入力してください。" };
  }
  return {
    ok: true,
    value: {
      mediaUrl,
      mediaType: raw.mediaType,
      durationSec,
      linkUrl,
      caption,
      captionFontScale,
      displayOrder,
    },
  };
}
