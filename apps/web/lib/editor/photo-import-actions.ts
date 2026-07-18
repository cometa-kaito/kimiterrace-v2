"use server";

import type { OcrClient, RateLimiter } from "@kimiterrace/ai";
import { authorizeAssist, extractEditorUploadText, validateEditorUpload } from "./assistant-shared";
import { editorAiRateLimiter } from "./editor-ai-rate-limiter";
import { buildPhotoImportChatMessage } from "./photo-import-core";

/**
 * P1 写真取込の Server Action（設計 editor-shipping-and-zero-input-2026-07.md §3.2 決定 D5）。
 *
 * 紙のプリント写真（png/jpg のみ）→ Gemini OCR → **会話型チャットへ注入する 1 user ターン**を返す。
 * 写真専用の生成パイプラインは作らない: 本 action は「OCR とガード」までを担い、返したターンを
 * クライアントが既存の会話型チャット（assistant-chat SSE）へそのまま送ることで、複数日振り分け
 * （days）・プレビュー→反映・PII soft-gate(409)/override の既存 UI に合流する。
 *
 * 三段ガード（ADR-038・実装は assistant-shared.ts と共有 = 複製しない）:
 * (a) OCR egress の前に per-school rate（editor AI 全経路と**同一インスタンス**・NFR06）
 * (b) egress を audit_log に記録（素材 SHA-256 + 文字数のみ・本文非保存 = ルール4）
 * (c) 抽出テキストの PII マスク/soft-gate は、返したターンを送る assistant-chat SSE が
 *     送信サーフェス全体へ適用する（既存パイプライン・経路の重複実装なし）
 *
 * 文書/表（pdf/docx/xlsx/csv）は既存の AI パネル添付経路（assistant-actions）が担うため、
 * 本 action は画像のみ受理する（`imageOnly`）。
 */

/** テスト差し替え用の依存（既定は共有 rate limiter + 実 Gemini OCR の遅延生成）。 */
export interface PhotoImportDeps {
  rateLimiter: RateLimiter;
  /** 画像 OCR クライアント（ADR-038）。未指定時のみ実 Gemini OCR を遅延生成（テストはフェイク注入）。 */
  ocr?: OcrClient;
  nowMs?: number;
}

/** 写真取込の失敗理由（UI が文言に写像。assistant-actions の理由集合と同じ語彙）。 */
export type PhotoImportErrorReason =
  | "empty"
  | "too_large"
  | "unsupported_format"
  | "extract_failed"
  | "no_text"
  | "rate_limited"
  | "forbidden"
  | "disabled"
  | "error";

export type PhotoImportResult =
  | { ok: true; message: string }
  | { ok: false; reason: PhotoImportErrorReason };

function defaultDeps(): PhotoImportDeps {
  return { rateLimiter: editorAiRateLimiter };
}

/**
 * プリント写真 → チャット注入ターン。成功時の `message` は buildPhotoImportChatMessage（PR-P1 の
 * eval と同一プロンプト面・CHAT_MESSAGE_MAX 内）で組んだ user ターン本文。クライアントはこれを
 * 会話型チャットの新規 user ターンとして送る（保存はしない・下書きは既存チャット UI の確認フロー）。
 */
export async function photoImportChatMessageAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  deps: PhotoImportDeps = defaultDeps(),
): Promise<PhotoImportResult> {
  const validated = validateEditorUpload(formData, { imageOnly: true });
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }

  const auth = await authorizeAssist(scope, targetId);
  if (!auth.ok) {
    // AssistDraftError の理由集合のうち authorizeAssist が返すのは forbidden / disabled / error のみ。
    // 型の縮小はキャストでなく明示写像で行う（ルール3・想定外は error に畳む）。
    const reason = auth.result.reason;
    return {
      ok: false,
      reason: reason === "forbidden" || reason === "disabled" ? reason : "error",
    };
  }

  const extraction = await extractEditorUploadText(validated.upload, auth.actor, auth.target, {
    rateLimiter: deps.rateLimiter,
    ...(deps.ocr !== undefined ? { ocr: deps.ocr } : {}),
    ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
  });
  if (!extraction.ok) {
    return { ok: false, reason: extraction.reason };
  }

  return { ok: true, message: buildPhotoImportChatMessage(extraction.text) };
}
