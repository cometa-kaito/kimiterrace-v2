"use client";

import { getClientId, sendSignageEvent } from "@/lib/signage/event-beacon";
import {
  cleanupStaleMedia,
  prefetchMedia,
  registerSignageServiceWorker,
  selectPrefetchUrls,
} from "@/lib/signage/media-cache";
import {
  VIEW_HEARTBEAT_MS,
  clampAdDurationMs,
  clampIndex,
  jitteredPollMs,
  jstDateString,
  nextIndex,
  reviveSignageDate,
} from "@/lib/signage/rotation";
import type { SignagePayload } from "@/lib/signage/signage-display";
import { useCallback, useEffect, useRef, useState } from "react";
import { SignageBoardView } from "./SignageBoardView";
import { SignageInvalid } from "./SignageInvalid";
import styles from "./signage.module.css";

/**
 * サイネージ再生制御 Client Island (#48-E2 / F12)。広告ローテーション + 5-10 秒ポーリング自動更新を担う
 * (V1 Firestore `onSnapshot` の置換 / ADR-022 pull 型)。本クライアントに DB アクセスは持ち込まない。
 *
 * **盤面の描画は `SignageBoardView`（純粋な表示層・hooks/effect 無し）に移譲**する（F・盤面ビューの再利用
 * 部品化）。本クライアントはポーリング/実時計/広告ローテーション/テレメトリ/blackout/invalid 等の**再生制御
 * のみ**を持ち、確定状態を `SignageBoardView` の props（`SignageBoardProps`）として渡す。盤面レイアウト・
 * クラス名・出力 DOM は移譲前と同一で、実機サイネージの表示挙動は不変（behavior-preserving）。
 * 再生・ポーリング・テレメトリ・Service Worker の挙動は #48 系実装をそのまま保持する。
 */

export function SignageClient({
  classToken,
  initial,
}: {
  classToken: string;
  initial: SignagePayload;
}) {
  const [data, setData] = useState<SignagePayload>(initial);
  const [invalid, setInvalid] = useState(false);
  const [adIndex, setAdIndex] = useState(0);
  // ヘッダー帯の実時計。SSR と初回クライアント描画を一致させるため null 始まり、マウント後に effect で埋める。
  const [now, setNow] = useState<Date | null>(null);

  const ads = data.ads;
  const adCount = ads.length;
  // 端末別デザイン（このページは ?design 付き URL でロードされ、初期 payload に反映済み）。ポーリングでも
  // 同じデザインを引き継ぐため poll URL に転送する（転送しないと data Route が学校レベル既定/pattern1 に
  // 倒れ初回ポーリングで盤面が切替わってしまう）。ページセッション中は不変なので initial 値を固定で使う。
  const designParam = initial.designPattern;

  // --- 自動更新ポーリング (jitter 付き再帰 setTimeout、tab 非表示時はスキップして接続節約) ---
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    try {
      const res = await fetch(
        `/signage/${encodeURIComponent(classToken)}/data?date=${jstDateString()}&design=${encodeURIComponent(designParam)}`,
        { cache: "no-store" },
      );
      if (res.status === 410) {
        setInvalid(true);
        return;
      }
      if (res.ok) {
        // ⚠️ res.json() ではなく text→JSON.parse(reviver) で **Date 型フィールドを Date に復元**する。
        // res.json() は fetchedAt / publishedAt 等を文字列のまま返し、盤面の Date 利用 (formatNewsDate の
        // getTime 等) が文字列に対して走り TypeError で盤面が落ちる (初期 hydration は RSC が Date 復元する
        // ので無傷、poll だけが壊れていた)。rotation.reviveSignageDate で初期描画と同じ「Date は Date」に揃える。
        setData(JSON.parse(await res.text(), reviveSignageDate) as SignagePayload);
      }
    } catch {
      // ネットワークエラーは握りつぶし、最後に成功した表示を維持する。
    }
  }, [classToken, designParam]);

  useEffect(() => {
    if (invalid) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const loop = () => {
      timer = setTimeout(async () => {
        await poll();
        if (!cancelled) {
          loop();
        }
      }, jitteredPollMs());
    };
    loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll, invalid]);

  // --- ヘッダー実時計。1 秒ごとに更新。マウント後のみ動く (SSR は時計を出さない)。 ---
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // --- 広告ローテーション (現在広告の duration で次へ。件数変動時は index を丸める) ---
  const safeIndex = clampIndex(adIndex, adCount);
  const adsRef = useRef(ads);
  adsRef.current = ads;
  useEffect(() => {
    if (adCount <= 1) {
      return;
    }
    const ms = clampAdDurationMs(adsRef.current[safeIndex]?.durationSec ?? 0);
    const id = setTimeout(() => setAdIndex((i) => nextIndex(i, adCount)), ms);
    return () => clearTimeout(id);
  }, [safeIndex, adCount]);

  // --- 広告 impression テレメトリ (#43 / F07) + 分粒度ハートビート (#322 / ADR-025)。表示中広告の view を
  //     表示開始時 + `VIEW_HEARTBEAT_MS` ごとに送る。到達は (client_id, ad_id, JST分) で dedup されるので
  //     単一広告クラスの過少計上を解消しつつ水増ししない。tab 非表示中は送らない。送信失敗は表示を妨げない。
  //     黒画面中 (`data.blackout`) は広告 media を出さない＝実際には誰も見ていないので view を計上しない
  //     （黒画面で覆った広告のインプレッション水増しを防ぐ・課金健全性）。null にして本 effect を停止する。 ---
  const currentAdId = !data.blackout && adCount > 0 ? (ads[safeIndex]?.adId ?? null) : null;
  useEffect(() => {
    if (!currentAdId) {
      return;
    }
    const sendView = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      const clientId = getClientId();
      sendSignageEvent(classToken, {
        type: "view",
        adId: currentAdId,
        slotIndex: safeIndex,
        ...(clientId ? { clientId } : {}),
      });
    };
    sendView();
    const id = setInterval(sendView, VIEW_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [currentAdId, safeIndex, classToken]);

  // --- 広告タップ (click-through) テレメトリ (#43 / F07)。linkUrl 付き広告のタップで tap を 1 件送る。 ---
  const handleAdTap = useCallback(
    (adId: string, slotIndex: number) => {
      const clientId = getClientId();
      sendSignageEvent(classToken, {
        type: "tap",
        adId,
        slotIndex,
        ...(clientId ? { clientId } : {}),
      });
    },
    [classToken],
  );

  // --- Service Worker 登録 (#48-G)。マウント時に 1 度だけ。失敗しても表示はブロックしない。 ---
  useEffect(() => {
    void registerSignageServiceWorker();
  }, []);

  // --- 広告 media の prefetch / cleanup (#48-G)。URL 集合が変わった時だけ温め、現行に無い旧 media を掃除。 ---
  const prefetchKey = selectPrefetchUrls(ads).join("\n");
  useEffect(() => {
    const urls = prefetchKey ? prefetchKey.split("\n") : [];
    void prefetchMedia(urls);
    void cleanupStaleMedia(urls);
  }, [prefetchKey]);

  if (invalid) {
    return <SignageInvalid />;
  }

  // 黒画面トグル（per-class 運用・パターン非依存）。`data.blackout` が true の間は盤面の代わりに全画面の
  // 黒画面を出す（夜間/イベント等で一時的に画面を消す）。**ポーリングは止めない**: ポーリング/時計等の
  // effect は上で既に登録済みで本 return より後に解除されないため、`false` 復帰を拾って盤面へ自動的に戻る。
  // `false`/`undefined`（旧 payload・取得失敗）は通常描画のままで既存挙動を壊さない（fail-soft）。
  if (data.blackout) {
    return <div className={styles.blackoutScreen} aria-label="サイネージ休止中（黒画面）" />;
  }

  // 配列 index アクセスは T|undefined。盤面ビューへ T|null で渡すため undefined を null に丸める。
  const ad = adCount > 0 ? (ads[safeIndex] ?? null) : null;
  const adLink = ad ? safeHttpUrl(ad.linkUrl) : null;

  // 学校が選んだデザインパターンで盤面ビューが dispatch する（学校別デザイン）。再生制御（ポーリング/
  // ローテーション/テレメトリ/時計）は本コンポーネントが持ち、`SignageBoardView` は表示専用で受け取る。
  return (
    <SignageBoardView
      data={data}
      ad={ad}
      adLink={adLink}
      adCount={adCount}
      safeIndex={safeIndex}
      now={now}
      onAdTap={handleAdTap}
    />
  );
}

/**
 * linkUrl が **http(s) の絶対 URL** の時だけ遷移先として採用する。`javascript:` / `data:` 等の
 * 危険スキームや相対・不正値は null に倒し <a> 化しない (XSS/オープンリダイレクト防止 = 安全側)。
 * 再生制御側で `adLink` を確定して盤面ビューに渡すため、本ヘルパはクライアントに残す。
 */
function safeHttpUrl(linkUrl: string | null): string | null {
  if (!linkUrl) {
    return null;
  }
  try {
    const u = new URL(linkUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? linkUrl : null;
  } catch {
    return null;
  }
}
