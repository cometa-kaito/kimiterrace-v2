import { type EmbeddingClient, type PiiEntry, createVertexEmbeddingClient } from "@kimiterrace/ai";
import {
  createDbClient,
  listSchools,
  listStaffDisplayNames,
  withTenantContext,
} from "@kimiterrace/db";
import { type EmbeddingBatchPort, embedPendingContent } from "./embed-content.js";
import { createPgEmbeddingPort } from "./pg-port.js";

/**
 * F06 (#398, #365, ADR-007 / CLAUDE.md ルール4): 公開コンテンツ embedding 生成バッチの全校横断ドライバ
 * と Cloud Run Job エントリ。
 *
 * I/O 結線（DB 接続 / Vertex クライアント / env 読取）は本ファイルに集約し、全校ループの
 * オーケストレーション（`embedAllSchools`）は依存注入で純粋に保ってフェイクで単体検証できるようにする
 * （`migration/firestore-to-pg.ts` と同じ構成）。
 *
 * ## テナント分離 (ルール2)
 * 校の列挙は `system_admin` コンテキスト（`listSchools` が全校 SELECT 可、ADR-019 の
 * `system_admin_full_access`）で行い、各校の embedding 処理は `school_admin` に降格した
 * `createPgEmbeddingPort` で行う。**BYPASSRLS は使わない**（移行ジョブと異なり 1 校スコープで走る）。
 */

/** 1 校分の処理結果（`embedPendingContent` の結果 + 校 id）。 */
export type SchoolEmbeddingResult = {
  schoolId: string;
  scanned: number;
  embedded: number;
  skippedEmptyText: number;
  /** マスク後も PII 形跡が残り Vertex へ送らず skip した件数（fail-closed、ルール4）。0 が正常。 */
  blockedUnmaskedPii: number;
};

/** バッチ全体のサマリ。Cloud Logging に構造化ログとして残す（secret は含めない）。 */
export type EmbeddingBatchSummary = {
  schools: number;
  scanned: number;
  embedded: number;
  skippedEmptyText: number;
  /** 全校合算の fail-closed skip 件数。非 0 は roster 欠落 / 新 PII 書式の兆候で要調査（ルール4）。 */
  blockedUnmaskedPii: number;
  perSchool: SchoolEmbeddingResult[];
};

/** `embedAllSchools` の依存（実 PG / Vertex をフェイクに差し替えて単体検証するための注入点）。 */
export interface EmbedAllSchoolsDeps {
  /** 処理対象の校 id を列挙する（実体は system_admin context の `listSchools`）。 */
  listSchoolIds(): Promise<string[]>;
  /** 校ごとの `EmbeddingBatchPort` を作る（実体は `createPgEmbeddingPort`）。 */
  makePort(schoolId: string): EmbeddingBatchPort;
  /** Vertex embedding クライアント（全校で共有）。 */
  client: EmbeddingClient;
  /** 1 回の embed 呼び出しに渡す最大件数。 */
  batchSize?: number;
  /**
   * 校スコープの名簿（氏名マスク用、ルール4）を非同期に供給する。掲示物本文に生徒/保護者氏名が含まれる
   * 場合の確定マスクに使う。実体は school_admin context での職員 roster 読取（`listStaffDisplayNames`、
   * #417）。DB I/O を伴うため async。未指定は空（`maskPII` の電話・メール正規表現検出のみ）。
   */
  maskEntriesFor?(schoolId: string): Promise<readonly PiiEntry[]>;
}

/**
 * 全校を順に処理し、サマリを集計する（純粋オーケストレーション、DB/Vertex は注入）。
 *
 * 1 校でも失敗すると例外を伝播させる（fail-fast）。バッチは冪等（`embedding IS NULL` の残りだけ拾う）
 * なので、再実行で未処理校を回収できる。校単位のエラー分離は follow-up。
 */
export async function embedAllSchools(deps: EmbedAllSchoolsDeps): Promise<EmbeddingBatchSummary> {
  const schoolIds = await deps.listSchoolIds();
  const perSchool: SchoolEmbeddingResult[] = [];
  for (const schoolId of schoolIds) {
    const port = deps.makePort(schoolId);
    const maskEntries = (await deps.maskEntriesFor?.(schoolId)) ?? [];
    const result = await embedPendingContent(port, deps.client, {
      batchSize: deps.batchSize,
      maskEntries,
    });
    perSchool.push({ schoolId, ...result });
  }
  return {
    schools: schoolIds.length,
    scanned: perSchool.reduce((s, r) => s + r.scanned, 0),
    embedded: perSchool.reduce((s, r) => s + r.embedded, 0),
    skippedEmptyText: perSchool.reduce((s, r) => s + r.skippedEmptyText, 0),
    blockedUnmaskedPii: perSchool.reduce((s, r) => s + r.blockedUnmaskedPii, 0),
    perSchool,
  };
}

export type RunEmbeddingBatchConfig = {
  /** DB 接続文字列（kimiterrace_app ロール。Secret Manager 経由で注入、ルール5）。 */
  databaseUrl: string;
  /** GCP プロジェクト ID。 */
  project: string;
  /** Vertex リージョン（asia-northeast1 固定運用、NFR07）。 */
  location: string;
  /** embedding モデル ID。未指定なら client 既定。 */
  modelId?: string;
  /** 1 回の embed 呼び出しに渡す最大件数。 */
  batchSize?: number;
  /** テスト用: BYPASSRLS 接続をアプリロールへ降格する SET LOCAL ROLE 先。本番は未指定。 */
  appRole?: string;
};

/**
 * 実 PG + Vertex で全校バッチを実行する。接続は本関数が開き、終了時に必ず閉じる。
 * env 読取・プロセス終了コードは entrypoint (`embed-job.ts`) が担う（`migration/import.ts` と同じ分離）。
 */
export async function runEmbeddingBatch(
  config: RunEmbeddingBatchConfig,
): Promise<EmbeddingBatchSummary> {
  const { sql, db } = createDbClient(config.databaseUrl);
  const client = createVertexEmbeddingClient({
    project: config.project,
    location: config.location,
    modelId: config.modelId,
  });
  const appRoleOptions = config.appRole !== undefined ? { appRole: config.appRole } : {};
  try {
    return await embedAllSchools({
      // 校列挙は system_admin context（全校 SELECT、ルール2）。BYPASSRLS 不使用。
      listSchoolIds: async () => {
        const schools = await withTenantContext(
          db,
          { role: "system_admin" },
          (tx) => listSchools(tx),
          appRoleOptions,
        );
        return schools.map((s) => s.id);
      },
      makePort: (schoolId) => createPgEmbeddingPort({ db, schoolId, appRole: config.appRole }),
      // 校スコープ roster（職員氏名）を school_admin 降格 context で読む（自校のみ、RLS が越境拒否、
      // #417 / ルール4）。生徒・保護者は匿名設計で roster を持たない（#289）。確定マスクに渡し、
      // 残存 PII は embedPendingContent の findUnmaskedPii ゲートが fail-closed で捕捉する。
      maskEntriesFor: async (schoolId) => {
        const names = await withTenantContext(
          db,
          { schoolId, role: "school_admin" },
          (tx) => listStaffDisplayNames(tx),
          appRoleOptions,
        );
        return names.map((value) => ({ value, category: "STAFF" }));
      },
      client,
      batchSize: config.batchSize,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
