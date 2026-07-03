"use client";

import { copyPreviousWeekAction } from "@/lib/editor/copy-day-actions";
import { addDaysUtc, businessWeek, mondayOfWeek } from "@/lib/editor/week-math";
import { jstDateString } from "@/lib/signage/rotation";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { errorTextStyle, savedTextStyle, secondaryBtnStyle } from "./editor-styles";

/** `YYYY-MM-DD` → `M/D`（confirm 文言用の短い表示・不正はそのまま返す fail-soft）。 */
function shortDate(date: string): string {
  const [, m, d] = date.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : date;
}

/**
 * 前週コピー（C2・editor-input-tiers-and-signage-paging.md §7）。**今週（今日を含む週）の月〜金**を、**前週の
 * 同じ曜日**の 予定/連絡/提出物 で置換複製する（{@link copyPreviousWeekAction}）。今週の既存入力を上書きする
 * 一括操作なので**必ず確認ダイアログを挟む**（既存有無に関わらず・前日コピーより影響範囲が広い）。
 *
 * ## 成功後の画面反映（`?copied=<nonce>` 再ナビゲート）
 * `router.refresh()` **では反映されない**: 配下エディタ（WysiwygBoardEditor 配下）は `useState(initial…)` を
 * マウント時にのみ初期化し、再マウント条件は page.tsx の `key={date}:{copied}`。前週コピーは今日を含む
 * **同じ日付**への操作なので、`CopyPreviousDayButton` と同じく成功時に `?copied=<nonce>` を付けて
 * `router.replace` し、エディタ key を変えて**確実に再マウント**して複製後データで初期化する
 * （refresh だと成功メッセージだけ出てフォームが空のまま→ stale な自動保存が複製データを上書き消去しうる）。
 *
 * 検証・認可・監査（created_by/updated_by = 操作教員）・RLS・週割りは Server Action 側が担う。日々の入力
 * （ファースト層）には置かず、カレンダー直後の計画操作ブロック（セカンド層）にのみ置く（3 層分類）。
 */
export function CopyPreviousWeekButton({ classId }: { classId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    // 今週 5 日ぶんの既存入力を置換する一括操作なので、常に上書き確認を必須にする。対象週を具体日付で明示する
    // （Reviewer 指摘 LOW: 特に土日に押した場合「今週」= ほぼ終わった週になるため、日付が無いと誤認しやすい）。
    // ここの週計算は confirm 表示用（action 側が同じ week-math で正を再計算する）。
    const toWeek = businessWeek(mondayOfWeek(jstDateString()));
    const fromMonday = addDaysUtc(mondayOfWeek(jstDateString()), -7);
    const range =
      toWeek[0] && toWeek[4]
        ? `今週（${shortDate(toWeek[0])}〜${shortDate(toWeek[4])}）`
        : "今週（月〜金）";
    if (
      !window.confirm(
        `${range}を前週（${shortDate(fromMonday)} の週）の同じ曜日の内容で置き換えます。今週の既存入力は上書きされます。よろしいですか？`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await copyPreviousWeekAction(classId);
      if (res.ok) {
        setMsg({
          ok: true,
          text: `前週（${res.data.fromWeekStart} の週）を今週へ複製しました（${res.data.daysCopied} 日分）。`,
        });
        // `?copied=<nonce>` を付けて再ナビゲート → page.tsx がエディタ key に含めて**再マウント**し、複製後
        // データで初期化する（router.refresh だけでは useState(initial…) が残り画面に反映されない。docstring 参照）。
        const params = new URLSearchParams(searchParams);
        params.set("copied", String(Date.now()));
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" onClick={run} disabled={pending} style={secondaryBtnStyle}>
        {pending ? "コピー中…" : "今週へ前週をコピー"}
      </button>
      {msg ? <output style={msg.ok ? savedTextStyle : errorTextStyle}>{msg.text}</output> : null}
    </div>
  );
}
