import { type AiExtractionInsert, toAiExtractionInsert } from "./audit.js";
import { type StructureRequest, type StructureResult, structureContent } from "./structure.js";

/**
 * F03 (#154 item 2a): 構造化抽出 → 監査行マッピング → 永続化 を 1 つの seam にまとめるオーケストレータ。
 *
 * `structureContent` (抽出 + PII マスキング + Zod リトライ) と `ai_extractions` への永続化
 * (#154 item 1 の `insertAiExtraction`) の間を繋ぐ薄い層。パッケージ境界を保つため DB には依存せず、
 * 永続化は `persist` コールバックに依存逆転する (呼び出し側 = apps/web の Server Action が
 * `withTenantContext` 内で `insertAiExtraction` を呼ぶ)。
 *
 * ## 監査ポリシー (本 seam が固定する判断)
 * - **モデルに到達した抽出試行 (status=success / failed) は必ず監査する** —
 *   `toAiExtractionInsert` で行へ写像し `persist` する (成功/失敗いずれも記録、#154 受け入れ条件)。
 * - **`RateLimitExceededError` / `PiiLeakError` は監査しない** — これらは `structureContent` が
 *   **モデル送信前**に throw する。抽出試行 (ai_extractions の意味する事象) ではなく呼び出し側 UX
 *   (429 / 送信中止) の領域なので、監査行を作らずそのまま伝播する (item 4 のハンドリングは apps/web 層)。
 * - **`persist` の失敗は握りつぶさず伝播する** — 永続化失敗 (= 監査欠落) を呼び出し側が検知できるように。
 */

/** `ai_extractions` への永続化コールバック (DB 非依存; 呼び出し側が RLS context 内で実行)。 */
export type PersistExtraction = (row: AiExtractionInsert) => Promise<void>;

export interface RunExtractionParams {
  /** `structureContent` への要求 (kind / input / model / piiEntries / rateLimiter / schoolId 等)。 */
  request: StructureRequest;
  /** 監査行のテナント。通常 `request.schoolId` と同一 (rateLimiter キーと監査テナントは同じ school)。 */
  schoolId: string;
  /** 抽出元 content (事前バッチ等で未確定なら null)。 */
  contentId?: string | null;
  /** 実行者 (システム実行は null)。 */
  actorUserId?: string | null;
  /** 監査行の永続化 (呼び出し側が `withTenantContext` 内で `insertAiExtraction` を呼ぶ)。 */
  persist: PersistExtraction;
}

export interface RunExtractionOutcome {
  result: StructureResult;
  /** 監査行を永続化したか。モデルに到達した試行は常に true。 */
  audited: boolean;
}

/** テスト用の依存差し替え (既定は実 `structureContent`)。`structureContent` 自体は別途テスト済。 */
export interface RunExtractionDeps {
  structure?: (req: StructureRequest) => Promise<StructureResult>;
}

/**
 * 構造化抽出を実行し、結果 (成功/失敗) を ai_extractions に監査記録する (#154 item 2a)。
 *
 * @throws RateLimitExceededError レート上限超過 (監査せず伝播、呼び出し側が 429 にマップ)
 * @throws PiiLeakError マスク後 PII 残存 (監査せず伝播、呼び出し側が送信中止 UX に)
 */
export async function runStructuredExtraction(
  params: RunExtractionParams,
  deps: RunExtractionDeps = {},
): Promise<RunExtractionOutcome> {
  const structure = deps.structure ?? structureContent;
  // rate-limit / PII-leak はここで throw され、監査行を作らず呼び出し側へ伝播する。
  const result = await structure(params.request);
  const row = toAiExtractionInsert({
    schoolId: params.schoolId,
    contentId: params.contentId ?? null,
    actorUserId: params.actorUserId ?? null,
    result,
  });
  await params.persist(row);
  return { result, audited: true };
}
