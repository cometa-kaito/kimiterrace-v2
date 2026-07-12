"use client";

import { useEditorDraftSyncRef } from "@/app/app/editor/_components/EditorDraftSyncContext";
import {
  type EditorDayEvent,
  dayEventMetaLabel,
  dayEventToNoticeItem,
  dayEventToScheduleItem,
} from "@/lib/editor/day-events";
import { setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import type { NoticeItem } from "@/lib/editor/notice-assignment-core";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { tokens } from "@kimiterrace/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { errorTextStyle, secondaryBtnStyle } from "./editor-styles";

/**
 * 「この日の行事」パネル（ADR-049 決定 7・PR-D）。編集中日付に該当する学校行事
 * （school_calendar_events・iCal / ファイル取込の両由来）を盤面プレビュー付近に表示し、教員が
 * ワンクリックで盤面の予定 / 連絡へ**確定挿入**できる（「AI/外部データは提案・教員が確定」の UX 原則＝
 * 基本時間割 seed の {@link SeedConfirmButton} と同型）。行事 0 件なら何も描かない（親も渡さない・二重防御）。
 * 取込ページ（CALENDAR_IMPORT_PAGE_PATH）への導線は本パネルではなく page.tsx の planActions に常設する
 * （行事 0 件では本パネルが消えるため、ここに置くと未取込の教員に初回導線が無い鶏と卵になる・#1269 follow-up）。
 *
 * 保存経路は既存の per-section Server Action（setScheduleAction / setNoticesAction・検証 / RLS / 監査つき）
 * への **append 挿入**＝新しい保存経路は発明しない。挿入の基底は共有 ref（{@link useEditorDraftSyncRef}）の
 * 「今この瞬間のフォーム状態」を優先する（per-section 保存は**置換**のため、ページロード後の手入力を知らずに
 * 保存すると消してしまう — AI 反映と同じ P1 穴・2026-07-06 実証 — の再発防止）。ref 未確立（マウント直後等）は
 * サーバ初期値（props）へ fail-soft。成功後は `?applied=<nonce>` 再ナビでフォームを確定後データで再マウントする
 * （SeedConfirmButton / #1245 と同じ確立済み手法。AI チャットの key には applied が入らない＝会話は保たれる）。
 *
 * 同じ行事の二重追加防止は本パネルのスコープ外（教員判断に委ねる・PR body 明記）。
 */
export function DayEventsPanel({
  classId,
  date,
  events,
  canAddSchedule,
  canAddNotice,
  fallbackSchedules,
  fallbackNotices,
}: {
  classId: string;
  date: string;
  /** 編集中日付に該当する行事（page.tsx の getEditorDayEvents の結果）。0 件なら null を描く。 */
  events: EditorDayEvent[];
  /** 実効パターンが予定ブロックを持つか（持たないパターンでは「予定へ追加」を出さない＝死ボタン防止）。 */
  canAddSchedule: boolean;
  /** 実効パターンが連絡ブロックを持つか（同上）。 */
  canAddNotice: boolean;
  /** 挿入基底の fail-soft（共有 ref 未確立時）: フォームと同じサーバ初期値の予定（seed 済み）。 */
  fallbackSchedules: ScheduleItem[];
  /** 挿入基底の fail-soft: フォームと同じサーバ初期値の連絡。 */
  fallbackNotices: NoticeItem[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const syncRef = useEditorDraftSyncRef();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (events.length === 0) {
    return null;
  }

  function addToBoard(section: "schedule" | "notice", ev: EditorDayEvent) {
    setError(null);
    startTransition(async () => {
      // 挿入基底 = フォームの「今この瞬間」（共有 ref）。未確立はサーバ初期値へ fail-soft。
      const current = syncRef?.current;
      const res =
        section === "schedule"
          ? await setScheduleAction("class", classId, date, [
              ...(current ? current.schedules : fallbackSchedules),
              dayEventToScheduleItem(ev),
            ])
          : await setNoticesAction("class", classId, date, [
              ...(current ? current.notices : fallbackNotices),
              dayEventToNoticeItem(ev),
            ]);
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
    <section aria-labelledby="day-events-heading" style={panelStyle}>
      <h3 id="day-events-heading" style={headingStyle}>
        この日の行事
      </h3>
      <ul style={listStyle}>
        {events.map((ev) => (
          <li key={ev.id} style={rowStyle}>
            <span style={metaStyle}>{dayEventMetaLabel(ev)}</span>
            <span style={summaryStyle}>
              {ev.summary}
              {ev.location ? <span style={locationStyle}>＠{ev.location}</span> : null}
            </span>
            <span style={btnRowStyle}>
              {canAddSchedule ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => addToBoard("schedule", ev)}
                  style={addBtnStyle}
                >
                  予定へ追加
                </button>
              ) : null}
              {canAddNotice ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => addToBoard("notice", ev)}
                  style={addBtnStyle}
                >
                  連絡へ追加
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {error ? <output style={errorTextStyle}>{error}</output> : null}
    </section>
  );
}

// 盤面直下（左 sticky カラム）に収まる控えめなパネル。カード枠 + 小さめ文字（planActions 行と同じ視覚言語）。
const panelStyle: React.CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  padding: "0.6rem 0.75rem",
  marginTop: "0.75rem",
};
// 「計画」等のゾーンラベルと同じ「層のラベル」の視覚言語（小さく太く muted）。
const headingStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  fontWeight: 700,
  color: tokens.color.muted,
  letterSpacing: "0.08em",
  margin: "0 0 0.4rem",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};
// メタ（終日 / HH:MM / 期間）は補足＝muted・折返さない。
const metaStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  whiteSpace: "nowrap",
};
const summaryStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  color: tokens.color.ink,
  fontWeight: 600,
  minWidth: 0,
  overflowWrap: "anywhere",
};
const locationStyle: React.CSSProperties = {
  fontWeight: 400,
  color: tokens.color.muted,
};
const btnRowStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: "0.35rem",
  marginLeft: "auto",
};
// SeedConfirmButton と同じ小ぶりな二次ボタン（注記行に収まる高さ）。
const addBtnStyle: React.CSSProperties = {
  ...secondaryBtnStyle,
  minHeight: "30px",
  padding: "0.15rem 0.7rem",
  fontSize: "0.8rem",
  whiteSpace: "nowrap",
};
