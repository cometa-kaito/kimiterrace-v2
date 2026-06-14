/**
 * 音声入力（Web Speech API）のエラーコードを「教員向けの短いヒント文言」に写像する純関数。
 *
 * {@link "@/lib/teacher-input/use-speech-to-text"} の `error`（`SpeechRecognitionErrorEvent.error`
 * の値、または対応外ブラウザで本フックが立てる合成コード `"unsupported"`）を受け取り、
 * **「実際の失敗」のときだけ**画面に出すヒントを返す。良性コード（無音タイムアウト `"no-speech"` /
 * 正常な中断 `"aborted"`）や未発生（null / 空文字）では `null` を返し、押下に無反応なときだけ
 * フィードバックする（＝誤った警告でユーザーを驚かせない。PR #876 Reviewer 指摘・非ブロッキング対応）。
 *
 * マイク実機の挙動は CI で再現できないため、「どのコードでヒントを出す / 出さない」をこの純関数に
 * 閉じ込めて unit test で固める（UI 側はこの戻り値を出すだけの薄い殻に保つ）。
 */

/**
 * 良性（＝失敗ではない）エラーコード。ヒントを出さない。
 * - `no-speech`: 一定時間 発話が無かった（タイムアウト）。次に話せばよいだけ。
 * - `aborted`: 認識が正常に中断された（ユーザー操作・再開・画面遷移 等）。
 */
const BENIGN_STT_ERROR_CODES: ReadonlySet<string> = new Set(["no-speech", "aborted"]);

/**
 * @param error `useSpeechToText().error`（直近のエラー種別。未発生なら null）。
 * @returns マイクボタン付近に出すヒント文言。ヒント不要（良性 / 未発生）なら null。
 */
export function sttErrorHint(error: string | null): string | null {
  if (!error || BENIGN_STT_ERROR_CODES.has(error)) {
    // 未発生（null / 空文字）または良性コードは、失敗ではないのでヒントを出さない。
    return null;
  }
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      // マイクの使用許可がブラウザ / OS 側で拒否されている。
      return "マイクを使えませんでした。ブラウザの設定でマイクの使用を許可してください。";
    case "audio-capture":
      // マイクが見つからない / 取得に失敗（未接続・他アプリが占有 等）。
      return "マイクが見つかりませんでした。接続を確認してもう一度お試しください。";
    case "unsupported":
      // このブラウザは Web Speech API 非対応（フックが立てる合成コード）。
      return "このブラウザは音声入力に対応していません。キーボードで入力してください。";
    default:
      // network / その他の想定外コードも「押したのに動かない」失敗なので、汎用ヒントを出す。
      return "音声入力を開始できませんでした。もう一度お試しください。";
  }
}
