import {
  type EffectCommentStats,
  type ModelClient,
  findUnmaskedPii,
  maskPII,
} from "@kimiterrace/ai";
import type { TenantTx } from "@kimiterrace/db";
import { getEffectCommentStats } from "./effect-comment-stats";

/**
 * F08 (#44, slice 2): AI 効果コメント action の **純粋ヘルパ + 依存定義**。
 *
 * `effect-comment-action.ts` は `"use server"` で **async export しか持てない**ため、PII マスク集約
 * (`maskStats`) と依存組み立て (`defaultDeps`) などの同期ヘルパ・型はこのサイドカーに分離する。
 * (`run-extraction` / `extract-teacher-input` の seam 分離と同方針。)
 */

/** action が必要とする tx 能力 (select + audit_log への insert)。`@kimiterrace/db` の `TenantTx` を充足。 */
type ActionTx = Pick<TenantTx, "select" | "insert">;

/** `generateEffectComment` の注入点 (テストで Vertex / 集計を差し替える)。 */
export interface GenerateEffectCommentDeps {
  /** 当月 vs 前月の集計を RLS context tx で読む (既定は `getEffectCommentStats`)。 */
  loadStats: (tx: ActionTx, opts: { year: number; month: number }) => Promise<EffectCommentStats>;
  /** Gemini 応答を返す model (既定は実 Vertex、テストでは fake)。 */
  model: ModelClient;
}

/** マスク結果: builder へ渡すマスク済み stats + 逆変換辞書 + fail-closed 検出された残存 PII。 */
export interface MaskStatsResult {
  maskedStats: EffectCommentStats;
  dictionary: Record<string, string>;
  leaks: string[];
}

/**
 * topContent の各タイトルを `maskPII` で書式 PII (電話/メール) トークン化し、辞書を 1 つに集約する。
 *
 * - 名簿 (roster) は渡さない (生徒/保護者は匿名設計、職員名簿は掲示タイトルに通常出ない)。書式 PII の
 *   常時検出のみ効かせる。万一タイトルに電話/メールが混ざってもトークン化され Vertex へ素通りしない。
 * - 辞書のトークンは `maskPII` が呼び出しごとに連番採番するため、複数タイトル間で衝突しうる
 *   ({{PHONE_001}} が別タイトルで再採番)。タイトルごとに**ユニーク接頭辞**を辞書キーへ付け替えて
 *   衝突を避け、置換は元トークンを接頭辞付きへ差し替えてから集約する。
 * - `findUnmaskedPii` をマスク後タイトルに適用し、残存 (= マスク漏れ) を `leaks` に集約する
 *   (fail-closed。呼び出し側が非空なら送信中止)。月ラベル・件数は PII を含まないため対象外。
 */
export function maskStats(stats: EffectCommentStats): MaskStatsResult {
  const dictionary: Record<string, string> = {};
  const leaks: string[] = [];
  const maskedTop = stats.topContent.map((c, idx) => {
    const { masked, dictionary: localDict } = maskPII(c.title, []);
    // タイトル間でトークン番号が衝突しないよう、辞書キーへタイトル index 接頭辞を付ける。
    const prefix = `t${idx}_`;
    let prefixed = masked;
    for (const [token, value] of Object.entries(localDict)) {
      // token = "{{PHONE_001}}" → "{{t0_PHONE_001}}"。マスク後文字列内の出現も同様に差し替える。
      const newToken = token.replace(/^\{\{/, `{{${prefix}`);
      prefixed = prefixed.split(token).join(newToken);
      dictionary[newToken] = value;
    }
    // fail-closed: マスク後タイトルに書式 PII が残っていないか検査 (roster 無しなので電話/メールのみ)。
    for (const leak of findUnmaskedPii(prefixed, [])) leaks.push(leak);
    return { title: prefixed, reactions: c.reactions };
  });
  return {
    maskedStats: { month: stats.month, metrics: stats.metrics, topContent: maskedTop },
    dictionary,
    leaks,
  };
}

/** 既定 deps: 実集計 + 渡された (実 Vertex) model。 */
export function defaultDeps(model: ModelClient): GenerateEffectCommentDeps {
  return { loadStats: (tx, opts) => getEffectCommentStats(tx, opts), model };
}
