"use client";

import {
  type GenerateEffectCommentResult,
  generateEffectComment,
} from "@/lib/dashboard/effect-comment-action";
import { useState, useTransition } from "react";

/**
 * F08 (#44, slice 3): **AI 効果コメント** のダッシュボード UI (`/app/dashboard`)。**Client Component**。
 *
 * 効果ダッシュボード上の「今月の AI 効果コメント」セクション。生成ボタン押下で
 * {@link generateEffectComment} Server Action (slice 2) を **引数なし** で呼ぶ。認可
 * (PUBLISHER_ROLES)・当月導出・集計・PII マスク (ルール4)・Vertex 呼び出し・監査 (ルール1/4) は
 * すべて action 側が担保するので、本コンポーネントは「ユーザー操作のトリガ」と「結果/エラーの表示」に
 * 徹する (Vertex を直接叩かず、必ず action 経由)。
 *
 * ## なぜ自動生成でなくボタン起動か
 * 生成 1 回ごとに **課金される Vertex 呼び出し** が走り、かつ **`audit_log` に 1 行記録** される
 * (ルール4)。ダッシュボードを開くたびに自動生成すると、コストが嵩みつつ監査ログがノイズで溢れる。
 * そのため明示的なユーザー操作 (ボタン押下) を生成トリガとする (意図的な設計)。
 *
 * ## アクセシビリティ (NFR05 / WCAG 2.2 AA)
 * - 結果・エラーは `aria-live="polite"` 領域に出し、生成完了/失敗をスクリーンリーダーに通知する。
 * - ボタンはテキストラベルでアクセシブル名を持ち、生成中は `aria-busy` + 文言で pending を通知する。
 * - 色のみに依存しない: エラーは文言で意味を伝える (`CommunicationCreateForm` の `<output>` と同方針)。
 */
export function EffectCommentPanel() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<GenerateEffectCommentResult | null>(null);

  function onGenerate() {
    setResult(null);
    startTransition(async () => {
      // action は引数なしで呼ぶ (当月は action が JST から導出、deps の既定は実 Vertex + 実集計)。
      const res = await generateEffectComment();
      setResult(res);
    });
  }

  return (
    <section style={panelStyle} aria-labelledby="effect-comment-heading">
      <h2 id="effect-comment-heading" style={sectionTitleStyle}>
        今月の AI 効果コメント
      </h2>
      <p style={leadStyle}>
        当月と前月の反応を AI が 2〜3
        文で要約します。生成のたびに記録されるため、必要なときにボタンで生成してください。
      </p>

      <div style={controlsStyle}>
        <button
          type="button"
          onClick={onGenerate}
          disabled={pending}
          aria-busy={pending}
          style={btnStyle}
        >
          {pending ? "生成中…" : "効果コメントを生成"}
        </button>
      </div>

      {/* 結果・エラーは aria-live 領域で通知する (生成は非同期、ボタンと別領域)。 */}
      <div aria-live="polite" style={liveRegionStyle}>
        {/* 横断統一: AI が働いている間は共通の「考え中…」明滅ラベル（globals.css .kt-thinking）。 */}
        {pending ? <p className="kt-thinking">● AI が考え中です…（少しお待ちください）</p> : null}
        {!pending && result ? <ResultView result={result} /> : null}
      </div>
    </section>
  );
}

/** action の判別共用体の結果を表示に写像する (ok=コメント / pii_leak・ai_disabled・error=安全な定型文)。 */
function ResultView({ result }: { result: GenerateEffectCommentResult }) {
  if (result.ok) {
    return (
      <figure style={commentFigureStyle}>
        <figcaption style={monthCaptionStyle}>{result.month} の効果コメント</figcaption>
        <blockquote style={commentStyle}>{result.comment}</blockquote>
      </figure>
    );
  }
  if (result.reason === "pii_leak") {
    return <p style={errorStyle}>個人情報を検出したため生成を中止しました。</p>;
  }
  // #289 kill-switch: AI 無効時はその旨を正直に表示する (一般的な失敗と混同させない)。
  if (result.reason === "ai_disabled") {
    return <p style={errorStyle}>AI 機能は現在無効です。</p>;
  }
  return <p style={errorStyle}>生成に失敗しました。時間をおいて再度お試しください。</p>;
}

const panelStyle: React.CSSProperties = {
  marginTop: "1.75rem",
  padding: "1.25rem",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  background: "#fafafa",
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  margin: "0 0 0.5rem",
};
const leadStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.85rem",
  margin: "0 0 0.9rem",
};
const controlsStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
};
const btnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.9rem",
  cursor: "pointer",
};
const liveRegionStyle: React.CSSProperties = { marginTop: "0.9rem" };
const commentFigureStyle: React.CSSProperties = { margin: 0 };
const monthCaptionStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.8rem",
  marginBottom: "0.35rem",
};
const commentStyle: React.CSSProperties = {
  margin: 0,
  padding: "0.75rem 1rem",
  borderLeft: "3px solid #1d4ed8",
  background: "#fff",
  borderRadius: "0 6px 6px 0",
  color: "#111827",
  fontSize: "0.95rem",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
};
const errorStyle: React.CSSProperties = {
  display: "block",
  color: "#b91c1c",
  fontSize: "0.9rem",
  margin: 0,
};
