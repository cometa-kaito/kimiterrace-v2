import { describe, expect, it } from "vitest";
import { createVertexModelClient } from "../../model/vertex.js";
import { structureContent } from "../../structure.js";

/**
 * F03 (#154 item 3): Vertex AI Gemini **実呼び出し** 結合テスト (skip-gated)。
 *
 * 既存の {@link ../model/__tests__/vertex.test.ts} は `@ai-sdk/google-vertex` を vi.mock で
 * 差し替えて adapter のローカル契約 (JSON モード注入 / usage 写像) を固定する。本テストは
 * 逆方向: **provider を mock しない** で ADC / Workload Identity 経由で実 Gemini を叩き、
 * adapter の生 SDK ↔ ModelClient 境界 + structureContent オーケストレータの end-to-end が
 * 実 model 応答に対しても成立することを固定する。
 *
 * ## skip ゲート (二重)
 * 1. `GCP_PROJECT_ID` または `GOOGLE_CLOUD_PROJECT` が無ければ skip。Vertex 呼び出しは
 *    project 必須で、CI 通常実行・ローカル ADC 未設定環境では資格情報自体が無い (ルール5)。
 * 2. `RUN_VERTEX_LIVE=1` 明示が無ければ skip。project があってもデフォルトは課金 / API quota を
 *    避けるため off。資格情報のある CI ジョブ・開発者が手動検証する時のみ `RUN_VERTEX_LIVE=1`
 *    を立てて回す。
 *
 * → 通常の `pnpm test` (ローカル / 通常 CI) では 0 件 skip 表示で何も叩かない。
 *
 * ## 検証点
 * - direct: `createVertexModelClient` の `generate({system, user})` が非空 text + 正の総トークン数 +
 *   要求 modelId をそのまま `modelVersion` に返す。
 * - e2e: `structureContent({kind:"summary", input: <PII 無し短文>})` が status="success" or "failed"
 *   いずれかに着地し、success なら confidence ∈ [0,1] / extraction.kind が一致 / rawInputHash は
 *   SHA-256 hex (64 桁) / attempts ≥ 1。failed でも例外を投げず monitorable に落ちる。
 *
 * ## 非検証 (意図的)
 * - prompt 品質 / 抽出精度: モデルは確率的なので exact match はしない (status の二値で十分)。
 * - PII マスキング: structure.test.ts (mock 環境) で全分岐検証済。実呼び出しでマスク有無を
 *   再現すると leak リスクがあるため、ここでは PII 自体を含まない入力で叩く (ルール4 安全側)。
 * - rate limit: rate-limit.test.ts で完結。実 quota を消費する re-test は不要。
 *
 * ## 失敗時の解釈
 * - 401 / PERMISSION_DENIED → ADC 認証経路の不整合 (Workload Identity 設定 or `gcloud auth
 *   application-default login` 未実施)。test の問題ではなく実行環境の問題。
 * - 429 → Vertex quota 不足。CI 同時実行で発生したら `RUN_VERTEX_LIVE=1` を下げる。
 * - status="failed" 連続 → adapter の responseMimeType 注入が壊れて JSON 以外が返っている可能性。
 *   v5 移行回帰 (PR #153 系) の検知シグナル。
 */

const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
const enabled = project.length > 0 && process.env.RUN_VERTEX_LIVE === "1";
const describeOrSkip = enabled ? describe : describe.skip;

// 実 Vertex 呼び出しは数秒〜十数秒かかる。並列で複数回叩くテストでも余裕を持って 60s。
const LIVE_TIMEOUT_MS = 60_000;

describeOrSkip("Vertex AI Gemini live integration (#154 item 3)", () => {
  it(
    "ModelClient.generate が非空 text + 正の総トークン数 + modelVersion を返す",
    async () => {
      const client = createVertexModelClient({ project, location });

      const res = await client.generate({
        // JSON 強制 (adapter の forceJsonResponseMiddleware) なので JSON を返すよう誘導する。
        // PII は意図的に含めない (ルール4 安全側、上の docstring 参照)。
        system: 'You MUST respond with valid JSON only. No prose. Schema: {"ok": boolean}.',
        user: 'Return exactly: {"ok": true}',
      });

      expect(res.text.length).toBeGreaterThan(0);
      // adapter が SDK の inputTokens/outputTokens/totalTokens を正しく写像していれば
      // 実呼び出しでは合計トークン > 0 が必ず成立する (0 になるのは fake / 失敗時のみ)。
      expect(res.usage.totalTokens).toBeGreaterThan(0);
      expect(res.usage.promptTokens).toBeGreaterThan(0);
      expect(res.usage.completionTokens).toBeGreaterThan(0);
      // ADR-017 のピン (既定 modelId) がそのまま modelVersion として返ること。
      expect(res.modelVersion).toBe("gemini-2.5-flash");
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "structureContent (kind=summary) が success/failed のどちらかに着地し監査用フィールドが揃う",
    async () => {
      const model = createVertexModelClient({ project, location });

      const result = await structureContent({
        kind: "summary",
        // PII を含まない短い行事連絡文。実モデルが scheduleSchema/announcementSchema ではなく
        // summarySchema に従うことを誘導する程度の最小入力。
        input: "本日6限の体育祭練習は予定通り実施します。集合は8時に校庭です。",
        model,
      });

      // status は確率的だが両値とも仕様の有効な着地点 (failed は最大2回リトライ後の Zod 不一致)。
      // どちらでも throw しないことが contract。
      expect(["success", "failed"]).toContain(result.status);

      // 監査列に対応するメタは status を問わず常に埋まる (audit.ts toAiExtractionInsert が依存)。
      expect(result.kind).toBe("summary");
      // SHA-256 hex = 64 桁 lowercase。
      expect(result.rawInputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.modelVersion).toBe("gemini-2.5-flash");
      expect(result.attempts).toBeGreaterThanOrEqual(1);
      expect(result.usage.totalTokens).toBeGreaterThan(0);

      if (result.status === "success") {
        // confidenceScore は ADR-017 決定3 で必須。Zod が validate しているはずだが、live で
        // 実値が [0,1] 範囲に収まることを念のため固定 (モデルが範囲外を返したら failed に
        // 落ちているはずの不整合検知)。
        expect(result.confidenceScore).not.toBeNull();
        expect(result.confidenceScore as number).toBeGreaterThanOrEqual(0);
        expect(result.confidenceScore as number).toBeLessThanOrEqual(1);
        expect(result.extraction).not.toBeNull();
        expect(result.extraction?.kind).toBe("summary");
        expect(result.errorMessage).toBeNull();
      } else {
        // 失敗時は extraction/confidence が null になり errorMessage が埋まる契約。
        expect(result.extraction).toBeNull();
        expect(result.confidenceScore).toBeNull();
        expect(result.errorMessage).not.toBeNull();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
