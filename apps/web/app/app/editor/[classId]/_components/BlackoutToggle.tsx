"use client";

import { setClassSignageBlackoutAction } from "@/lib/signage/blackout-actions";
import { tokens } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * 教室サイネージの「黒画面」トグル（プレビュータブ）。**Client Component** — `setClassSignageBlackoutAction`
 * を呼んで per-class の黒画面 ON/OFF を切り替える。検証・認可・監査・RLS・cross-tenant 防止は Server Action
 * 側が担保するので、ここは確認ダイアログと結果表示に徹する。
 *
 * **実教室の画面に即時影響する**ため、押下時に `confirm` を挟む（誤操作で授業中の画面を消さない）。文言は
 * 現在状態で出し分ける: OFF 時「サイネージを黒画面にする」/ ON 時「黒画面を解除する」。成功後は
 * `router.refresh()` で server 由来の現在状態（埋め込みプレビューや本トグルの初期値）を取り直す。
 */
export function BlackoutToggle({
  classId,
  initialBlackout,
}: {
  classId: string;
  initialBlackout: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [blackout, setBlackout] = useState(initialBlackout);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function toggle() {
    const next = !blackout;
    // 実教室のサイネージに即反映されるので、状態が変わる操作は必ず確認する。
    const ok = window.confirm(
      next
        ? "この教室のサイネージを黒画面にします（授業中の画面が真っ黒になります）。よろしいですか？"
        : "この教室のサイネージの黒画面を解除し、通常の盤面に戻します。よろしいですか？",
    );
    if (!ok) {
      return;
    }
    startTransition(async () => {
      const res = await setClassSignageBlackoutAction(classId, next);
      if (res.ok) {
        setBlackout(res.data.blackout);
        setMsg({
          ok: true,
          text: res.data.blackout
            ? "黒画面にしました。教室のサイネージに反映されます（最大 1 分）。"
            : "黒画面を解除しました。通常の盤面に戻ります（最大 1 分）。",
        });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={wrapStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          style={blackout ? releaseBtnStyle : blackoutBtnStyle}
          aria-pressed={blackout}
        >
          {pending ? "切り替え中..." : blackout ? "黒画面を解除する" : "サイネージを黒画面にする"}
        </button>
        <span style={stateTextStyle} aria-live="polite">
          {blackout ? "● 現在: 黒画面中" : "現在: 通常表示"}
        </span>
      </div>
      <p style={hintStyle}>
        黒画面にすると、この教室のサイネージ端末が一時的に真っ黒になります（予定・連絡などは保存されたまま）。
        解除すると通常の盤面に戻ります。
      </p>
      {msg ? (
        <output
          style={{
            display: "block",
            color: msg.ok ? tokens.color.successFg : tokens.color.dangerFg,
          }}
        >
          {msg.text}
        </output>
      ) : null}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.5rem",
  margin: "0 0 1rem",
  padding: "0.85rem 1rem",
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  background: tokens.color.bgSoft,
};
// 「黒画面にする」= 状態を消す強めの操作なので暗色（黒地・白文字）で実際の見た目を予告する。
const blackoutBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 1.1rem",
  background: "#111827",
  color: "#fff",
  border: "none",
  borderRadius: tokens.radius.sm,
  cursor: "pointer",
  fontWeight: 600,
};
// 「解除する」= 通常へ戻す復帰操作。白地・枠線の控えめなボタン。
const releaseBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 1.1rem",
  background: "#fff",
  color: tokens.color.ink,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  cursor: "pointer",
  fontWeight: 600,
};
const stateTextStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.muted,
};
const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
};
