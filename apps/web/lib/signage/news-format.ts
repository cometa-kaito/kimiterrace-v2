/**
 * 工学ニュース（ADR-043）の表示整形ヘルパ（client-safe・純関数）。盤面の Pattern2News（教室）と
 * pattern3 フッタのニュースカルーセル（{@link Pattern3NewsTicker}）の**両方**から使う単一ソース。
 * 以前は `SignageBoardView` 内のローカル関数だったが、client コンポーネント（ticker）が同関数を必要とし、
 * `SignageBoardView` を import すると循環参照になるため、純関数だけをここへ切り出す（#148 の client/server
 * バンドル分離の踏襲）。
 */

/** ニュース公開日を `M/D` に整形（TZ ドリフト回避に JST 表示）。不正値は空文字。 */
export function formatNewsDate(d: Date): string {
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
  });
}

/** 出典 URL をホスト名（出典ドメイン）に短縮表示する。パース不可は素の URL を返す（fail-soft）。 */
export function formatNewsUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
