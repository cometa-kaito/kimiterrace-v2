import { isUuid } from "./schools-core";

/**
 * F10 (#46): 広告主とのコミュニケーション履歴 (CRM) 作成の純粋検証・型・定数。
 *
 * `"use server"` の `communications-actions.ts` は async 関数しか export できない Next の制約のため、
 * 検証・型はここに分離する (contracts-core / advertisers-core / schools-core と同構成)。`ActionResult`
 * 系の結果ヘルパは system-admin 共通の `schools-core` を再利用する。
 *
 * 値域・enum は communications スキーマ (`packages/db/src/schema/communications.ts`) に合わせる
 * (ルール3: スキーマが単一ソース)。`body_md` / `attachments_json` は text/jsonb 列だが、無制限入力を
 * 避けるため運用上の上限を設ける。
 */

/** subject 列 (varchar 300) に合わせた上限。 */
const SUBJECT_MAX = 300;
/** body_md (Markdown 営業メモ) の運用上限。巨大本文による DoS / ストレージ膨張を避ける。 */
const BODY_MAX = 20_000;
/** 添付参照配列の要素数上限。 */
const ATTACHMENTS_MAX = 50;
/** 添付参照 1 件 (Cloud Storage object パス) の文字数上限。 */
const ATTACHMENT_PATH_MAX = 1024;
/** occurred_at の妥当年範囲。タイプミス (例 0202 / 9999 年) を弾くサニティ境界。 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** communication_channel enum と同値 (packages/db `_shared/enums.ts`、ルール3)。 */
export const COMMUNICATION_CHANNELS = ["email", "phone", "meeting", "other"] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

/** 検証済みのコミュニケーション作成入力。任意項目は未指定を null / 空へ正規化する。 */
export type CommunicationCreateInput = {
  advertiserId: string;
  /** 紐づく契約 (任意)。新規 inbound 等は null。 */
  contractId: string | null;
  channel: CommunicationChannel;
  /** 発生日時 (instant)。日付のみ指定は UTC 0 時に正規化。 */
  occurredAt: Date;
  subject: string;
  /** Markdown 本文。未指定は空文字 (スキーマ default "")。 */
  bodyMd: string;
  /** Cloud Storage object 参照の配列。空配列は添付なし。 */
  attachments: string[];
};

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// timestamptz は曖昧さを避けるため明示的な timezone (Z または ±HH:MM) を必須にする。
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** "YYYY-MM-DD" の暦日が実在するか (2026-02-30 等の桁あふれを round-trip 不一致で弾く)。 */
function isRealCalendarDate(datePart: string): boolean {
  const d = new Date(`${datePart}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === datePart;
}

/**
 * occurred_at を Date へ正規化する。受け付けるのは
 * - "YYYY-MM-DD" (日付のみ → UTC 0 時)
 * - 明示 timezone 付き ISO 8601 datetime ("...Z" / "...+09:00")
 * timezone 無し datetime は instant が曖昧なため受け付けない。範囲外の年は弾く。
 *
 * 暦日の実在性は両形式で検証する。V8 は datetime の日付桁あふれ (例 2026-02-30T..Z) を翌月へ
 * rollover して valid Date を返すため、先頭 10 文字 (入力ローカルの暦日) を date-only と同じ
 * round-trip で確認して弾く。時刻の範囲 (25 時等) は new Date が NaN にするので別途検出される。
 */
function parseOccurredAt(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  let d: Date;
  if (DATE_RE.test(trimmed)) {
    if (!isRealCalendarDate(trimmed)) {
      return null;
    }
    d = new Date(`${trimmed}T00:00:00.000Z`);
  } else if (DATETIME_RE.test(trimmed)) {
    if (!isRealCalendarDate(trimmed.slice(0, 10))) {
      return null;
    }
    d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      return null;
    }
  } else {
    return null;
  }
  const year = d.getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR ? d : null;
}

/** 必須 subject。trim 後 1..SUBJECT_MAX。空/非文字列/超過は null。 */
function parseSubject(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SUBJECT_MAX) {
    return null;
  }
  return trimmed;
}

/** 任意 body_md。未指定/null は ""、非文字列/超過は undefined (呼出側が弾く)。 */
function parseBody(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length > BODY_MAX ? undefined : value;
}

/**
 * 任意 attachments。未指定/null は空配列。配列であり各要素が非空文字列かつ上限内であることを確認する
 * (object の実在検証は行わない — Cloud Storage 連携は follow-up)。不正なら undefined。
 */
function parseAttachments(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > ATTACHMENTS_MAX) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > ATTACHMENT_PATH_MAX) {
      return undefined;
    }
    out.push(trimmed);
  }
  return out;
}

/** 任意 contractId。未指定/null/空は null、UUID 形式でなければ undefined (呼出側が弾く)。 */
function parseContractId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return isUuid(value) ? value : undefined;
}

/**
 * コミュニケーション新規作成の入力検証。advertiserId / channel / occurredAt / subject は必須、
 * contractId / bodyMd / attachments は任意。不正項目ごとに日本語メッセージを返す。
 *
 * 契約と広告主の整合 (contractId が advertiserId に属するか) はここでは検証せず、実在は INSERT 時の
 * FK 制約に委ねる (contracts-core と同方針)。整合チェックは follow-up。
 */
export function validateCommunicationCreate(raw: {
  advertiserId?: unknown;
  contractId?: unknown;
  channel?: unknown;
  occurredAt?: unknown;
  subject?: unknown;
  bodyMd?: unknown;
  attachments?: unknown;
}): Validated<CommunicationCreateInput> {
  if (!isUuid(raw.advertiserId)) {
    return { ok: false, message: "広告主の指定が不正です。" };
  }
  const advertiserId = raw.advertiserId;

  const contractId = parseContractId(raw.contractId);
  if (contractId === undefined) {
    return { ok: false, message: "契約の指定が不正です。" };
  }

  if (
    typeof raw.channel !== "string" ||
    !(COMMUNICATION_CHANNELS as readonly string[]).includes(raw.channel)
  ) {
    return { ok: false, message: "チャネルが不正です。" };
  }
  const channel = raw.channel as CommunicationChannel;

  const occurredAt = parseOccurredAt(raw.occurredAt);
  if (!occurredAt) {
    return {
      ok: false,
      message: "発生日時は YYYY-MM-DD か、タイムゾーン付き ISO 8601 で入力してください。",
    };
  }

  const subject = parseSubject(raw.subject);
  if (!subject) {
    return { ok: false, message: `件名は 1〜${SUBJECT_MAX} 文字で入力してください。` };
  }

  const bodyMd = parseBody(raw.bodyMd);
  if (bodyMd === undefined) {
    return {
      ok: false,
      message: `本文は ${BODY_MAX.toLocaleString("en-US")} 文字以内にしてください。`,
    };
  }

  const attachments = parseAttachments(raw.attachments);
  if (attachments === undefined) {
    return { ok: false, message: "添付の指定が不正です。" };
  }

  return {
    ok: true,
    value: { advertiserId, contractId, channel, occurredAt, subject, bodyMd, attachments },
  };
}
