"use client";

import { setScheduleAction } from "@/lib/editor/schedule-actions";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { errorTextStyle, secondaryBtnStyle } from "./editor-styles";

/**
 * 基本時間割 seed の**ワンクリック確定**（2026-07-06 実画面監査・忠実度）。
 *
 * seed（F5・コピーオンライト）はエディタの初期値にだけ現れ、保存するまで daily_data に書かれない＝
 * **実サイネージには出ない**。従来の確定手段は「どこかを 1 ヶ所編集して自動保存を発火させる」だけで、
 * 教員が「プレビューに出ている＝もう実機にも出ている」と誤認する導線だった（注記も小さい）。本ボタンは
 * seed 内容をそのまま setScheduleAction（既存の保存経路＝検証・RLS・監査つき）で当日へ materialize し、
 * `?applied=<nonce>` 再ナビ（#1245 と同じ確立済み手法）で配下エディタを確定後データで再マウントする
 * （seed 注記が消え「確定された」ことが見た目で分かる）。
 */
export function SeedConfirmButton({
  classId,
  date,
  items,
}: {
  classId: string;
  date: string;
  /** seed 済みの予定（page.tsx の seedSchedulesForDate の結果）。これをそのまま確定保存する。 */
  items: ScheduleItem[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run() {
    startTransition(async () => {
      const res = await setScheduleAction("class", classId, date, items);
      if (res.ok) {
        const params = new URLSearchParams(searchParams);
        params.set("date", date);
        params.set("applied", String(Date.now()));
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <button type="button" onClick={run} disabled={pending} style={confirmBtnStyle}>
        {pending ? "確定中…" : "この内容で確定"}
      </button>
      {error ? <output style={errorTextStyle}>{error}</output> : null}
    </span>
  );
}

// 小ぶりな二次ボタン（secondaryBtnStyle 基調・注記行に収まる高さ）。
const confirmBtnStyle: React.CSSProperties = {
  ...secondaryBtnStyle,
  minHeight: "30px",
  padding: "0.15rem 0.7rem",
  fontSize: "0.8rem",
};
