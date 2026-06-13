import {
  type RunExtractionDeps,
  type StructureRequest,
  type StructureResult,
  runStructuredExtraction,
} from "@kimiterrace/ai";
import { insertAiExtraction } from "@kimiterrace/db";
import { getCurrentUser } from "../auth/session";
import { ForbiddenError, UnauthenticatedError, withUserSession } from "../db";
import { EXTRACTION_AUTHOR_ROLES } from "./extraction-roles";

// 認可マトリクス等の node テストから引けるよう、定数は pure な `./extraction-roles` に分離した。既存 import
// 元を壊さないよう本モジュールからも re-export する（実体は単一ソース）。
export { EXTRACTION_AUTHOR_ROLES } from "./extraction-roles";

/**
 * F03 (#154 item 2): 教員入力 → AI 構造化抽出 → `ai_extractions` 監査記録 を apps/web 側で配線する seam。
 *
 * `@kimiterrace/ai` の {@link runStructuredExtraction}（抽出 + 監査行マッピング）と
 * `@kimiterrace/db` の `insertAiExtraction`（RLS context 内 INSERT）を、現在のセッションに束ねる。
 *
 * ## 設計上の判断
 * - **認証 + role ゲートを LLM 呼び出しより前に行う**: 未認可リクエストに Vertex quota を消費させない
 *   ため、`getCurrentUser` で user を解決し role を弾いてから抽出を走らせる。
 * - **LLM 呼び出しは tx の外**: `withSession` はガードと tx を一体化するため、それで包むと複数秒の生成中
 *   DB 接続を握り続ける。ここでは user を先に解決し、抽出は tx 外で実行、**永続化のみ短い tx**
 *   （`withUserSession`）で行う。`runStructuredExtraction` は `structure` 完了後に一度だけ `persist` を
 *   呼ぶため、tx は INSERT の間しか開かない。
 * - **`schoolId` はセッション由来で上書き**: 呼び出し側が渡す `request.schoolId` は信用せず、必ず
 *   `user.schoolId` を使う。これでレート制限キーと監査テナントが一致し（`runStructuredExtraction` の
 *   不一致ガードも満たす）、`tenant_isolation` policy 下での越境記録を構造排除する（ルール2 / ADR-019）。
 * - **エラー契約はそのまま伝播**: `RateLimitExceededError`（→ 429）/ `PiiLeakError`（→ 送信中止 + Sentry）の
 *   HTTP/UX マッピングは呼び出し側（route、#154 後続スライス）の責務。本 seam は握りつぶさない。
 *
 * 呼び出し側（route / Server Action）が `request`（kind / input / 実 Vertex model / piiEntries /
 * rateLimiter）を組み立てて渡す。実 Vertex 呼び出し結合テストと route/UX は #154 の後続スライス。
 */

/**
 * 教員入力 AI 抽出経路の **gate-first 認可ヘルパ**。未認証 → {@link UnauthenticatedError}、
 * 抽出作者（school_admin のみ・teacher は finding⑧ で除外）以外 → {@link ForbiddenError}。認可済み user を返す。
 *
 * transcript ロード・職員氏名 roster ロード・LLM 呼び出し**いずれより前**に呼ぶこと。RLS は
 * テナント境界のみを強制し role 境界は強制しない（ルール2）。よって同一校の非作者 role（生徒 /
 * 保護者の `__session` claim 等）が transcript（生徒文脈の自由記述を含みうる）や職員氏名 roster を
 * 読む・Vertex quota を消費する前に、この role ゲートを app 層で先に通す必要がある。
 */
export async function getAuthorizedExtractionUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  if (!(EXTRACTION_AUTHOR_ROLES as readonly string[]).includes(user.role)) {
    throw new ForbiddenError();
  }
  return user;
}

/** {@link runAndPersistExtraction} の引数。`schoolId` はセッションから強制するため受け取らない。 */
export interface RunAndPersistParams {
  /** `structureContent` への要求から `schoolId` を除いたもの（schoolId はセッションで上書きする）。 */
  request: Omit<StructureRequest, "schoolId">;
  /** 抽出元 content（事前バッチ等で未確定なら null）。 */
  contentId?: string | null;
}

/**
 * 現在のセッションで AI 構造化抽出を実行し、成功・失敗いずれの試行も `ai_extractions` に監査記録する。
 *
 * @throws {UnauthenticatedError} 未認証
 * @throws {ForbiddenError} role が抽出作者（school_admin のみ・teacher は finding⑧ で除外）でない
 * @throws RateLimitExceededError レート上限超過（ai_extractions には記録されず伝播、呼び出し側が 429 に）
 * @throws PiiLeakError マスク後 PII 残存（記録されず伝播、呼び出し側がログ/Sentry + 送信中止 UX に）
 */
export async function runAndPersistExtraction(
  params: RunAndPersistParams,
  deps?: RunExtractionDeps,
): Promise<StructureResult> {
  const user = await getAuthorizedExtractionUser();
  const { schoolId } = user;
  if (schoolId === null) {
    // school_admin（抽出作者）は必ず school 所属。null は壊れたセッション (claims 不整合) → deny。
    throw new ForbiddenError();
  }

  return await runStructuredExtraction(
    {
      request: { ...params.request, schoolId },
      schoolId,
      contentId: params.contentId ?? null,
      actorUserId: user.uid,
      persist: (row) =>
        withUserSession(user, (tx) => insertAiExtraction(tx, row).then(() => undefined)),
    },
    deps,
  );
}
