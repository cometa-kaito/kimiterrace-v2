/**
 * 公開サイネージ `/signage/{classToken}` の **fit-stage（タブレット/PC 用「50 インチ実機モニタ相当」縮小表示・
 * `signage.module.css` §14）を適用するか**の判定ロジック（単一ソース）。page.tsx（Server Component）が
 * リクエストの User-Agent と `?fit` クエリで本関数を呼び、盤面を fit ラッパで包むか素のまま全画面描画かを決める。
 *
 * ## なぜ要るか
 * `/signage/{classToken}` は **実機サイネージ端末（tv-ble-bridge の Android WebView）と、PC/タブレットの人間**の
 * 両方が同じ URL を開く。盤面を 1920×1080 固定ステージに縮小する fit-stage は人間の確認用に有用だが、実機端末は
 * 画面そのものなので**従来どおり全画面いっぱい**に描くべき（端末の実 CSS ビューポートが 1920×1080 でない機種だと
 * fit を当てると見た目が変わってしまう）。そこで**端末＝全画面 / 実ブラウザ＝縮小**に出し分ける。
 *
 * なお `/signage/monitor/{deviceId}` 経路は端末専用なので元から fit ラッパを巻かない（常に全画面）。本判定は
 * classToken 経路だけの関心事。
 */

/**
 * UA が **実機サイネージ端末（埋め込み WebView / TV ブラウザ）** か。誤検知で人間のブラウザを端末扱いしない
 * よう、端末だけを**狭く**拾う（迷ったら fit を当てる側＝人間優先に倒す。端末側が誤って fit されても運用は
 * `?fit=off` で個別に無効化できる安全弁がある）。
 *
 * - Android System WebView は UA に `; wv)` を含む（tv-ble-bridge の WebView もこれに該当）。
 * - Google TV / Android TV / 各社スマート TV の内蔵ブラウザも端末側として全画面に倒す。
 * - PC・タブレットの**実ブラウザ**（Chrome/Safari/Edge/Firefox、iPad/Android タブレット含む）は該当しない。
 */
export function isEmbeddedSignageDevice(ua: string): boolean {
  if (!ua) {
    return false;
  }
  // Android System WebView 判定（`; wv)`）。空白揺れを許容。
  if (/;\s*wv\)/i.test(ua)) {
    return true;
  }
  // TV 内蔵ブラウザ系（端末側）。人間の PC/タブレット UA には現れない語に限定する。
  return /\b(Google ?TV|Android ?TV|CrKey|SMART-TV|SmartTV|BRAVIA|Web0S|Tizen)\b/i.test(ua);
}

/**
 * fit-stage を適用するか。明示クエリ `?fit` が最優先、未指定時は UA で自動判定する。
 *
 * - `fit=on`  → 必ず適用（端末でも強制的に縮小表示。検証用）。
 * - `fit=off` → 必ず非適用（実機端末で UA 判定が外れた場合の**安全弁**。その端末の signage_url に付ければ全画面に戻る）。
 * - 未指定    → 実機端末（{@link isEmbeddedSignageDevice}）でなければ適用（＝PC/タブレットの実ブラウザは縮小、端末は全画面）。
 *
 * @param fitParam `searchParams.fit`（`string | string[] | undefined`）。配列・未知値は「未指定」として扱う。
 * @param ua       リクエストの `user-agent`（`null` 可）。
 */
export function shouldApplyFitStage(
  fitParam: string | string[] | undefined,
  ua: string | null,
): boolean {
  const fit = Array.isArray(fitParam) ? fitParam[0] : fitParam;
  if (fit === "on") {
    return true;
  }
  if (fit === "off") {
    return false;
  }
  return !isEmbeddedSignageDevice(ua ?? "");
}
