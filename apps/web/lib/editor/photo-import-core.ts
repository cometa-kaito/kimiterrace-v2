import { CHAT_MESSAGE_MAX } from "./assistant-chat-core";

/**
 * P1 写真取込（紙のプリント → 盤面下書き）の **チャット合流の純ロジック**
 * （docs/design/editor-shipping-and-zero-input-2026-07.md §3.2 決定 D5）。
 *
 * 写真の OCR 抽出テキストを、会話型アシスタント（assistant-chat）の **1 user ターン**に変換する。
 * 経路を会話型チャットに合流させる理由（D5）: `days` による複数日振り分け・プレビュー→反映→
 * PII 409/override の UI・`rebaseDraftBeforeFirstTurn` の衝突解決が既に揃っているため、写真専用の
 * パイプラインを新設しない。
 *
 * 本モジュールは **eval（__tests__/ai/evals）とサーバ経路（PR-P2）が同一プロンプト面を共有する**
 * ための単一ソース（純ロジック・DB/Vertex 非依存）。eval が測った反映精度が、そのまま本番の
 * 注入形式の精度になる。
 *
 * ルール4: OCR テキストは PII 未マスクでここへ来る。マスク/soft-gate は呼び出し側
 * （assistant-chat の既存パイプライン = handler が user 全体へ 1 回かける）の責務であり、
 * 本モジュールは文字列を組むだけ。
 */

/**
 * 注入ターンの指示部。system プロンプト（assistant-chat-prompt）の規則（創作禁止・別日は days・
 * 曖昧なら聞き返す）と矛盾しない範囲で、「入力がプリントの書き起こしである」文脈だけを足す。
 */
const PHOTO_IMPORT_HEADER = [
  "次の【プリント本文】は、紙のプリントを撮影した写真から OCR で書き起こしたものです。",
  "この内容を盤面の下書きにしてください。",
  "- プリントに書かれている事実だけを使い、無い情報を創作しない。",
  "- 日付が明記されている項目は、その日付の日に入れる（基準日と別の日は days へ）。",
  "- どの日の内容か読み取れない項目は、下書きに入れず reply で聞き返す。",
  "",
  "【プリント本文】",
].join("\n");

/**
 * OCR 抽出テキスト → 会話型チャットへ注入する user ターン本文。全体が {@link CHAT_MESSAGE_MAX}
 * に収まるよう本文側を切り詰める（parseChatTurns の契約に収める）。空テキストの拒否（no_text）は
 * 呼び出し側の責務（本関数は組むだけ）。
 */
export function buildPhotoImportChatMessage(ocrText: string): string {
  const budget = Math.max(0, CHAT_MESSAGE_MAX - PHOTO_IMPORT_HEADER.length - 1);
  let body = ocrText.trim().slice(0, budget);
  // 切り詰め境界がサロゲートペアを割ると末尾に lone surrogate が残る（絵文字等の astral 文字のみ）。
  // 高位サロゲート単独で終わるときはその 1 code unit を落として文字境界に揃える。
  const lastCode = body.charCodeAt(body.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    body = body.slice(0, -1);
  }
  return `${PHOTO_IMPORT_HEADER}\n${body}`;
}
