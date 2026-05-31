"use client";

/**
 * F07 (#43): サイネージ端末から行動イベントを `POST /signage/{classToken}/events` へ送る**クライアント側**
 * ベストエフォート送信。サーバ側の取り込み・検証・RLS は `lib/signage/event-ingest` + route が担うので、
 * ここは「ロスなく投げる」ことだけに徹する (F07 受け入れ条件: beacon でページ遷移時もロスしない)。
 */

/** 端末ごとの匿名 client id の localStorage キー。 */
const CLIENT_ID_KEY = "kimiterrace.signage.clientId";

/**
 * 端末ごとの**匿名 uuid** を localStorage に保持して返す (F07: client_id は cookie/localStorage の
 * uuid のみ、個人特定情報ではない / ルール4)。無ければ生成して保存する。localStorage が使えない
 * (プライベートモード等) / `crypto.randomUUID` 不在の環境では空文字を返し、呼び出し側は clientId を
 * 載せない (PII も無効値も増やさない)。
 */
export function getClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) {
      return existing;
    }
    if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
      return "";
    }
    const id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return "";
  }
}

/** 送信する行動イベント (サーバの `EventIngestInput` のクライアント側の形)。 */
export type SignageEventBeacon = {
  type: "view" | "tap";
  adId?: string;
  contentId?: string;
  clientId?: string;
  slotIndex?: number;
};

/**
 * 行動イベントを 1 件ベストエフォートで送る。ページ遷移・タブクローズ時もロスしないよう
 * `navigator.sendBeacon` を優先し、未対応環境は `fetch(keepalive)` にフォールバックする。
 * 送信失敗は表示に影響させない (テレメトリのため握りつぶす)。`classToken` は credential なので
 * URL 以外に出さない (route 側で no-store、ログ非反射)。
 */
export function sendSignageEvent(classToken: string, event: SignageEventBeacon): void {
  if (!classToken) {
    return;
  }
  const url = `/signage/${encodeURIComponent(classToken)}/events`;
  const body = JSON.stringify(event);
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // sendBeacon は application/json Blob で送る (route は text→JSON.parse なので content-type 不問)。
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(url, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // 送信経路が無い/失敗してもサイネージ表示は止めない。
  }
}
