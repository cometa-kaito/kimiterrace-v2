import type { InferInsertModel } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { aiExtractions } from "../schema/ai-extractions.js";

/**
 * F03 (#154 item 1): AI 構造化抽出結果の **ai_extractions への永続化層**。
 *
 * `@kimiterrace/ai` の `toAiExtractionInsert` が返す素のオブジェクト (confidence / model_version /
 * raw_input_hash / status / evidence など) を、呼び出し側 (apps/web の Server Action / Cloud Run Job)
 * が **`withTenantContext` 内で**本関数に渡して INSERT する。RLS コンテキスト下で書くことで school 越境を
 * 構造排除する (CLAUDE.md ルール2、ADR-019)。
 *
 * ## 監査について
 * ai_extractions は **AI 活動そのものの台帳** (どの抽出をどの確信度・モデル・入力ハッシュで行ったか)。
 * events と同じく「行自体が監査記録」なので、別途 audit_log への二重記録は行わない (生プロンプト/応答は
 * 保存せず、マスク後入力の SHA-256 と確信度・モデル・トークン相当のみ、ルール4)。created_by / updated_by は
 * auditColumns で実行者を保持する (システム実行は null 可)。
 *
 * 呼び出し配線 (F01/F02 入力 → structureContent → 本 INSERT) とエラー UX (429 / PII leak)、
 * Vertex 実呼び出し結合テストは #154 の後続スライス。
 */

/**
 * ai_extractions INSERT 用の値。型は Drizzle スキーマを単一ソースとする (ルール3)。
 * `id` / `created_at` / `updated_at` は DB 既定 (gen_random_uuid / now) のため省略可。
 */
export type NewAiExtraction = InferInsertModel<typeof aiExtractions>;

/**
 * F03: AI 構造化の抽出結果 1 件を ai_extractions に追記する (#154 item 1)。
 *
 * **必ず RLS コンテキスト (`withTenantContext`) 内で呼ぶこと。** `school_id` は接続コンテキストの
 * `app.current_school_id` と一致する必要があり、`tenant_isolation` policy (FOR ALL の WITH CHECK、
 * migration 0002) が越境 INSERT を DB レベルで弾く。本関数は `WHERE school_id` を手書きしない。
 *
 * @returns 追記行の id
 */
export async function insertAiExtraction(
  tx: TenantTx,
  values: NewAiExtraction,
): Promise<{ id: string }> {
  const [row] = await tx.insert(aiExtractions).values(values).returning({ id: aiExtractions.id });
  if (!row) {
    throw new Error("ai_extractions の追記に失敗しました (returning が空)");
  }
  return row;
}
