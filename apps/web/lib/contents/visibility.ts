import type { PublishScopeValue } from "./publish-core";
import type { ContentStatusValue } from "./publish-view";

/**
 * F04 + F05/F06: 公開済みコンテンツが **生徒（magic_link 経由の匿名アクセス）に見えてよいか**の
 * 可視性判定（純粋ロジック・副作用なし）。
 *
 * F04 受け入れ条件「公開先と一致しない magic_link 経由のアクセスは 403」の決定核であり、同時に
 * F06 生徒 Q&A の RAG が **生徒のクラスに公開された掲示物のみ**を検索対象にするための前段フィルタ
 * （[[nonconflicting-feature-lane-tactics]] の student-qa スライスが要求する可視範囲制御）。
 *
 * **公開ライフサイクル（status）も判定に含める**: 生徒に見えるのは `status="published"` のみ。
 * `draft`（未公開）/ `archived`（取り下げ済）は `scope` に関わらず非可視（fail-closed）。status は
 * `scope` と直交する別概念のため、`not_published`（status 由来）と `private_scope`（scope 由来）を
 * 別 reason に分けて返す。これにより本関数は scope だけでなく**公開状態まで含めた決定核**になる。
 *
 * `publish_scope` の意味論（`publish-view.ts` SCOPE_OPTIONS と整合）:
 * - `school`   : 同一校の全生徒に公開。
 * - `class`    : `targets`（class_id 配列）に含まれるクラスの生徒のみ。
 * - `homeroom` : 担任ホームルーム（同じく `targets` の class_id）に含まれる生徒のみ。
 * - `private`  : 下書き（教員本人のみ）。**生徒には一切見せない**。
 *
 * **多層防御（CLAUDE.md ルール2）**: テナント分離は `contents` の RLS（school 境界）が DB レベルで
 * 最終強制する。本関数はその内側の **audience（scope×class）境界** をアプリ層で早期判定する gate。
 * school 不一致も RLS が 0 件化するが、ここでも明示的に弾く（防御層の重ね、F11 と同方針）。
 *
 * **空文字 sentinel 規律**: `schoolId` / `classId` の空文字 `""` は `null` と同じく「未設定」として
 * 扱う（`client.ts` の `if(ctx.schoolId)` / RLS の `NULLIF(...,'')` と整合、PR #275 で確立）。
 */

/** 可視性判定に必要なコンテンツ側の属性。`targets` は class/homeroom scope の対象 class_id 配列。 */
export interface ContentAudience {
  schoolId: string | null;
  /**
   * 公開ライフサイクル状態（`scope` と直交）。生徒に見えるのは `published` のみ。
   * `draft`（未公開）/ `archived`（取り下げ済）は scope に関わらず非可視（fail-closed）。
   */
  status: ContentStatusValue;
  scope: PublishScopeValue;
  /** class/homeroom scope の対象 class_id（DB jsonb 由来）。他 scope では無視される。 */
  targets: readonly string[];
}

/** magic_link から解決した生徒の文脈。個人特定情報は持たない（school/class のみ）。 */
export interface StudentContext {
  schoolId: string | null;
  /** 所属クラス。class/homeroom scope の突合に使う。未確定なら null。 */
  classId: string | null;
}

/** 可視性判定の結果。非可視時は機械判別可能な理由を持つ（403 のログ/分岐用）。 */
export type VisibilityDecision =
  | { visible: true }
  | { visible: false; reason: VisibilityDenyReason };

export type VisibilityDenyReason =
  /** コンテンツと生徒の所属校が異なる、または校が未設定。 */
  | "school_mismatch"
  /** status が published でない（draft / archived）。公開ライフサイクル由来の非可視。 */
  | "not_published"
  /** scope=private（下書き専用スコープ）。scope 由来の非可視（status とは別概念）。 */
  | "private_scope"
  /** class/homeroom scope だが生徒のクラスが対象外。 */
  | "out_of_scope"
  /** class/homeroom scope だが生徒のクラスが未確定（突合不能）。 */
  | "no_class_context";

const VISIBLE: VisibilityDecision = { visible: true };
const hide = (reason: VisibilityDenyReason): VisibilityDecision => ({ visible: false, reason });

/** 空文字/null を「未設定」とみなす sentinel 正規化（client.ts の `if(ctx.schoolId)` 規律と同じ）。 */
function isSet(value: string | null): value is string {
  return value != null && value !== "";
}

/**
 * 生徒が当該コンテンツを閲覧してよいかを判定する。
 *
 * 判定順: ①同一校（未設定は不可）→ ②公開ライフサイクル（published のみ）→ ③scope ごとの audience 突合。
 */
export function canStudentSeeContent(
  content: ContentAudience,
  student: StudentContext,
): VisibilityDecision {
  // ① テナント境界: 両者の school が設定済みかつ一致していること。
  if (!isSet(content.schoolId) || !isSet(student.schoolId)) return hide("school_mismatch");
  if (content.schoolId !== student.schoolId) return hide("school_mismatch");

  // ② 公開ライフサイクル: published 以外（draft/archived）は scope に関わらず非可視（fail-closed）。
  if (content.status !== "published") return hide("not_published");

  // ③ audience 境界: scope ごとに突合。
  switch (content.scope) {
    case "school":
      return VISIBLE;
    case "private":
      return hide("private_scope");
    case "class":
    case "homeroom":
      if (!isSet(student.classId)) return hide("no_class_context");
      return content.targets.includes(student.classId) ? VISIBLE : hide("out_of_scope");
    default:
      return assertNeverScope(content.scope);
  }
}

/**
 * コンテンツ配列を、生徒に見えるものだけに絞る（F06 RAG の検索対象前段フィルタ用）。
 * 元の順序を保ち、`canStudentSeeContent` が visible を返した要素のみを残す。
 */
export function filterVisibleContents<T extends ContentAudience>(
  contents: readonly T[],
  student: StudentContext,
): T[] {
  return contents.filter((c) => canStudentSeeContent(c, student).visible);
}

/**
 * DB jsonb 由来の `targets`（型は `unknown`）を string[] へ防御的に正規化する。配列でなければ空配列、
 * 配列なら string 要素のみを残す（class/homeroom 突合は class_id 文字列のみが意味を持つ）。
 */
export function normalizeTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** `switch` の網羅性をコンパイル時に担保する（scope 追加時に build を落とす、ルール3）。 */
function assertNeverScope(scope: never): never {
  throw new Error(`unhandled publish scope: ${String(scope)}`);
}
