/**
 * `@kimiterrace/fcm`: FCM HTTP v1 送信（遠隔起動）。
 *
 * 純ロジック（メッセージ整形・送信可否 = `message.ts`）と薄い HTTP アダプタ（OAuth は Workload Identity =
 * 鍵ファイル不要、ルール5 = `sender.ts`）を分離する。死活 Job（apps/jobs）と管理画面「起こす」（apps/web）の
 * 両方がこのパッケージを使い、FCM 送信ロジックを 1 箇所に集約する。
 */
export {
  FCM_WAKE_ACTION,
  FCM_MESSAGING_SCOPE,
  type FcmV1Message,
  buildWakeMessage,
  canSendWake,
  fcmSendEndpoint,
} from "./message.js";
export {
  type FcmSendResult,
  type FcmSender,
  type GoogleAuthFcmSenderConfig,
  createGoogleAuthFcmSender,
  sendWakeToToken,
} from "./sender.js";
