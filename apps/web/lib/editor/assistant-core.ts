import { type NoticeItem, validateNoticeItems } from "./notice-assignment-core";

/**
 * 段C: エディタ AI アシスタント（連絡ドラフト）の **純ロジック**。`"use server"` ファイル
 * (assistant-actions.ts) は async export しか持てないため、型・プロンプト・JSON パースをここに分離する
 * (schedule-core / notice-assignment-core と同方針)。DB / Vertex 非依存でテスト可能。
 *
 * 本MVP は「連絡(notices)」のみ AI 下書き対象。時間割/提出物の AI 化は後続。
 */

/** AI 連絡ドラフトの結果（client が UI に写像する判別共用体）。本文/生PIIは ok 時の notices のみ。 */
export type AssistDraftResult =
  | { ok: true; notices: NoticeItem[] }
  | {
      // ADR-030 PII soft-gate: 氏名らしき高確信パターン検出・未 override で送信保留。surfaces は警告表示用。
      ok: false;
      reason: "pii_warning";
      suspectedSurfaces: string[];
    }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "disabled" // AI_ENABLED OFF
        | "rate_limited"
        | "pii_leak" // マスク漏れ fail-closed 作動
        | "empty" // 入力空
        | "too_long" // 入力過大
        | "too_large" // ファイルサイズ上限超過
        | "unsupported_format" // 対応外ファイル形式（画像 OCR 未配線含む）
        | "no_text" // ファイルからテキストを抽出できなかった
        | "extract_failed" // ファイル解析失敗（破損/暗号化等）
        | "no_result" // モデル応答が空/不正
        | "error";
    };

/** Gemini への system 指示（連絡ドラフト専用・個人名/日付の創作を禁止、JSON のみ）。 */
export const NOTICE_ASSIST_SYSTEM = [
  "あなたは日本の学校の掲示「連絡（お知らせ）」作成を補助するアシスタントです。",
  "入力された教員のメモ・発話を、サイネージ掲示用の短い『連絡』に整形します。",
  '出力は必ず次の JSON のみ: {"notices":[{"text":string,"isHighlight":boolean}]}',
  "- notices は 1〜5 件。各 text は1文・最大120文字程度の簡潔な日本語にする。",
  "- 重要な注意喚起のみ isHighlight:true、通常は false。",
  "- 入力に無い事実・日付・個人名を創作しない。氏名や電話番号等の個人情報は出力に含めない。",
  "- マスクトークン（例 {{STAFF_001}}）が入力にあればそのまま保持する。",
  "JSON 以外の文字（説明文・コードフェンス）は一切出力しない。",
].join("\n");

/** ユーザープロンプト（マスク済みメモを渡す）。 */
export function buildNoticeAssistUser(maskedInput: string): string {
  return `次のメモから連絡を作成してください:\n\n${maskedInput}`;
}

/** 入力長の上限（過大入力を弾く・rate/コスト保護）。 */
export const ASSIST_INPUT_MAX = 4000;

/** モデルの生 JSON テキストから NoticeItem[] を取り出す（パース失敗・形不正は null）。 */
export function parseNoticeProposal(text: string): NoticeItem[] | null {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  const notices = (json as { notices?: unknown } | null)?.notices;
  const v = validateNoticeItems(notices);
  return v.ok ? v.value : null;
}

/** モデルが稀に付ける ```json ... ``` コードフェンスを剥がす。 */
function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m?.[1] ?? t;
}
