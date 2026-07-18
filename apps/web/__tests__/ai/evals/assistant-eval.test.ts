import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEditorModelConfig } from "@/lib/ai/editor-model-config";
import { DRAFT_SECTION_KINDS, EMPTY_DRAFT, sanitizeDraft } from "@/lib/editor/assistant-chat-core";
import {
  buildAssistantChatSystem,
  buildAssistantChatUser,
} from "@/lib/editor/assistant-chat-prompt";
import { jstDateLabel, jstUpcomingDateTable } from "@/lib/editor/assistant-core";
import { buildPhotoImportChatMessage } from "@/lib/editor/photo-import-core";
import {
  createGeminiOcrClient,
  createVertexAssistantChatClient,
  createVertexModelClient,
  structureContent,
} from "@kimiterrace/ai";
import { describe, expect, it } from "vitest";
import { ASSISTANT_EVAL_CASES, type AssistantEvalCase, FIXED_NOW_MS } from "./cases-assistant";
import { EXTRACTION_EVAL_CASES } from "./cases-extraction";
import { PHOTO_EVAL_CASES, type PhotoEvalCase } from "./cases-photo-extraction";
import { type PhotoFixtureRenderer, createPhotoFixtureRenderer } from "./photo-fixtures";
import { type Check, caseScore, scoreAssistantTurn, scoreExtraction } from "./score";

/**
 * AI 精度評価ランナー（**実 Vertex 呼び出し**・skip-gated）。vertex-live.test.ts と同じ二重ゲート:
 * project env（GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT）+ `RUN_AI_EVAL=1` 明示時のみ実行し、
 * 通常の `pnpm test` / CI では 0 件 skip で何も叩かない（課金・quota 保護）。
 *
 * ## 何を測るか
 * - 会話型アシスタント: 本番 SSE ハンドラ（assistant-chat-sse）と**同一のプロンプト構築 +
 *   sanitizeDraft** を通し、最終 partial を採点する。`filterDraftToSections` は意図的に**かけない**
 *   （防御フィルタで空になる分も「モデルが許可外を作った」として観測する。本番の安全性は
 *   フィルタが別途担保）。基準日は cases-assistant の FIXED_NOW_MS に固定（相対日付を決定的に採点）。
 * - F03 抽出: structureContent の end-to-end（マスキング・リトライ込み）。
 *
 * ## 使い方（A/B 測定）
 * ```
 * RUN_AI_EVAL=1 GCP_PROJECT_ID=<project> pnpm --filter @kimiterrace/web test __tests__/ai/evals
 * # knob は本番と同じ env で切替（editor-model-config 経由 = 本番配線と同一解釈）:
 * #   GEMINI_MODEL=gemini-2.5-pro / GEMINI_THINKING_BUDGET=0|1024|...
 * ```
 * 結果は reports/ に JSON で残る（gitignore・実行ごとに 1 ファイル）。スコアは回帰ゲートに
 * しない（確率的なため）。改善判断は複数実行の平均で行う。
 *
 * ルール4: 評価ケースは PII を含まない（cases-* の規律）。マスク経路は F03 側で実行される。
 */

const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
const enabled = project.length > 0 && process.env.RUN_AI_EVAL === "1";
const describeOrSkip = enabled ? describe : describe.skip;

/** 1 ケースのモデル応答待ち上限。 */
const CASE_TIMEOUT_MS = 90_000;
/** 同時実行数（Vertex quota / rate 保護）。 */
const CONCURRENCY = 3;
/** スイート全体のタイムアウト。 */
const SUITE_TIMEOUT_MS = 15 * 60_000;

type CaseResult = {
  id: string;
  category: string;
  score: number;
  ms: number;
  outputTokens: number;
  error?: string;
  checks: Check[];
  reply?: string;
  draft?: unknown;
  /** sanitize 前の最終 partial（days の日付形式不正等、正規化で落ちた原因の追跡用）。 */
  raw?: unknown;
  /** 実際に送った system/user の SHA-256 先頭 12 桁（プロンプト差分の突き合わせ用・本文は残さない）。 */
  promptHash?: string;
  /** 写真ケースのみ: OCR 書き起こし（フィクスチャは合成・PII ゼロゆえレポートに残してよい。原因追跡用）。 */
  ocrText?: string;
};

function promptHash(system: string, user: string): string {
  return createHash("sha256").update(`${system}\n---\n${user}`, "utf8").digest("hex").slice(0, 12);
}

/** 直列バッチで items を CONCURRENCY 並列処理する（順序保存）。 */
async function mapBatched<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

function aggregate(results: readonly CaseResult[]): {
  overall: number;
  byCategory: Record<string, { score: number; cases: number }>;
} {
  const byCategory: Record<string, { score: number; cases: number }> = {};
  for (const r of results) {
    const agg = byCategory[r.category] ?? { score: 0, cases: 0 };
    agg.score += r.score;
    agg.cases += 1;
    byCategory[r.category] = agg;
  }
  for (const key of Object.keys(byCategory)) {
    const agg = byCategory[key];
    if (agg) {
      agg.score = agg.score / agg.cases;
    }
  }
  const overall = results.reduce((sum, r) => sum + r.score, 0) / Math.max(results.length, 1);
  return { overall, byCategory };
}

function summarize(title: string, results: readonly CaseResult[]): string {
  const { overall, byCategory } = aggregate(results);
  const lines = [`## ${title}: overall ${(overall * 100).toFixed(1)}%`];
  for (const [category, agg] of Object.entries(byCategory).sort()) {
    lines.push(`- ${category}: ${(agg.score * 100).toFixed(1)}% (${agg.cases} cases)`);
  }
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.pass);
    if (r.error || failed.length > 0) {
      lines.push(
        `  ✗ ${r.id} (${(r.score * 100).toFixed(0)}%)${r.error ? ` ERROR: ${r.error}` : ""}`,
      );
      for (const c of failed.slice(0, 6)) {
        lines.push(`      - ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

/** report を JSON で保存し、パスを返す（reports/ は gitignore）。 */
function writeReport(payload: unknown, prefix = "eval"): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${prefix}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
  return file;
}

async function runAssistantCase(evalCase: AssistantEvalCase): Promise<CaseResult> {
  const { modelId, tuning } = resolveEditorModelConfig();
  const client = createVertexAssistantChatClient({ project, location, modelId, tuning });
  const allowed = evalCase.allowed ?? DRAFT_SECTION_KINDS;
  const system = buildAssistantChatSystem(
    allowed,
    jstDateLabel(FIXED_NOW_MS),
    evalCase.manualSectionLabels ?? [],
    // 本番（assistant-chat-sse）と同じ日付対応表を注入する（評価は本番プロンプトと同一サーフェス）。
    jstUpcomingDateTable(FIXED_NOW_MS),
  );
  const user = buildAssistantChatUser(
    [...evalCase.messages],
    evalCase.draft ?? { ...EMPTY_DRAFT },
    allowed,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CASE_TIMEOUT_MS);
  const startedAt = performance.now();
  try {
    const result = client.stream({ system, user, signal: controller.signal });
    let last: unknown = {};
    for await (const partial of result.partialStream) {
      last = partial;
    }
    const { tokenCount } = await result.done;
    const partial = last as { reply?: unknown };
    const reply = typeof partial.reply === "string" ? partial.reply : "";
    // 本番同様 sanitizeDraft で正規化する（filterDraftToSections は意図的にかけない・上部 doc）。
    const draft = sanitizeDraft(last);
    const checks = scoreAssistantTurn(evalCase.expected, { reply, draft });
    return {
      id: evalCase.id,
      category: evalCase.category,
      score: caseScore(checks),
      ms: Math.round(performance.now() - startedAt),
      outputTokens: tokenCount,
      checks,
      reply,
      draft,
      raw: last,
      promptHash: promptHash(system, user),
    };
  } catch (err) {
    // 失敗ケースは期待チェック全滅として 0 点（測定は続行・throw しない）。
    const checks = scoreAssistantTurn(evalCase.expected, { reply: "", draft: { ...EMPTY_DRAFT } });
    return {
      id: evalCase.id,
      category: evalCase.category,
      score: 0,
      ms: Math.round(performance.now() - startedAt),
      outputTokens: 0,
      error: err instanceof Error ? err.message : String(err),
      checks: checks.map((c) => ({ ...c, pass: false })),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * P1 写真取込の 1 ケース実行（設計 D5/D8）: 合成画像レンダリング → 実 Gemini OCR（本番と同一
 * クライアント）→ buildPhotoImportChatMessage（本番と同一の注入形式・単一ソース）→ 会話型
 * アシスタント → sanitizeDraft → 採点。会話部分は {@link runAssistantCase} と同一サーフェス。
 */
async function runPhotoCase(
  renderer: PhotoFixtureRenderer,
  evalCase: PhotoEvalCase,
): Promise<CaseResult> {
  const { modelId, tuning } = resolveEditorModelConfig();
  const client = createVertexAssistantChatClient({ project, location, modelId, tuning });
  const ocr = createGeminiOcrClient({ project, location });
  const startedAt = performance.now();
  let ocrText = "";
  try {
    const png = await renderer.render(evalCase.fixtureId);
    ocrText = (await ocr.recognize(png, "image/png")).text.trim();
    const system = buildAssistantChatSystem(
      DRAFT_SECTION_KINDS,
      jstDateLabel(FIXED_NOW_MS),
      [],
      jstUpcomingDateTable(FIXED_NOW_MS),
    );
    const user = buildAssistantChatUser(
      [{ role: "user", content: buildPhotoImportChatMessage(ocrText) }],
      { ...EMPTY_DRAFT },
      DRAFT_SECTION_KINDS,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CASE_TIMEOUT_MS);
    try {
      const result = client.stream({ system, user, signal: controller.signal });
      let last: unknown = {};
      for await (const partial of result.partialStream) {
        last = partial;
      }
      const { tokenCount } = await result.done;
      const partial = last as { reply?: unknown };
      const reply = typeof partial.reply === "string" ? partial.reply : "";
      const draft = sanitizeDraft(last);
      const checks = scoreAssistantTurn(evalCase.expected, { reply, draft });
      return {
        id: evalCase.id,
        category: evalCase.category,
        score: caseScore(checks),
        ms: Math.round(performance.now() - startedAt),
        outputTokens: tokenCount,
        checks,
        reply,
        draft,
        raw: last,
        promptHash: promptHash(system, user),
        ocrText,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // レンダリング/OCR/生成いずれの失敗も期待チェック全滅の 0 点（測定は続行・throw しない）。
    const checks = scoreAssistantTurn(evalCase.expected, { reply: "", draft: { ...EMPTY_DRAFT } });
    return {
      id: evalCase.id,
      category: evalCase.category,
      score: 0,
      ms: Math.round(performance.now() - startedAt),
      outputTokens: 0,
      error: err instanceof Error ? err.message : String(err),
      checks: checks.map((c) => ({ ...c, pass: false })),
      ocrText,
    };
  }
}

describeOrSkip("AI eval (RUN_AI_EVAL=1)", () => {
  it(
    "会話型アシスタント + F03 抽出のゴールデンセットを実 Vertex で測定しレポートを出す",
    async () => {
      const { modelId, tuning } = resolveEditorModelConfig();
      const assistant = await mapBatched(ASSISTANT_EVAL_CASES, runAssistantCase);

      const model = createVertexModelClient({ project, location, ...(modelId ? { modelId } : {}) });
      const extraction = await mapBatched(EXTRACTION_EVAL_CASES, async (evalCase) => {
        const startedAt = performance.now();
        try {
          const result = await structureContent({
            kind: evalCase.kind,
            input: evalCase.input,
            model,
          });
          const checks = scoreExtraction(evalCase.expected, result);
          return {
            id: evalCase.id,
            category: `f03-${evalCase.kind}`,
            score: caseScore(checks),
            ms: Math.round(performance.now() - startedAt),
            outputTokens: result.usage.completionTokens,
            // failed 時の errorMessage（Zod 不一致理由等）をレポートに残す（原因追跡）。
            ...(result.errorMessage ? { error: result.errorMessage } : {}),
            checks,
            draft: result.extraction,
          } satisfies CaseResult;
        } catch (err) {
          const checks = scoreExtraction(evalCase.expected, {
            status: "failed",
            extraction: null,
            confidenceScore: null,
          });
          return {
            id: evalCase.id,
            category: `f03-${evalCase.kind}`,
            score: 0,
            ms: Math.round(performance.now() - startedAt),
            outputTokens: 0,
            error: err instanceof Error ? err.message : String(err),
            checks,
          } satisfies CaseResult;
        }
      });

      const payload = {
        ranAt: new Date().toISOString(),
        config: {
          project,
          location,
          modelId: modelId ?? "gemini-2.5-flash (client default)",
          thinkingBudget: tuning?.thinkingBudget ?? "SDK default (dynamic)",
          temperature: "client default (DRAFT_TEMPERATURE=0.3)",
        },
        assistant: { ...aggregate(assistant), cases: assistant },
        extraction: { ...aggregate(extraction), cases: extraction },
      };
      const file = writeReport(payload);

      console.log(
        [
          "",
          `# AI eval report → ${file}`,
          `model=${payload.config.modelId} thinkingBudget=${payload.config.thinkingBudget}`,
          summarize("会話型アシスタント", assistant),
          summarize("F03 抽出", extraction),
          "",
        ].join("\n"),
      );

      // 測定が目的（確率的な出力に固定閾値を課さない）。全ケースが実行されたことのみ契約とする。
      expect(assistant).toHaveLength(ASSISTANT_EVAL_CASES.length);
      expect(extraction).toHaveLength(EXTRACTION_EVAL_CASES.length);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "P1 写真取込（合成画像 → OCR → チャット合流）のゴールデンセットを実 Vertex で測定しレポートを出す",
    async () => {
      const { modelId, tuning } = resolveEditorModelConfig();
      // 1 ケース = ブラウザレンダリング + OCR + 会話生成の 3 段。ブラウザは 1 つを使い回し、
      // Vertex 呼び出しが直列 2 回/ケースと重いので直列実行する（quota/flake 保護・3 ケースのみ）。
      const renderer = await createPhotoFixtureRenderer();
      const photo: CaseResult[] = [];
      try {
        for (const evalCase of PHOTO_EVAL_CASES) {
          photo.push(await runPhotoCase(renderer, evalCase));
        }
      } finally {
        await renderer.close();
      }

      const payload = {
        ranAt: new Date().toISOString(),
        config: {
          project,
          location,
          modelId: modelId ?? "gemini-2.5-flash (client default)",
          thinkingBudget: tuning?.thinkingBudget ?? "SDK default (dynamic)",
          ocrModelId: "gemini-2.5-flash (OCR client default)",
        },
        photo: { ...aggregate(photo), cases: photo },
      };
      const file = writeReport(payload, "eval-photo");

      console.log(
        [
          "",
          `# P1 写真取込 eval report → ${file}`,
          `model=${payload.config.modelId} thinkingBudget=${payload.config.thinkingBudget}`,
          summarize("写真取込", photo),
          "",
        ].join("\n"),
      );

      expect(photo).toHaveLength(PHOTO_EVAL_CASES.length);
    },
    SUITE_TIMEOUT_MS,
  );
});
