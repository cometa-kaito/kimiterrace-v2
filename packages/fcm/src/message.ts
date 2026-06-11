/**
 * FCM HTTP v1 「遠隔起動（wake）」メッセージの **純ロジック**（I/O なし・決定論的・単体テスト可能）。
 *
 * 端末アプリ（com.kimiterrace.tvbridge）は **どんな FCM メッセージを受けても常駐サービスを起動し直す**
 * （遠隔起動）。サーバ側は「`data.action=wake` の data メッセージを HIGH priority で送る」だけでよい。
 * 本ファイルは送信ボディの整形と送信可否判定の純関数を提供し、実際の OAuth + HTTP POST は `sender.ts`
 * （薄いアダプタ）に分離する（`@kimiterrace/ai` の Vertex アダプタや Slack 配信と同じ「純関数 + 薄い副作用」分離）。
 *
 * 設計参照: FCM HTTP v1 `projects/<project>/messages:send`。data-only + android.priority=HIGH で、
 * 画面 OFF / Doze の端末でも起こせるようにする（通知ペイロードは付けない＝サイレント data メッセージ）。
 * PII 非含み（ルール4）: payload は `{ action: "wake" }` のみで生徒・保護者情報を一切載せない。
 */

/** 遠隔起動の data ペイロードキー（端末アプリと合意した固定値）。 */
export const FCM_WAKE_ACTION = "wake";

/** FCM HTTP v1 の `messages:send` リクエストボディ（wake 用に必要な最小形のみを型化する）。 */
export interface FcmV1Message {
  message: {
    /** 宛先の登録トークン（端末が報告した tv_devices.fcm_token）。 */
    token: string;
    /** Android 固有オプション。画面 OFF / Doze でも配送されるよう HIGH priority。 */
    android: { priority: "HIGH" };
    /** data-only メッセージ（通知ペイロードなし＝サイレント）。端末は action=wake を見て起動し直す。 */
    data: { action: string };
  };
}

/**
 * 1 端末への wake メッセージボディを組む（純関数）。token は呼び出し側で非空を保証する前提
 * （{@link canSendWake} で判定）。
 */
export function buildWakeMessage(token: string): FcmV1Message {
  return {
    message: {
      token,
      android: { priority: "HIGH" },
      data: { action: FCM_WAKE_ACTION },
    },
  };
}

/**
 * 送信可否（純関数）。`fcm_token` が無い / 空（trim 後）端末には送らない（送信対象外）。
 * 旧 APK（トークン未報告）や報告前の端末を弾き、無駄な FCM 呼び出し・404（UNREGISTERED）を避ける。
 */
export function canSendWake(fcmToken: string | null | undefined): fcmToken is string {
  return typeof fcmToken === "string" && fcmToken.trim().length > 0;
}

/** FCM v1 の `messages:send` エンドポイント URL を組む（純関数）。project は GCP プロジェクト ID。 */
export function fcmSendEndpoint(projectId: string): string {
  return `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
}

/** FCM 送信に必要な OAuth スコープ（メッセージ送信専用、最小権限）。 */
export const FCM_MESSAGING_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
