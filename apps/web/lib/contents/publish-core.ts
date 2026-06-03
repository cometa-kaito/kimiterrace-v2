import type { SuggestedPeriod, SuggestedPublishScope } from "@kimiterrace/ai";
import {
  ContentNotFoundError,
  NoActivePublishError,
  type PublishActor,
  type PublishScope,
  VersionNotFoundError,
} from "@kimiterrace/db";
import type { AuthUser } from "../auth/session";

/**
 * F04 Server Actions の**純粋コア** (検証 / actor 解決 / エラーマッピング / 型)。
 *
 * `publish-actions.ts` は `"use server"` ファイルで、Next の制約上 **async 関数しか export
 * できない**。そこで非同期でない純粋ロジック・型・定数はこのモジュールに分離し、actions と
 * テストの両方から import する (node 環境で副作用なく unit テストできる)。
 */

/** 公開操作を許可するロール。system_admin は school に属さない (cross-tenant) ため除外。 */
export const PUBLISHER_ROLES = ["school_admin", "teacher"] as const;

/**
 * 公開先スコープの許可値。実体は Drizzle `publishScope` enum (packages/db) が単一ソースで、
 * DB INSERT 時に enum 型が最終強制する (ルール3)。ここでは Next バンドルに enum のランタイム値を
 * 引き込まない方針 (lib/auth/session.ts と同じ) のためローカル宣言し、入力の早期検証にのみ使う。
 *
 * `satisfies readonly PublishScope[]` で、この配列が `@kimiterrace/db` の `publishScope` enum
 * から派生した型 (`import type`、ビルド時に消去) の部分集合であることを強制する。下の
 * `_ExhaustivePublishScopeCheck` で逆向き (enum の全メンバがここに含まれる) も保証するため、
 * enum に値が増減すると CI が更新漏れを検出する (session.ts ALLOWED_ROLES と同方針)。
 */
export const PUBLISH_SCOPES = [
  "school",
  "class",
  "homeroom",
  "private",
] as const satisfies readonly PublishScope[];
export type PublishScopeValue = (typeof PUBLISH_SCOPES)[number];

// ズレ検出: publishScope enum の全メンバが PUBLISH_SCOPES に含まれることを型レベルで強制する。
// enum に値が追加 (publishScope の派生型が広がる) されると、この代入が型エラーになる (= 更新漏れを CI が検出)。
type _ExhaustivePublishScopeCheck =
  Exclude<PublishScope, PublishScopeValue> extends never ? true : never;
const _exhaustivePublishScope: _ExhaustivePublishScopeCheck = true;
void _exhaustivePublishScope;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** content.title の最大長 (DB: varchar(300))。Action 層でも早期に弾く。 */
export const TITLE_MAX_LENGTH = 300;

/** Server Action の戻り値。例外を投げ返さず、UI が分岐できる discriminated union にする。 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code:
        | "invalid_input"
        | "not_found"
        | "no_active_publish"
        | "version_not_found"
        | "forbidden"
        // ADR-030 (#426): authoring soft-gate。本文に氏名らしき高確信パターンを検出。warn のみで
        // hard-block しない (override で公開可)。`suspects` に疑わしい表層を載せ UI が提示する。
        | "pii_warning";
      message: string;
      /** `code:"pii_warning"` 時のみ。疑わしい表層 (例 `"田中さん"`)。投稿者本人へ提示する警告用。 */
      suspects?: readonly string[];
    };

export type ActionError = Extract<ActionResult<never>, { ok: false }>;

/**
 * ADR-030 (#426) soft-gate の警告結果。掲示物本文に氏名らしき高確信パターン (敬称連接) を検出した際、
 * **hard-block せず** warn して投稿者の明示 override を促す。`suspects` は投稿者本人が書いた表層なので
 * 本人への提示は新たな漏洩ではない (監査側は件数のみ記録し生氏名を複製しない、ルール4)。
 */
export function piiWarning(suspects: readonly string[]): ActionError {
  return {
    ok: false,
    code: "pii_warning",
    message:
      "本文に個人名らしき表現が含まれている可能性があります。公開掲示物に個別の生徒・保護者氏名を載せない方針です。内容を確認し、問題なければ承知の上で公開してください。",
    suspects,
  };
}

/** content 更新 patch の生入力 (フォーム / クライアントから来る、未検証)。 */
export type UpdateContentInput = {
  title?: string;
  body?: string;
  publishScope?: string;
  targets?: unknown;
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isPublishScope(value: unknown): value is PublishScopeValue {
  return typeof value === "string" && (PUBLISH_SCOPES as readonly string[]).includes(value);
}

/**
 * `targets` (DB: jsonb、配信対象の class_id 配列等) の形を検証する。配列であり、かつ
 * JSON シリアライズ可能 (循環参照などを含まない) であることを要求する。空配列は許容。
 */
export function isValidTargets(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * `updateContent` の生入力を検証する純粋関数 (Action 層から分離してテスト可能に)。
 * 問題があれば `invalid_input` エラーを、無ければ `null` を返す。
 *
 * title は #148 時点で非空のみ検証していたが、body / targets が未検証だった (Issue #150 L-1)。
 * ここで全フィールドを対称に検証する: 与えられたフィールドのみ型・形・長さを確認する
 * (undefined は「変更しない」を意味するため検証対象外)。
 */
export function validateUpdateInput(input: UpdateContentInput): ActionError | null {
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.length === 0) {
      return invalid("title が不正です。");
    }
    if (input.title.length > TITLE_MAX_LENGTH) {
      return invalid(`title は ${TITLE_MAX_LENGTH} 文字以内にしてください。`);
    }
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    return invalid("body が不正です。");
  }
  if (input.publishScope !== undefined && !isPublishScope(input.publishScope)) {
    return invalid("publishScope が不正です。");
  }
  if (input.targets !== undefined && !isValidTargets(input.targets)) {
    return invalid("targets が不正です (配列で指定してください)。");
  }
  return null;
}

/** content 新規作成の生入力 (フォーム / 抽出橋渡しから来る、未検証)。 */
export type CreateContentInput = {
  title: string;
  body?: string;
  publishScope: string;
  targets?: unknown;
};

/**
 * `createContent` の生入力を検証する純粋関数 (#509 S3a)。問題があれば `invalid_input`、無ければ null。
 * title / publishScope は **必須**、body は任意 (既定空文字)、targets は任意 (配列)。
 */
export function validateCreateInput(input: CreateContentInput): ActionError | null {
  if (typeof input.title !== "string" || input.title.length === 0) {
    return invalid("title が不正です。");
  }
  if (input.title.length > TITLE_MAX_LENGTH) {
    return invalid(`title は ${TITLE_MAX_LENGTH} 文字以内にしてください。`);
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    return invalid("body が不正です。");
  }
  if (!isPublishScope(input.publishScope)) {
    return invalid("publishScope が不正です。");
  }
  if (input.targets !== undefined && !isValidTargets(input.targets)) {
    return invalid("targets が不正です (配列で指定してください)。");
  }
  return null;
}

/**
 * 教員が公開先を明示選択するまでの既定スコープ。最も狭い「下書き（自分のみ）」(F04.4)。
 * AI 提案 (`suggestedPublishScope`) が無いときのフォールバックでもある。
 */
export const DEFAULT_PUBLISH_SCOPE = "private" satisfies PublishScopeValue;

/** AI 抽出由来の提案 (公開先・掲示期間)。いずれも任意 (AI が常に提案できるとは限らない)。 */
export type ExtractionSuggestions = {
  publishScope?: SuggestedPublishScope;
  period?: SuggestedPeriod;
};

/** 教員編集 UI に渡す既定値 (pre-fill)。期間は両端 optional (提案できた端のみ)。 */
export type EditorDefaults = {
  /** 公開先の既定選択。提案があれば採用、無ければ `DEFAULT_PUBLISH_SCOPE` (private)。 */
  publishScope: PublishScopeValue;
  /** 掲示期間の既定。提案が無ければ未設定 (両端 undefined)。 */
  period: { start?: string; end?: string };
};

/**
 * F01 (2026-06-03): AI 抽出の提案 → 教員編集 UI の既定値 (pre-fill) を解決する純粋関数。
 *
 * - `publishScope`: 提案が許可値 (`PUBLISH_SCOPES`) ならそれを既定に、無効値・未提案なら
 *   `DEFAULT_PUBLISH_SCOPE` (private) にフォールバックする。提案は強制でなく、教員はエディタで
 *   常に上書きできる (F04.4 明示選択)。AI スキーマ側で enum 検証済みだが、ここでも防御的に再検証する
 *   (越境入力を信用しない・ルール2 と同じ姿勢)。
 * - `period`: 提案できた端だけを反映する。文字列でない端は落とす (空文字・型不一致を弾く)。提案が無ければ
 *   両端 undefined (従来どおり期間未設定)。掲示期間は ISO 文字列の入れ物のみで、ここで暦解釈はしない。
 */
export function resolveEditorDefaults(suggestions?: ExtractionSuggestions): EditorDefaults {
  const publishScope = isPublishScope(suggestions?.publishScope)
    ? suggestions.publishScope
    : DEFAULT_PUBLISH_SCOPE;

  const period: { start?: string; end?: string } = {};
  const start = suggestions?.period?.start;
  const end = suggestions?.period?.end;
  if (typeof start === "string" && start.length > 0) {
    period.start = start;
  }
  if (typeof end === "string" && end.length > 0) {
    period.end = end;
  }

  return { publishScope, period };
}

/** invalid_input エラーを作る。 */
export function invalid(message: string): ActionError {
  return { ok: false, code: "invalid_input", message };
}

/** forbidden エラーを作る。 */
export function forbidden(message: string): ActionError {
  return { ok: false, code: "forbidden", message };
}

/**
 * 認証済み user から publish actor を作る。テナントロールは schoolId 必須。
 * schoolId が無い (= system_admin / 異常) なら null を返し、呼出側が forbidden に倒す。
 */
export function toActor(user: AuthUser): PublishActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

/** ドメイン例外を ActionResult のエラーにマッピングする (純粋関数、テスト対象)。 */
export function mapDomainError(error: unknown): ActionError {
  if (error instanceof ContentNotFoundError) {
    return { ok: false, code: "not_found", message: "コンテンツが見つかりません。" };
  }
  if (error instanceof NoActivePublishError) {
    return { ok: false, code: "no_active_publish", message: "公開中のバージョンがありません。" };
  }
  if (error instanceof VersionNotFoundError) {
    return { ok: false, code: "version_not_found", message: "指定したバージョンが存在しません。" };
  }
  // 想定外の例外は握りつぶさず再 throw (Next がログ + 500 にする。秘密を結果に載せない)。
  throw error;
}
