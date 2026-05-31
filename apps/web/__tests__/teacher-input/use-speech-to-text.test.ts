/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechToText } from "../../lib/teacher-input/use-speech-to-text";

/**
 * F02 (#38): useSpeechToText (Web Speech API ラッパー) のテスト。
 * window.SpeechRecognition を Fake に差し替え、対応判定 / start で listening / onresult の
 * 確定・暫定の振り分け / onend での listening 解除 を検証する。音声データを扱わない (テキストのみ)
 * 設計上、検証対象は transcript/interim 文字列の遷移。
 */

type ResultLike = ArrayLike<{ transcript: string }> & { isFinal: boolean };

/** onresult に渡すイベントを構築する (型キャストなしで構造的に合致させる)。 */
function makeEvent(parts: { transcript: string; isFinal: boolean }[]) {
  const results = parts.map(
    (p): ResultLike => Object.assign([{ transcript: p.transcript }], { isFinal: p.isFinal }),
  );
  return { resultIndex: 0, results };
}

let instances: FakeRecognition[] = [];

class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ResultLike> }) => void) | null =
    null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn();
  constructor() {
    instances.push(this);
  }
}

beforeEach(() => {
  instances = [];
  window.SpeechRecognition = FakeRecognition;
});

/** 直近に生成された認識インスタンス (無ければ失敗)。 */
function current(): FakeRecognition {
  const r = instances[0];
  if (!r) {
    throw new Error("認識インスタンスが生成されていません");
  }
  return r;
}

afterEach(() => {
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
});

describe("useSpeechToText", () => {
  it("対応ブラウザでは supported=true", () => {
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.supported).toBe(true);
  });

  it("未対応 (どちらの ctor も無い) では supported=false で start しても落ちない", () => {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.supported).toBe(false);
    act(() => result.current.start());
    expect(result.current.error).toBe("unsupported");
    expect(result.current.listening).toBe(false);
  });

  it("start で listening=true になり、認識インスタンスを生成して start を呼ぶ", () => {
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    expect(result.current.listening).toBe(true);
    expect(instances).toHaveLength(1);
    expect(current().start).toHaveBeenCalledOnce();
    expect(current().lang).toBe("ja-JP");
    expect(current().interimResults).toBe(true);
  });

  it("onresult: 確定は transcript に追記、暫定は interim に入る", () => {
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    act(() => current().onresult?.(makeEvent([{ transcript: "明日10時から", isFinal: true }])));
    expect(result.current.transcript).toBe("明日10時から");
    act(() => current().onresult?.(makeEvent([{ transcript: "体育館で", isFinal: false }])));
    expect(result.current.transcript).toBe("明日10時から");
    expect(result.current.interim).toBe("体育館で");
  });

  it("onerror で error をセットする", () => {
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    act(() => current().onerror?.({ error: "not-allowed" }));
    expect(result.current.error).toBe("not-allowed");
  });

  it("stop → onend で listening=false に戻り interim を消す", () => {
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    act(() => current().onresult?.(makeEvent([{ transcript: "途中", isFinal: false }])));
    expect(result.current.interim).toBe("途中");
    act(() => result.current.stop());
    expect(result.current.listening).toBe(false);
    expect(result.current.interim).toBe("");
  });

  it("reset は transcript / interim / error を空に戻す", () => {
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    act(() => current().onresult?.(makeEvent([{ transcript: "あ", isFinal: true }])));
    act(() => result.current.reset());
    expect(result.current.transcript).toBe("");
    expect(result.current.interim).toBe("");
    expect(result.current.error).toBeNull();
  });
});
