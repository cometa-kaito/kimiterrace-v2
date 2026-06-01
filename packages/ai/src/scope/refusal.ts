import type { ScopeClassification } from "./classify.js";

/**
 * F06 out_of_scope（掲示物の話題から外れる質問）への決定論的・多言語の拒否メッセージビルダー
 * （ADR-028 §2 / §4 / §5）。
 *
 * 役割: `classifyScope` が `out_of_scope`（学習 / 進路）と判定したとき、route は **Gemini を呼ばずに**
 * この文言を返す。LLM 生成に頼らないことで:
 * - コスト 0 / レイテンシ 0（拒否で課金しない、ADR-028 §2 の「Gemini 呼出前に分類」目的）。
 * - プロンプトインジェクション耐性（拒否経路に攻撃文が一切 LLM へ渡らない）。
 * - 文言を監査・E2E で固定できる（応答パーサ / 検証③が文言を pin できる）。
 *
 * 設計上の規律:
 * - **誘導なし拒否（ADR-028 §2）**: 学習・進路の話題に対して「答え方のヒント」「やり方の示唆」を
 *   一切含めない。掲示物への質問に戻るよう中立に促すだけにとどめる。
 * - **トーン（ADR-028 §4）**: 中立・丁寧（敬語ベース、キャラ付けなし）。
 * - **多言語（ADR-028 §5）**: 分類器（classify.ts）が扱う言語に対応する拒否文言を持つ。
 *   ロケール判定は route の責務（magic link のクラス設定 / Accept-Language 等）で、本ビルダーは
 *   解決済みロケールを受け取る。未対応ロケールは `ja` にフォールバックする。
 * - 拒否理由（study / career）で文言は変えない（ADR-028 §2 は単一の拒否文言）。`reason` は監査用。
 *
 * 補足: 「掲示の話題だが根拠が無い」場合の **ラベル付き一般補足**（ADR-028 §3）は別経路で、
 * これは Gemini の system プロンプト（prompt/chat.ts の補足ガードレール）が担う。本ビルダーは
 * §2 の「掲示物と無関係な話題の拒否」専用。
 */

/** 拒否文言が対応するロケール。classify.ts の対応言語（日本語 / やさしい日本語 / 英語 / ポルトガル語）に対応。 */
export type SupportedLocale = "ja" | "ja-easy" | "en" | "pt";

/** 既定ロケール（クラス設定が無い場合）。 */
const DEFAULT_LOCALE: SupportedLocale = "ja";

/**
 * out_of_scope の拒否文言（ロケール別）。
 *
 * 日本語は ADR-028 §2 の確定文「それは掲示物の話題から外れます」を含める（応答パーサ / E2E が
 * この句で拒否を識別するため、表現を変えるときは検証側と同時に更新する）。各文言は学習 / 進路の
 * 内容に踏み込まず、掲示物への質問に戻すよう促すだけにとどめる（誘導なし拒否）。
 */
const SCOPE_REFUSALS: Record<SupportedLocale, string> = {
  ja: "ごめんなさい、それは掲示物の話題から外れます。掲示物について質問してください。",
  "ja-easy":
    "ごめんなさい。それは おしらせ の はなし では ありません。おしらせ について きいてください。",
  en: "Sorry, that's outside the topics covered by the school notices. Please ask about the notices.",
  pt: "Desculpe, isso está fora dos tópicos dos comunicados da escola. Por favor, pergunte sobre os comunicados.",
};

/**
 * 任意の言語タグ（`en-US` / `pt-BR` / `ja-JP` 等）を対応ロケールに正規化する。
 * route が受け取る raw な Accept-Language / 設定値をそのまま渡せるようにするヘルパー。
 * 未対応の言語は `ja` にフォールバックする（既定言語）。
 */
export function normalizeLocale(tag: string | null | undefined): SupportedLocale {
  if (!tag) {
    return DEFAULT_LOCALE;
  }
  const lower = tag.toLowerCase();
  // やさしい日本語は明示タグ（`ja-easy` / `ja-hira`）でのみ選択。素の `ja` は通常日本語。
  if (lower === "ja-easy" || lower === "ja-hira" || lower.startsWith("ja-easy")) {
    return "ja-easy";
  }
  const primary = lower.split("-")[0];
  if (primary === "ja") return "ja";
  if (primary === "en") return "en";
  if (primary === "pt") return "pt";
  return DEFAULT_LOCALE;
}

/**
 * out_of_scope 判定に対する拒否メッセージを返す。
 *
 * @param classification `classifyScope` の結果。`verdict` は `out_of_scope` でなければならない
 *   （in_scope に対して拒否文を作るのは呼び出し側のバグなので throw する）。
 * @param locale 解決済みロケール（既定 `ja`）。未対応値は `ja` にフォールバック。
 * @returns 中立・丁寧・誘導なしの拒否文言。
 */
export function buildScopeRefusal(
  classification: ScopeClassification,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  if (classification.verdict !== "out_of_scope") {
    throw new Error(
      "buildScopeRefusal: in_scope の分類に拒否文を生成しようとしました（呼び出し側は out_of_scope のときのみ呼ぶこと）",
    );
  }
  return SCOPE_REFUSALS[locale] ?? SCOPE_REFUSALS[DEFAULT_LOCALE];
}
