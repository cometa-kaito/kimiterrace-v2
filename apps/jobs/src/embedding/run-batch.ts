import type { EmbeddingClient, PiiEntry } from "@kimiterrace/ai";
import {
  type KimiterraceDb,
  listSchools,
  listStaffDisplayNames,
  withTenantContext,
} from "@kimiterrace/db";
import { type EmbedPendingResult, embedPendingContent } from "./embed-content.js";
import { createPgEmbeddingPort } from "./pg-port.js";

/**
 * F06 (#398, ADR-007 / CLAUDE.md ルール2・ルール4): 全校横断の embedding 生成バッチ ドライバ。
 *
 * **全校を列挙し、校ごとに RLS スコープを張って公開コンテンツの embedding を生成する。**
 *
 * - 校列挙は `system_admin` context（`system_admin_full_access` policy で全校可視、ADR-019）。
 *   **BYPASSRLS は使わない**（ルール2）。`schoolId` を持たない system_admin は降格しない
 *   （tenant_isolation が成立せず全件不可視になるため）→ 全校が見える。
 * - 校ごとに `school_admin` 降格 context で職員氏名 roster（{@link listStaffDisplayNames}）を読み、
 *   `PiiEntry`（category=STAFF）に変換して `embedPendingContent` の確定マスクに渡す（ルール4、
 *   F03 extract-teacher-input.ts と同形）。生徒・保護者は匿名設計で roster を持たない（#289）。
 * - DB I/O の RLS 適用は {@link createPgEmbeddingPort}（校スコープのポート）に閉じる。本ドライバは
 *   「どの校を / どの名簿で」処理するかの編成だけを持つ。
 */

const APP_ROLE = "kimiterrace_app";

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
}

const ZERO_TOTALS: EmbedPendingResult = {
  scanned: 0,
  embedded: 0,
  skippedEmptyText: 0,
  blockedUnmaskedPii: 0,
};

/**
 * 全校の公開中・embedding 未生成 content_versions を走査し、PII マスキング後テキストから embedding を
 * 生成・保存する。校ごとに独立した RLS トランザクション群で実行し、1 校の失敗が他校に波及しない
 * よう編成は逐次（順序非依存）。
 *
 * @param db      非 BYPASSRLS ロールで接続した Drizzle クライアント（各 tx で kimiterrace_app に降格）
 * @param client  Vertex embedding クライアント（呼出側が project/location/modelId を注入）
 */
export async function runEmbeddingBatch(
  db: KimiterraceDb,
  client: EmbeddingClient,
  options: RunEmbeddingBatchOptions = {},
): Promise<RunEmbeddingBatchResult> {
  // 全校列挙（system_admin context、BYPASSRLS 不使用）。
  const schools = await withTenantContext(db, { role: "system_admin" }, (tx) => listSchools(tx), {
    appRole: APP_ROLE,
  });

  const perSchool: SchoolBatchResult[] = [];
  for (const school of schools) {
    // 校ごとに独立して try/catch する（1 校の DB エラー/不正データが他校の embedding 生成を止めない、
    // 順序非依存）。失敗校はエラー要約を添えて記録し継続。embedding 未生成は次回実行で再処理される
    // （resume 安全、saveContentEmbedding は冪等）。
    try {
      // 校スコープ roster（職員氏名）を school_admin 降格 context で取得。
      const staffNames = await withTenantContext(
        db,
        { schoolId: school.id, role: "school_admin" },
        (tx) => listStaffDisplayNames(tx),
        { appRole: APP_ROLE },
      );
      const maskEntries: PiiEntry[] = staffNames.map((value) => ({ value, category: "STAFF" }));

      const port = createPgEmbeddingPort(db, school.id);
      const res = await embedPendingContent(port, client, {
        batchSize: options.batchSize,
        maskEntries,
      });
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
