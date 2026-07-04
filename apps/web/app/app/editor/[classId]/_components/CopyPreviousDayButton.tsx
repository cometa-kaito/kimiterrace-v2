"use client";

import { copyPreviousDayAction } from "@/lib/editor/copy-day-actions";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { errorTextStyle, savedTextStyle, secondaryBtnStyle } from "./editor-styles";

/**
 * 前日コピー（F3・editor-input-tiers-and-signage-paging.md §7）。前営業日の 予定 / 連絡 / 提出物 を対象日へ
 * 複製する（置換保存・{@link copyPreviousDayAction}）。対象日に既存入力があるときは**上書き確認ダイアログ必須**。
 *
 * ## 成功後の画面反映（`?copied=<nonce>` 再ナビゲート）
 * `router.refresh()` **では反映されない**: 配下エディタ（ScheduleEditor 等）は `useState(initial…)` を
 * マウント時にのみ初期化し、再マウント条件は page.tsx の `key={date}` だが、コピーは**同じ日付**への操作なので
 * key が変わらない（refresh だと成功メッセージだけ出てフォームが空のまま→ stale な自動保存が複製データを
 * 上書き消去しうる・Reviewer 指摘 HIGH）。そこで成功時は `?copied=<nonce>` を付けて `router.replace` し、
 * page.tsx がエディタ key に nonce を含めることで**確実に再マウント**して複製後データで初期化する。
 *
 * 検証・認可・監査（created_by/updated_by = 操作教員）・RLS・前営業日計算は Server Action 側が担う。
 */
export function CopyPreviousDayButton({
  classId,
  date,
  hasExistingData,
  sectionsLabel = "予定・連絡・提出物",
}: {
  classId: string;
  date: string;
  /** 対象日に既に実セクション（実効パターンの編集ブロック）のいずれかに入力があるか。true のとき上書き確認を挟む。 */
  hasExistingData: boolean;
  /**
   * 上書き確認に出すコピー対象セクションのラベル列（例 pattern1「予定・連絡・提出物」/ pattern5
   * 「お知らせ・今日の予定」）。親（page.tsx）が実効パターンから `blockLabel` で合成して渡す（§6.4）。
   * 成功メッセージは action の返す `sections`（サーバ解決のラベル+件数）から組む。
   */
  sectionsLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    // 既存入力があるときは置換の上書き確認を必須にする（誤操作で当日入力を消さない）。
    if (
      hasExistingData &&
      !window.confirm(
        `対象日にすでに入力があります。前営業日の${sectionsLabel}で置き換えますか？（現在の入力は上書きされます）`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await copyPreviousDayAction(classId, date);
      if (res.ok) {
        // 実効パターンの実セクション（サーバが解決したラベル+件数）で成功メッセージを合成する（§6.4）。
        const summary = res.data.sections.map((s) => `${s.label} ${s.count}`).join(" / ");
        setMsg({
          ok: true,
          text: `前営業日（${res.data.fromDate}）を複製しました（${summary}）。`,
        });
        // `?copied=<nonce>` を付けて再ナビゲート → page.tsx がエディタ key に含めて**再マウント**し、複製後
        // データで初期化する（router.refresh だけでは useState(initial…) が残り画面に反映されない。docstring 参照）。
        const params = new URLSearchParams(searchParams);
        params.set("copied", String(Date.now()));
        // `?date` が URL に無いまま cutover（下校時刻）を跨ぐと、再ナビ時に既定対象日が翌授業日へ
        // 再解決され「コピーが消えた」ように見える。コピーを適用した対象日を明示して固定する。
        params.set("date", date);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" onClick={run} disabled={pending} style={secondaryBtnStyle}>
        {pending ? "コピー中…" : "前日をコピー"}
      </button>
      {msg ? <output style={msg.ok ? savedTextStyle : errorTextStyle}>{msg.text}</output> : null}
    </div>
  );
}
