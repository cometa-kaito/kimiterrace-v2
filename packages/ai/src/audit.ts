import type { EvidenceItem } from "./schema/extraction.js";
import type { StructureResult } from "./structure.js";

/**
 * F03 監査記録マッパー（受け入れ条件「プロンプト・応答・トークン数・確信度を ai_extractions に記録」）。
 *
 * `@kimiterrace/ai` は `@kimiterrace/db` へ依存しない（レイヤ分離）。本関数は `StructureResult` を
 * `ai_extractions` 列に対応する**素のオブジェクト**へ変換するだけで、実際の INSERT は呼び出し側
 * （apps/web の Server Action / Cloud Run Job）が `withTenantContext` 内で行う。RLS コンテキスト下で
 * 書くことで school 越境を構造的に防ぐ（CLAUDE.md ルール2）。
 *
 * 注意: 生プロンプト・生応答は保存しない。再現性・漏洩追跡には**マスク後入力の SHA-256**
 * （`rawInputHash`）とトークン使用量・確信度・モデルバージョンで足り、PII 保存を避ける（ルール4）。
 */

export interface AiExtractionInsert {
  schoolId: string;
  contentId: string | null;
  extractionKind: StructureResult["kind"];
  confidenceScore: number;
  evidence: EvidenceItem[];
  rawInputHash: string;
  modelVersion: string;
  // status は抽出結果の値域 (success/failed) に絞る。これにより db の NewAiExtraction.status
  // (ai_extraction_status enum) へ追加キャスト無しで代入可能になる (#75 の enum 化と整合、#154 配線)。
  // ai は db に依存しない (レイヤ分離) ため、db の enum 型ではなく ai 自身の StructureResult["status"]
  // を単一ソースにする。retry は本マッパー経路では発生しない (リトライ追跡は別経路の責務)。
  status: StructureResult["status"];
  errorMessage: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface AuditMapParams {
  schoolId: string;
  /** 抽出元 content（事前バッチ等で未確定なら null）。 */
  contentId?: string | null;
  /** 実行者。システム実行は null（auditColumns の created_by は nullable）。 */
  actorUserId?: string | null;
  result: StructureResult;
}

export function toAiExtractionInsert(params: AuditMapParams): AiExtractionInsert {
  const { result } = params;
  const actor = params.actorUserId ?? null;
  return {
    schoolId: params.schoolId,
    contentId: params.contentId ?? null,
    extractionKind: result.kind,
    // confidence_score は NOT NULL。失敗時は自己評価が存在しないため 0.0 を記録（status=failed で識別）。
    confidenceScore: result.confidenceScore ?? 0,
    evidence: result.extraction?.evidence ?? [],
    rawInputHash: result.rawInputHash,
    modelVersion: result.modelVersion,
    status: result.status,
    errorMessage: result.errorMessage,
    createdBy: actor,
    updatedBy: actor,
  };
}
