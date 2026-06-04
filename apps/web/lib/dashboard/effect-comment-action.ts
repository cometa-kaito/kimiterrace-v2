"use server";

import {
  type EffectCommentStats,
  type ModelClient,
  buildEffectCommentPrompt,
  createVertexModelClient,
  unmaskPII,
} from "@kimiterrace/ai";
import { auditLog } from "@kimiterrace/db";
import { createLogger } from "@kimiterrace/observability";
import { isAiEnabled } from "../ai/ai-enabled";
import { PUBLISHER_ROLES } from "../contents/publish-core";
import { withSession } from "../db";
import { currentJstYearMonth } from "../reports/month";
import { type GenerateEffectCommentDeps, defaultDeps, maskStats } from "./effect-comment-core";

/**
 * F08 (#44, slice 2): **AI 効果コメント生成** Server Action（ダッシュボードの後続スライス）。
 *
 * 効果ダッシュボード (`/admin/dashboard`、school_admin / teacher) の「今月の反応」を、当月 vs 前月の
 * 集計から Gemini に 2〜3 文で要約させる。フロー:
 *
 *   requireRole(PUBLISHER_ROLES) → withSession (RLS context tx)
 *     → getEffectCommentStats (当月 vs 前月集計, 生タイトル)
 *     → maskPII で topContent タイトルをマスク (★ Vertex 送信前, ルール4) + 辞書を保持
 *     → findUnmaskedPii fail-closed (マスク漏れなら中止)
 *     → buildEffectCommentPrompt (決定論的 builder, slice 1)
 *     → Vertex Gemini generate (asia-northeast1, ADR-005)
 *     → unmaskPII で応答を復元 (応答はマスク済みデータ由来で通常 PII を含まないが防御的に)
 *     → audit_log に LLM 呼び出しを記録 (ルール4/1: who/when/table/operation, **生 PII / 生プロンプトは残さない**)
 *     → コメント文字列を返す (typed success/error result)
 *
 * ## PII マスキング (CLAUDE.md ルール4)
 * topContent のタイトルは校務側の自由入力で、稀に電話・メールが混ざりうる (生徒/保護者氏名は本システム
 * 匿名設計で roster 不在)。送信前に各タイトルを `maskPII` で書式 PII トークン化し、`findUnmaskedPii` の
 * fail-closed ガードで残存検出時は中止する (`extract-teacher-input` と同方針)。マスクは **action 層が
 * 辞書を所有して**行い、集計層 (`getEffectCommentStats`) は生タイトルのみを返す (マスク責務を Vertex 呼び
 * 出し境界に集約)。月ラベル・件数・前月比は PII を含まないため neutralize のみ (builder が担保)。
 *
 * ## 監査 (ルール4/1)
 * 生成 1 回ごとに `audit_log` へ 1 行 INSERT する (LLM 呼び出しの記録)。`diff` には**マスク後の**月・
 * モデルバージョン・token 使用量・指標件数のみを残し、**生プロンプト / 生タイトル / 生 PII / 応答本文は
 * 記録しない** (ai_extractions が raw を SHA-256 ハッシュのみ保存するのと同じ思想)。`prev_hash` /
 * `row_hash` は audit_log の BEFORE INSERT トリガが hash chain を計算する (`rowHash: ""` を渡す)。
 *
 * ## エラー処理
 * Vertex / DB 障害は typed error result (`ok:false`) に畳んで 500 leak を避ける。PII マスク漏れは
 * `pii_leak`、未認証/権限不足は `withSession` が throw する (Server Action 呼び出し側が UX に写像)。
 * 生プロンプト・応答本文・タイトルはログに出さない (ルール4)。
 */

/** action の判別共用体の結果 (呼び出し側 UI が表示に写像)。 */
export type GenerateEffectCommentResult =
  | { ok: true; month: string; comment: string }
  | { ok: false; reason: "pii_leak" | "error" | "ai_disabled" };

const effectCommentLogger = createLogger("effect-comment");

let memoModel: ModelClient | null = null;
/** 実 Vertex model を env から遅延生成 (construct は lazy、generate 時のみ ADC、`extract-teacher-input` と同方針)。 */
function getEffectCommentModel(): ModelClient {
  if (memoModel) return memoModel;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoModel = createVertexModelClient({ project, location });
  return memoModel;
}

/**
 * 当月の AI 効果コメントを生成する (school_admin / teacher、自校スコープ)。
 *
 * `deps` はテストで Vertex / 集計を差し替えるための注入点 (既定は実 Vertex + 実集計)。本関数は throw せず
 * (認証/権限を除く)、結果を {@link GenerateEffectCommentResult} に畳む。
 *
 * @throws {UnauthenticatedError} 未認証 (`withSession` 由来)
 * @throws {ForbiddenError} role が PUBLISHER_ROLES でない (`withSession({allowedRoles})` 由来)
 */
export async function generateEffectComment(
  deps: GenerateEffectCommentDeps = defaultDeps(getEffectCommentModel()),
): Promise<GenerateEffectCommentResult> {
  // #289 kill-switch: AI 無効時は実 Vertex を呼ぶ前に disabled 結果を返す (既定 OFF, ルール4 / ADR-030)。
  // gate は body 冒頭に置く: model getter 側に置くと default-param 評価 (deps の既定値) で try 外 throw に
  // なり 500 化 + 既存テスト破壊のため。既定引数の getEffectCommentModel() は lazy construct (Vertex 未呼出)
  // ゆえ評価されても無害で、本 return が deps.model.generate より前に短絡する。
  if (!isAiEnabled()) {
    return { ok: false, reason: "ai_disabled" };
  }

  const { year, month } = currentJstYearMonth();
  try {
    // RLS context tx + role 第一層ガード (PUBLISHER_ROLES)。tx 内で集計 → マスク → 監査を束ねる。
    return await withSession(
      async (tx, user) => {
        const stats: EffectCommentStats = await deps.loadStats(tx, { year, month });

        // ★ Vertex 送信前マスク (ルール4)。タイトルをマスクし辞書を集約、fail-closed で残存検出。
        const { maskedStats, dictionary, leaks } = maskStats(stats);
        if (leaks.length > 0) {
          // fail-closed 作動 = セキュリティ事象。タイトル/PII は出さず件数のみ記録 (ルール4)。
          effectCommentLogger.error(
            { month: stats.month, leakCount: leaks.length },
            "AI 効果コメント生成を中止: PII マスク漏れガードが作動",
          );
          return { ok: false, reason: "pii_leak" as const };
        }

        const prompt = buildEffectCommentPrompt(maskedStats);
        const response = await deps.model.generate({ system: prompt.system, user: prompt.user });
        // 応答はマスク後データ由来で通常 PII を含まないが、防御的に逆変換する (chat と挙動一致)。
        const comment = unmaskPII(response.text, dictionary).trim();

        // 監査: LLM 呼び出しを 1 行記録 (ルール4/1)。生プロンプト/応答/生タイトルは残さない。
        await tx.insert(auditLog).values({
          actorUserId: user.uid,
          schoolId: user.schoolId,
          // LLM 呼び出しの記録であり対応行は無い (recordId: null)。chat message と混同しないよう
          // 専用ラベルにする (監査クエリの table_name バケットを正す, Reviewer Low / ルール1)。
          tableName: "effect_comment",
          recordId: null,
          operation: "insert",
          diff: {
            action: "generate_effect_comment",
            month: maskedStats.month,
            modelVersion: response.modelVersion,
            usage: response.usage,
            metricCount: maskedStats.metrics.length,
            topContentCount: maskedStats.topContent.length,
          },
          rowHash: "",
          createdBy: user.uid,
          updatedBy: user.uid,
        });

        return { ok: true as const, month: stats.month, comment };
      },
      { allowedRoles: PUBLISHER_ROLES },
    );
  } catch (err) {
    // 認証/権限エラーは呼び出し側へ伝播 (UnauthenticatedError / ForbiddenError)。それ以外 (Vertex/DB 障害)
    // は typed error に畳んで 500 leak を避ける。生プロンプト・応答・タイトルはログに出さない (ルール4)。
    if (isAuthError(err)) throw err;
    effectCommentLogger.error({ year, month }, "AI 効果コメント生成に失敗");
    return { ok: false, reason: "error" };
  }
}

/** `withSession` が投げる認証/権限エラーか (名前で判定し、UX 層へそのまま伝播させる)。 */
function isAuthError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === "UnauthenticatedError" || err.name === "ForbiddenError")
  );
}

// 型の再エクスポート (呼び出し側が deps を組み立てやすいように)。
export type { GenerateEffectCommentDeps };
