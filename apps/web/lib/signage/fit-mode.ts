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
 * UA が **実機サイネージ端末（tv-ble-bridge の Android System WebView）** か。fit-mode の既定原則「誤検知で
 * 人間のブラウザを端末扱いしない／迷ったら fit を当てる側＝人間優先」に従い、端末は**確実な WebView シグナル
 * （`; wv)`）だけ**で拾う。
 *
 * - tv-ble-bridge（実機端末）の Android System WebView は UA に必ず `; wv)` を含む → これだけを端末とする。
 * - **スマート TV / Google TV 等の「内蔵ブラウザ」は端末扱いしない**（旧実装は UA 名 `Google TV/BRAVIA/Tizen…`
 *   でも拾っていたが、人間が 50inch スマートモニタの内蔵ブラウザで開いた盤面まで端末扱いになり、fit-stage
 *   が外れて崩れた＝ヘッダ/天気が画面外・人物列が潰れる・2026-06-23 実機確認）。これらは人間の確認・常時表示
 *   にも使うので fit を当てて 1920×1080 の忠実な縮小コピーを見せる。
 * - PC・タブレットの**実ブラウザ**（Chrome/Safari/Edge/Firefox、iPad/Android タブレット含む）も該当しない。
 * - UA 判定が外れた実機端末（万一 `; wv)` を持たない機種）は signage_url に `?fit=off` を付ける安全弁で全画面へ戻す。
 */
export function isEmbeddedSignageDevice(ua: string): boolean {
  if (!ua) {
    return false;
  }
  // 端末＝Android System WebView のみ（`; wv)`・空白揺れ許容）。スマート TV/Google TV の内蔵ブラウザは UA 名で
  // 拾わない（人間優先＝fit を当てて崩れを防ぐ）。詳細は関数 doc 参照。
  return /;\s*wv\)/i.test(ua);
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
