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
 * - **`RateLimitExceededError` / `PiiLeakError` は `ai_extractions` には記録しない** — これらは
 *   `structureContent` が**モデル送信前**に throw し、抽出試行 (ai_extractions の意味する事象) が
 *   成立していないため (confidence/model/hash の無い空行を台帳に混ぜない)。**ただし**「ai_extractions に
 *   書かない」≠「どこにも記録しない」: 特に `PiiLeakError` は fail-closed ガード作動 = セキュリティ事象
 *   (名簿/マスク設定の不備シグナル、ルール4 / NFR03) なので、**呼び出し側 (item 2b) が構造化ログ + Sentry
 *   (ADR-013) で必ず記録する**こと。本 seam は DB/ログ口を持たないため例外をそのまま伝播するに留める。
 *   `RateLimitExceededError` は UX 事象で metrics/ログで足りる。429 / 送信中止 UX は apps/web 層 (item 4)。
 * - **`persist` の失敗は握りつぶさず伝播する** — 永続化失敗 (= 監査欠落) を呼び出し側が検知できるように。
 */

/** `ai_extractions` への永続化コールバック (DB 非依存; 呼び出し側が RLS context 内で実行)。 */
export type PersistExtraction = (row: AiExtractionInsert) => Promise<void>;

export interface RunExtractionParams {
  /** `structureContent` への要求 (kind / input / model / piiEntries / rateLimiter / schoolId 等)。 */
  request: StructureRequest;
  /** 監査行のテナント。`request.schoolId` を指定する場合は同一値である必要がある (下記ガード)。 */
  schoolId: string;
  /** 抽出元 content (事前バッチ等で未確定なら null)。 */
  contentId?: string | null;
  /** 実行者 (システム実行は null)。 */
  actorUserId?: string | null;
  /** 監査行の永続化 (呼び出し側が `withTenantContext` 内で `insertAiExtraction` を呼ぶ)。 */
  persist: PersistExtraction;
}

/** テスト用の依存差し替え (既定は実 `structureContent`)。`structureContent` 自体は別途テスト済。 */
export interface RunExtractionDeps {
  structure?: (req: StructureRequest) => Promise<StructureResult>;
}

/**
 * 構造化抽出を実行し、結果 (成功/失敗) を ai_extractions に監査記録して `StructureResult` を返す
 * (#154 item 2a)。返り値が解決した時点で監査行は永続化済 (失敗時は throw するため)。
 *
 * @throws RateLimitExceededError レート上限超過 (ai_extractions には記録せず伝播、呼び出し側が 429 に)
 * @throws PiiLeakError マスク後 PII 残存 (ai_extractions には記録せず伝播、呼び出し側がログ/Sentry + 送信中止 UX に)
 */
export async function runStructuredExtraction(
  params: RunExtractionParams,
  deps: RunExtractionDeps = {},
): Promise<StructureResult> {
  // fail-safe: rate-limit キー (request.schoolId) と監査テナント (params.schoolId) の乖離を構造排除する
  // (「A 校でレート判定し B 校台帳に記録」を型では防げないため、不一致は即エラー)。
  if (params.request.schoolId !== undefined && params.request.schoolId !== params.schoolId) {
    throw new Error(
      "runStructuredExtraction: request.schoolId と監査 schoolId が不一致です (同一 school である必要があります)。",
    );
  }

  const structure = deps.structure ?? structureContent;
  // rate-limit / PII-leak はここで throw され、ai_extractions 行を作らず呼び出し側へ伝播する。
  const result = await structure(params.request);
  const row = toAiExtractionInsert({
    schoolId: params.schoolId,
    contentId: params.contentId ?? null,
    actorUserId: params.actorUserId ?? null,
    result,
  });
  await params.persist(row);
  return result;
}
