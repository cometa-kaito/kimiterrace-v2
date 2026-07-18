import { type RateLimiter, createPerSchoolRateLimiter } from "@kimiterrace/ai";

/**
 * エディタ AI 全経路で共有する **単一の** per-school レートリミッタ（60 req / 分 / 校・NFR06）。
 *
 * 従来はセクションドラフト（assistant-actions）・会話チャット（assistant-chat-sse）・連絡ドラフト
 * （notice-draft-sse）・カレンダー取込（calendar-import-actions）が**それぞれ独立インスタンス**を
 * 持ち、学校あたりの実効上限が経路数ぶん倍増していた（STATUS.md 既知 follow-up。"use server"
 * モジュールは非 async の export ができず、私有インスタンスのままでは共有できなかったのが原因）。
 * 本モジュールに一本化し、P1 写真取込（photo-import-actions）も同じインスタンスに乗る
 * （3 系統目を作らない = 設計 editor-shipping-and-zero-input-2026-07.md §3.2）。
 *
 * F03 教員アップロード（extract-teacher-input.ts）は別機能・別 quota（Route Handler 経路）のため
 * 対象外のまま。スコープ注意: インメモリ実装ゆえ単一プロセス内でのみ正確（rate-limit.ts の注記）。
 */
export const editorAiRateLimiter: RateLimiter = createPerSchoolRateLimiter();
