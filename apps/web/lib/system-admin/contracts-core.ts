import { isUuid } from "./schools-core";

/**
 * F10 (#46): 広告主との契約 (CRM) 作成の純粋検証・型・定数。
 *
 * `"use server"` の `contracts-actions.ts` は async 関数しか export できない Next の制約のため、
 * 検証・型はここに分離する (advertisers-core / schools-core と同構成)。`ActionResult` 系の結果ヘルパは
 * system-admin 共通の `schools-core` を再利用する (ドメイン非依存の汎用なので重複定義しない)。
 *
 * 値域・enum は contracts スキーマ (`packages/db/src/schema/contracts.ts`) に合わせる
 * (ルール3: スキーマが単一ソース)。notes は text 列だが無制限入力を避けるため運用上の上限を設ける。
 */

const NOTES_MAX = 2000;
/** 月額の運用上限 (税抜)。負値・非整数・桁あふれ入力を弾くためのサニティ上限 (1 億円/月)。 */
const FEE_MAX = 100_000_000;
/** 配信対象校配列の上限 (DoS 的な巨大配列を弾く。全国規模でも十分な余裕)。 */
const TARGET_SCHOOLS_MAX = 1000;

/** contract_status enum と同値 (packages/db `_shared/enums.ts`、ルール3)。 */
export const CONTRACT_STATUSES = ["draft", "active", "paused", "terminated"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * 契約ステータスの日本語表示ラベル。一覧・遷移ボタン等の UI で共有する単一ソース
 * (Server / Client 両方から import 可。本ファイルは server-only 値を引き込まない)。
 */
export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  draft: "下書き",
  active: "稼働中",
  paused: "一時停止",
  terminated: "終了",
};

/**
 * 契約ステータスのライフサイクル遷移表 (F10)。各 from から許される to の集合。
 * - draft: 起案中 → 有効化 (active) か取消 (terminated)。
 * - active: 稼働中 → 一時停止 (paused) か終了 (terminated)。
 * - paused: 一時停止中 → 再開 (active) か終了 (terminated)。
 * - terminated: 終端 → 以降の遷移は無い (再契約は新規行で表現する)。
 *
 * 同一ステータスへの「遷移」は集合に含めない (no-op を不正扱いにし、呼出側で弾く)。
 */
export const CONTRACT_STATUS_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["active", "terminated"],
  active: ["paused", "terminated"],
  paused: ["active", "terminated"],
  terminated: [],
};

/** from → to が許可された遷移か。同一・終端 (terminated) からの遷移は false。 */
export function isValidContractStatusTransition(from: ContractStatus, to: ContractStatus): boolean {
  return CONTRACT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * 検証済みの契約条件 (期間・月額・対象校・備考)。作成・編集で共有する可変フィールド
 * (advertiserId / status は対象外 — advertiserId は不変、status は遷移アクション管轄)。
 */
export type ContractTerms = {
  /** 契約開始日 (日付のみ、UTC 0 時に正規化)。 */
  startedAt: Date;
  /** 契約終了日 (任意、未指定は null = 無期限)。指定時は開始日以降。 */
  endedAt: Date | null;
  monthlyFeeJpy: number;
  /** 配信対象校 (schools.id の配列)。空配列は「未指定」を意味する (スキーマ doc 準拠)。 */
  targetSchools: string[];
  notes: string | null;
};

/** 検証済みの契約作成入力 (条件 + 作成時のみ指定する advertiserId / status)。 */
export type ContractCreateInput = ContractTerms & {
  advertiserId: string;
  status: ContractStatus;
};

/** 検証済みの契約編集入力 (可変フィールドのみ)。 */
export type ContractUpdateInput = ContractTerms;

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/** "YYYY-MM-DD" のみ受ける。実在日でない (例 2026-02-30) は round-trip 不一致で弾く。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return null;
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  // new Date は 2026-02-30 を 3/2 に丸めるため、ISO 先頭 10 文字の一致で実在日を保証する。
  return d.toISOString().slice(0, 10) === value ? d : null;
}

/** 月額を非負整数へ正規化する。number(整数) か数字のみ文字列を受け、範囲外/非整数は null。 */
function parseFee(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isInteger(n) || n < 0 || n > FEE_MAX) {
    return null;
  }
  return n;
}

/** 任意 notes。未指定/空は null、超過/非文字列は undefined (呼出側が弾く)。 */
function optionalNotes(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > NOTES_MAX ? undefined : trimmed;
}

/**
 * targetSchools を検証する。未指定は空配列。配列であり各要素が UUID であること、上限内であることを
 * 確認する (存在検証は行わない — jsonb で FK が無く、対象校の実在は UI の選択肢と follow-up の
 * 整合チェックで担保する)。不正なら undefined を返す。
 */
function parseTargetSchools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > TARGET_SCHOOLS_MAX) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (!isUuid(item)) {
      return undefined;
    }
    out.push(item);
  }
  return out;
}

/**
 * 契約条件 (期間・月額・対象校・備考) の共通検証。作成・編集で共有する (advertiserId / status は
 * 各呼出側が個別に検証)。startedAt / monthlyFeeJpy は必須、endedAt / targetSchools / notes は任意。
 * 終了日は開始日以降に限る。不正項目ごとに日本語メッセージを返す。
 */
function validateContractTerms(raw: {
  startedAt?: unknown;
  endedAt?: unknown;
  monthlyFeeJpy?: unknown;
  targetSchools?: unknown;
  notes?: unknown;
}): Validated<ContractTerms> {
  const startedAt = parseDateOnly(raw.startedAt);
  if (!startedAt) {
    return { ok: false, message: "開始日は YYYY-MM-DD 形式で入力してください。" };
  }

  let endedAt: Date | null = null;
  if (raw.endedAt !== undefined && raw.endedAt !== null && raw.endedAt !== "") {
    endedAt = parseDateOnly(raw.endedAt);
    if (!endedAt) {
      return { ok: false, message: "終了日は YYYY-MM-DD 形式で入力してください。" };
    }
    if (endedAt.getTime() < startedAt.getTime()) {
      return { ok: false, message: "終了日は開始日以降にしてください。" };
    }
  }

  const monthlyFeeJpy = parseFee(raw.monthlyFeeJpy);
  if (monthlyFeeJpy === null) {
    return {
      ok: false,
      message: `月額は 0〜${FEE_MAX.toLocaleString("en-US")} の整数 (円) で入力してください。`,
    };
  }

  const targetSchools = parseTargetSchools(raw.targetSchools);
  if (targetSchools === undefined) {
    return { ok: false, message: "配信対象校の指定が不正です。" };
  }

  const notes = optionalNotes(raw.notes);
  if (notes === undefined) {
    return { ok: false, message: `備考は ${NOTES_MAX} 文字以内で入力してください。` };
  }

  return { ok: true, value: { startedAt, endedAt, monthlyFeeJpy, targetSchools, notes } };
}

/**
 * 契約新規作成の入力検証。advertiserId / status を検証してから契約条件を `validateContractTerms` で
 * 検証し、合成して返す。
 */
export function validateContractCreate(raw: {
  advertiserId?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  monthlyFeeJpy?: unknown;
  targetSchools?: unknown;
  notes?: unknown;
}): Validated<ContractCreateInput> {
  if (!isUuid(raw.advertiserId)) {
    return { ok: false, message: "広告主の指定が不正です。" };
  }
  const advertiserId = raw.advertiserId;

  if (
    typeof raw.status !== "string" ||
    !(CONTRACT_STATUSES as readonly string[]).includes(raw.status)
  ) {
    return { ok: false, message: "契約ステータスが不正です。" };
  }
  const status = raw.status as ContractStatus;

  const terms = validateContractTerms(raw);
  if (!terms.ok) {
    return terms;
  }
  return { ok: true, value: { advertiserId, status, ...terms.value } };
}

/**
 * 契約編集の入力検証。可変フィールド (契約条件) のみを検証する。advertiserId は不変、status は遷移
 * アクション (`updateContractStatusAction`) の管轄なので本検証の対象外。
 */
export function validateContractUpdate(raw: {
  startedAt?: unknown;
  endedAt?: unknown;
  monthlyFeeJpy?: unknown;
  targetSchools?: unknown;
  notes?: unknown;
}): Validated<ContractUpdateInput> {
  return validateContractTerms(raw);
}
