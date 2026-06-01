import type { EmbeddingClient, PiiEntry } from "@kimiterrace/ai";
import {
  type KimiterraceDb,
  type WithTenantContextOptions,
  listSchools,
  listStaffDisplayNames,
  withTenantContext,
} from "@kimiterrace/db";
import { type EmbedPendingResult, embedPendingContent } from "./embed-content.js";
import { createPgEmbeddingPort } from "./pg-port.js";

/**
 * F06 (#398 第2スライス, ADR-007 / CLAUDE.md ルール2・ルール4): 全校横断の embedding 生成バッチ ドライバ。
 *
 * #411（第1スライス）が用意した校スコープのポート（{@link createPgEmbeddingPort}）と本体ロジック
 * （{@link embedPendingContent}, #394）を、**全校に対して順に駆動する編成層**。Cloud Run Job entrypoint
 * （`run.ts`）と Terraform は第3スライス（deploy）に分離。
 *
 * - **校列挙は `system_admin` context**（`system_admin_full_access` policy で全校可視、ADR-019）。
 *   **BYPASSRLS は使わない**（ルール2）。`schoolId` を持たない system_admin context は school_id GUC を
 *   張らないため tenant_isolation が成立せず、PERMISSIVE な full_access のみが残り全校が見える。
 * - **校ごとは `school_admin` 降格スコープ**（ポート内部）。ここで roster（{@link listStaffDisplayNames}）も
 *   school_admin context で読み、`PiiEntry`（category=STAFF）に変換して確定マスクに渡す（ルール4、
 *   F03 extract-teacher-input と同形）。生徒・保護者は匿名設計で roster を持たない（#289）。
 * - **per-school 隔離**: 1 校の失敗（DB エラー・不正データ）が他校の embedding 生成を止めない。失敗校は
 *   エラー要約を記録して継続し、未生成 version は次回実行で再処理される（冪等・resume 安全）。
 */

/** 1 校分の処理結果（{@link EmbedPendingResult} に schoolId を添える）。 */
export interface SchoolBatchResult extends EmbedPendingResult {
  schoolId: string;
  /** その校の処理が失敗した場合のエラー要約（成功時は undefined）。生 PII を含めない。 */
  error?: string;
}

export interface RunEmbeddingBatchResult {
  /** 処理対象になった校数。 */
  schools: number;
  /** 失敗した校数（>0 なら呼出側=entrypoint は非ゼロ終了/警告ログにすべき）。 */
  failedSchools: number;
  /** 校ごとの内訳。 */
  perSchool: SchoolBatchResult[];
  /** 全校合算（成功校のみ。失敗校はゼロ寄与）。 */
  totals: EmbedPendingResult;
}

export interface RunEmbeddingBatchOptions {
  /** 1 回の Vertex `embed` 呼び出しに渡す最大件数（embedPendingContent へ委譲、既定 32）。 */
  batchSize?: number;
  /**
   * BYPASSRLS な接続（テスト superuser 等）をアプリロールへ降格する `SET LOCAL ROLE` 先。
   * 本番は最初から `kimiterrace_app` 接続のため未指定（ポート/列挙/roster の全 context に伝播）。
   */
  appRole?: string;
}

const ZERO_TOTALS: EmbedPendingResult = {
  scanned: 0,
  embedded: 0,
  skippedEmptyText: 0,
  blockedUnmaskedPii: 0,
};

/**
 * 全校の公開中・embedding 未生成 content_versions を走査し、PII マスキング後テキストから embedding を
 * 生成・保存する。校ごとに独立した RLS トランザクション群で実行する（編成は逐次・順序非依存）。
 *
 * @param db      非 BYPASSRLS ロールで接続した Drizzle クライアント（本番は `kimiterrace_app`）
 * @param client  Vertex embedding クライアント（呼出側が project/location/modelId を注入）
 */
export async function runEmbeddingBatch(
  db: KimiterraceDb,
  client: EmbeddingClient,
  options: RunEmbeddingBatchOptions = {},
): Promise<RunEmbeddingBatchResult> {
  const { batchSize, appRole } = options;
  const ctxOptions: WithTenantContextOptions = appRole !== undefined ? { appRole } : {};

  // 全校列挙（system_admin context、BYPASSRLS 不使用）。
  const schools = await withTenantContext(
    db,
    { role: "system_admin" },
    (tx) => listSchools(tx),
    ctxOptions,
  );

  const perSchool: SchoolBatchResult[] = [];
  for (const school of schools) {
    // 校ごとに独立して try/catch（1 校の失敗が他校に波及しない）。失敗校はゼロ寄与で記録し継続。
    try {
      // 校スコープ roster（職員氏名）を school_admin 降格 context で取得。
      const staffNames = await withTenantContext(
        db,
        { schoolId: school.id, role: "school_admin" },
        (tx) => listStaffDisplayNames(tx),
        ctxOptions,
      );
      const maskEntries: PiiEntry[] = staffNames.map((value) => ({ value, category: "STAFF" }));

      const port = createPgEmbeddingPort({ db, schoolId: school.id, appRole });
      const res = await embedPendingContent(port, client, { batchSize, maskEntries });
      perSchool.push({ schoolId: school.id, ...res });
    } catch (e) {
      // 生 PII を含めないため message のみ（スタックや行データは載せない）。
      const error = e instanceof Error ? e.message : String(e);
      perSchool.push({ schoolId: school.id, ...ZERO_TOTALS, error });
    }
  }

  const totals = perSchool.reduce<EmbedPendingResult>(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      embedded: acc.embedded + r.embedded,
      skippedEmptyText: acc.skippedEmptyText + r.skippedEmptyText,
      blockedUnmaskedPii: acc.blockedUnmaskedPii + r.blockedUnmaskedPii,
    }),
    { ...ZERO_TOTALS },
  );

  const failedSchools = perSchool.reduce((n, r) => n + (r.error ? 1 : 0), 0);
  return { schools: schools.length, failedSchools, perSchool, totals };
}
