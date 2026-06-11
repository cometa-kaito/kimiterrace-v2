import { GoogleAuth } from "google-auth-library";
import {
  FCM_MESSAGING_SCOPE,
  type FcmV1Message,
  buildWakeMessage,
  canSendWake,
  fcmSendEndpoint,
} from "./message.js";

/**
 * FCM HTTP v1 送信の **薄いアダプタ**（OAuth トークン取得 + HTTP POST）。
 *
 * ## 認証（ルール5: 鍵ファイル禁止）
 * `google-auth-library` の `GoogleAuth` が **Application Default Credentials**（Cloud Run / Cloud Run Job の
 * Workload Identity = メタデータサーバ経由）で OAuth アクセストークンを解決する。JSON キーファイルは使わない
 * （`@kimiterrace/ai` の Vertex アダプタが ADC を使うのと同じ。ローカルは `gcloud auth application-default login`）。
 * スコープは `firebase.messaging`（メッセージ送信専用 = 最小権限）。
 *
 * ## 可用性規律（Slack 配信と同じ）
 * 送信失敗（非 2xx / 例外）で **呼び出し元（死活 Job / Server Action）を落とさない**。`send` は throw せず
 * `FcmSendResult` で成否を返す。死活検出（DB 反映）は既に commit 済みであり、遠隔起動の失敗が検出を巻き戻しては
 * ならない。トークン（payload / レスポンス本文）はログに出さない（推測不能値ゆえ、呼び出し元の規律）。
 */

/** 送信結果（throw しない。呼び出し元はログ/集計に使う）。 */
export type FcmSendResult = { ok: true } | { ok: false; status: number | null; errorName: string };

/** 1 メッセージを送る最小インターフェース。テスト / UI はこれを実装したフェイクを注入できる。 */
export interface FcmSender {
  /** 整形済み FCM v1 メッセージを 1 件送る。throw しない。 */
  send(message: FcmV1Message): Promise<FcmSendResult>;
}

/** {@link createGoogleAuthFcmSender} の設定。 */
export interface GoogleAuthFcmSenderConfig {
  /** GCP プロジェクト ID（FCM 送信先 = Firebase プロジェクト。例: signage-v2-prod）。 */
  projectId: string;
  /**
   * OAuth アクセストークン取得関数（テスト用 seam）。未指定なら GoogleAuth（ADC / Workload Identity）で解決。
   * 本番は未指定でよい（メタデータサーバ経由＝鍵ファイル不要、ルール5）。
   */
  getAccessToken?: () => Promise<string | null | undefined>;
  /** HTTP 実行関数（テスト用 seam）。未指定ならグローバル `fetch`（Node 20+ / undici）。 */
  fetchImpl?: typeof fetch;
}

/**
 * GoogleAuth（ADC）で OAuth トークンを取り、FCM HTTP v1 に POST する実装を作る。
 * `getAccessToken` / `fetchImpl` を差し替えればネットワーク・認証なしで `send` の分岐を単体テストできる。
 */
export function createGoogleAuthFcmSender(config: GoogleAuthFcmSenderConfig): FcmSender {
  const endpoint = fcmSendEndpoint(config.projectId);
  const fetchImpl = config.fetchImpl ?? fetch;
  // GoogleAuth は遅延生成（getAccessToken 注入時は構築すらしない＝テストで認証副作用ゼロ）。
  let auth: GoogleAuth | null = null;
  const getAccessToken =
    config.getAccessToken ??
    (() => {
      if (auth === null) {
        auth = new GoogleAuth({ scopes: [FCM_MESSAGING_SCOPE] });
      }
      return auth.getAccessToken();
    });

  return {
    async send(message: FcmV1Message): Promise<FcmSendResult> {
      try {
        const token = await getAccessToken();
        if (!token) {
          // 認証解決に失敗（ADC 未設定等）。throw せず失敗として返す（呼び出し元は落とさない）。
          return { ok: false, status: null, errorName: "no_access_token" };
        }
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(message),
        });
        if (!res.ok) {
          return { ok: false, status: res.status, errorName: "fcm_non_2xx" };
        }
        return { ok: true };
      } catch (err) {
        // ネットワーク例外等。message に payload/token を載せない（name のみ）。
        return {
          ok: false,
          status: null,
          errorName: err instanceof Error ? err.name : "unknown",
        };
      }
    },
  };
}

/**
 * 1 端末に wake メッセージを送る薄い結線（送信可否 → ボディ整形 → send）。`fcm_token` が無い/空なら
 * `skipped` を返して送信しない（送信対象外）。throw しない。
 */
export async function sendWakeToToken(
  sender: FcmSender,
  fcmToken: string | null | undefined,
): Promise<FcmSendResult | { ok: false; status: null; errorName: "skipped_no_token" }> {
  if (!canSendWake(fcmToken)) {
    return { ok: false, status: null, errorName: "skipped_no_token" };
  }
  return sender.send(buildWakeMessage(fcmToken));
}
