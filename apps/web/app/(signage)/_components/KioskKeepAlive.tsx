"use client";

import { useEffect } from "react";

/**
 * TV キオスク端末 (tv-ble-bridge) の WebView 上でのみ作用するキープアライブ。
 * Android 側 JS ブリッジ `window.AndroidKiosk.ensureService()` を読み込み直後＋60秒毎に呼び、
 * 夜間等に死んだ常駐サービス (BleService=死活ポーリング/スケジュール) を、前面で生き続ける
 * WebView から蘇生させる（自己回復＋遠隔起動チャネル）。
 * 通常ブラウザでは `AndroidKiosk` が存在しないため no-op（無害）。
 */
export function KioskKeepAlive(): null {
  useEffect(() => {
    const ping = (): void => {
      try {
        (
          window as unknown as { AndroidKiosk?: { ensureService?: () => void } }
        ).AndroidKiosk?.ensureService?.();
      } catch {
        // ブリッジ非搭載 (通常ブラウザ) では何もしない
      }
    };
    ping();
    const id = window.setInterval(ping, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
