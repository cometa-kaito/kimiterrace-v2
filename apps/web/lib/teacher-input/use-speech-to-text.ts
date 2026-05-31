"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * F02 (#38): ブラウザ内 音声→テキスト フック (Web Speech API)。
 *
 * ## セキュリティ設計 (F02 受け入れ条件 / NFR03)
 * - 音声認識は **端末ローカルの Web Speech API のみ**で行い、本フックは**音声データを保存も送信もしない**。
 *   ネットワークに出るのは確定テキストだけ (呼び出し側が POST する)。「校内録音は教員端末ローカルで処理し、
 *   ネットワーク送信はテキスト化後」という受け入れ条件を、サーバーに音声を一切渡さないことで満たす。
 * - 注: ブラウザによっては Web Speech API がベンダのクラウドに音声を送る実装もあるため、本フックは
 *   あくまで「アプリは音声を扱わない」ことを保証する層。STT エンジン自体の選択は ADR-005 / 後続スライスで
 *   Cloud Speech-to-Text に寄せるか判断する (本スライスはアプリ側で音声を保持しないことを担保)。
 *
 * SSR では `window` が無いため `supported=false` で no-op に倒し、ハイドレーション後に判定する。
 * 型は DOM lib に SpeechRecognition が無い環境を想定し、必要な最小インターフェースを宣言する
 * (`as any` / `as unknown as` は使わない = CLAUDE.md ルール3)。
 */

/** Web Speech API の認識結果 1 候補。 */
interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

/** 1 区間の認識結果 (確定 / 暫定)。 */
interface SpeechRecognitionResultLike extends ArrayLike<SpeechRecognitionAlternativeLike> {
  readonly isFinal: boolean;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

/** 標準名 / WebKit ベンダープレフィックスのどちらかから実装を取得。無ければ null (未対応)。 */
function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export interface UseSpeechToText {
  /** ブラウザが Web Speech API に対応しているか (SSR / 未対応では false)。 */
  readonly supported: boolean;
  /** 認識中か。 */
  readonly listening: boolean;
  /** 確定済みテキスト (区切りごとに追記される)。 */
  readonly transcript: string;
  /** 認識中の暫定テキスト (確定すると transcript に移る)。 */
  readonly interim: string;
  /** 直近のエラー種別 (例: "not-allowed" マイク拒否)。 */
  readonly error: string | null;
  start(): void;
  stop(): void;
  /** transcript / interim / error を空に戻す (認識は止めない)。 */
  reset(): void;
}

/**
 * @param lang 認識言語 (既定 ja-JP)。
 */
export function useSpeechToText(lang = "ja-JP"): UseSpeechToText {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // window 依存の判定はハイドレーション後に行う (SSR 不一致回避)。
  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    if (recognitionRef.current) {
      return; // 既に認識中。
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("unsupported");
      return;
    }
    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) {
          continue;
        }
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalChunk += text;
        } else {
          interimChunk += text;
        }
      }
      if (finalChunk) {
        setTranscript((prev) => prev + finalChunk);
      }
      setInterim(interimChunk);
    };
    recognition.onerror = (event) => {
      setError(event.error);
    };
    recognition.onend = () => {
      setListening(false);
      setInterim("");
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();
  }, [lang]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const reset = useCallback(() => {
    setTranscript("");
    setInterim("");
    setError(null);
  }, []);

  return { supported, listening, transcript, interim, error, start, stop, reset };
}
