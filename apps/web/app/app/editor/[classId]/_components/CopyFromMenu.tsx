"use client";

import {
  copyDayFromAction,
  copyPreviousWeekAction,
  previewCopyDayAction,
  previewCopyWeekAction,
} from "@/lib/editor/copy-day-actions";
import { addDaysUtc, businessWeek, mondayOfWeek } from "@/lib/editor/week-math";
import { previousBusinessDay } from "@/lib/signage/rotation";
import { ConfirmDialog, tokens } from "@kimiterrace/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { errorTextStyle, savedTextStyle, secondaryBtnStyle } from "./editor-styles";

/**
 * 「ほかの日からコピー」統合ツール（旧 前日コピー / 前週コピーの 2 ボタンを 1 つに統合・2026-07-12 ユーザー
 * 要望「なんか使いにくい」への回答）。旧 2 ボタンは (1) 前週だけ「今日を含む週」固定で編集中の日付に追随
 * せず (2) そっくりのグレーボタンが並んで見分けづらく (3) コピー元が押すまで分からず (4) 素の window.confirm
 * で上書きが不安、という 4 つの摩擦があった。本ツールはこれを 1 つのポップオーバーに集約して解消する:
 *
 * - **コピー元を選ぶ**（実日付つき）: 前営業日 / 先週の同じ曜日 / 任意の日 / 先週まるごとこの週へ。前営業日と
 *   週演算はサーバ Action と同じ純関数（{@link previousBusinessDay} / `week-math`）でこの client が確定させ、
 *   ボタン上に見えている日付と実際に複製される日付を一致させる。
 * - **押す前にプレビュー**: 選んだコピー元の件数（予定4 / 連絡2 …）を読み取り専用 Action で取得して見せる。
 *   件数はコピーの単一ソースで数えるので実際に入る件数と一致する。
 * - **コピー先＝いま編集中の日 / 週**に統一。週コピーも編集中の日付の週へ効く（旧「今日固定」の罠を根絶）。
 * - **上書きは on-brand な {@link ConfirmDialog} で明示確認**（何が置き換わるかを言葉で出す）。素の
 *   window.confirm をやめる。
 *
 * 成功後の画面反映は旧ボタンと同じ `?copied=<nonce>` 再ナビゲート（`router.refresh` では配下エディタの
 * `useState(initial…)` が残り反映されない・page.tsx の `key={date}:{copied}` で再マウントさせる回帰ガード）。
 * 検証・認可・監査・RLS・置換保存は各 Server Action 側が担う（本コンポーネントは選択とプレビューと導線だけ）。
 */

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-07-03" → "7/3"。不正はそのまま返す（fail-soft）。 */
function md(date: string): string {
  const [, m, d] = date.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : date;
}
/** "2026-07-03" → "7/3（金）"。曜日は日付から決まる（決定的）。不正はそのまま返す。 */
function mdw(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) {
    return date;
  }
  const weekday = WEEKDAY_JP[new Date(y, m - 1, d).getDay()] ?? "";
  return `${m}/${d}（${weekday}）`;
}

type SourceKind = "prevBusiness" | "lastWeekSameDay" | "customDay" | "lastWeekWhole";

/** 単一日プレビュー（前営業日 / 先週同曜日 / 任意日）の状態。 */
type DayPreview =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; sections: { label: string; count: number }[]; total: number };
/** 週プレビュー（先週まるごと）の状態。 */
type WeekPreview =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; nonEmptyDays: number; total: number };

export function CopyFromMenu({
  classId,
  date,
  hasExistingData,
  sectionsLabel = "予定・連絡・提出物",
}: {
  classId: string;
  /** 編集中の対象日（YYYY-MM-DD）。コピー先はこの日（週コピーはこの日を含む週）。 */
  date: string;
  /** 対象日に既に入力があるか（day コピー時の上書き確認を出すかの判定）。 */
  hasExistingData: boolean;
  /** このパターンの実セクションのラベル列（確認文言用・親が実効パターンから合成して渡す）。 */
  sectionsLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SourceKind>("prevBusiness");
  // 前営業日・週演算は Server Action と同じ純関数でこの client が確定（＝表示＝実際に複製される値）。
  const prevBiz = previousBusinessDay(date);
  const lastWeekSameDay = addDaysUtc(date, -7);
  const toMonday = mondayOfWeek(date);
  const toWeek = businessWeek(toMonday);
  const fromWeek = businessWeek(addDaysUtc(toMonday, -7));
  const [customDate, setCustomDate] = useState<string>(prevBiz ?? addDaysUtc(date, -1));

  const [dayPreview, setDayPreview] = useState<DayPreview | null>(null);
  const [weekPreview, setWeekPreview] = useState<WeekPreview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const reqIdRef = useRef(0);
  const titleId = useId();

  /** 選択中の day コピー元の実日付（週コピーは null）。無効な任意日も null。 */
  const dayFromDate: string | null =
    selected === "prevBusiness"
      ? prevBiz
      : selected === "lastWeekSameDay"
        ? lastWeekSameDay || null
        : selected === "customDay"
          ? DATE_RE.test(customDate) && customDate !== date
            ? customDate
            : null
          : null;

  // プレビュー取得（開いている間・選択やcustom日付の変化で）。stale 応答は reqId で捨てる。
  useEffect(() => {
    if (!open) {
      return;
    }
    const id = ++reqIdRef.current;
    if (selected === "lastWeekWhole") {
      setWeekPreview({ status: "loading" });
      previewCopyWeekAction(classId, date)
        .then((res) => {
          if (id !== reqIdRef.current) {
            return;
          }
          setWeekPreview(
            res.ok
              ? { status: "ready", nonEmptyDays: res.data.nonEmptyDays, total: res.data.total }
              : { status: "error" },
          );
        })
        .catch(() => {
          if (id === reqIdRef.current) {
            setWeekPreview({ status: "error" });
          }
        });
      return;
    }
    if (!dayFromDate) {
      setDayPreview(null);
      return;
    }
    setDayPreview({ status: "loading" });
    previewCopyDayAction(classId, dayFromDate)
      .then((res) => {
        if (id !== reqIdRef.current) {
          return;
        }
        setDayPreview(
          res.ok
            ? {
                status: "ready",
                sections: res.data.sections.map((s) => ({ label: s.label, count: s.count })),
                total: res.data.total,
              }
            : { status: "error" },
        );
      })
      .catch(() => {
        if (id === reqIdRef.current) {
          setDayPreview({ status: "error" });
        }
      });
  }, [open, selected, dayFromDate, classId, date]);

  // Esc で閉じる / 外側クリックで閉じる（ConfirmDialog が開いている間はそちらに譲る）。閉じたらトリガーへ戻す。
  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmOpen) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (confirmOpen) {
        return;
      }
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, confirmOpen]);

  /** コピー先の表示（day = その日 / week = 週レンジ）。 */
  const targetText =
    selected === "lastWeekWhole"
      ? `この週（${md(toWeek[0] ?? date)}〜${md(toWeek[4] ?? date)}）`
      : mdw(date);

  /** いま「コピーできる中身」があるか（コピーボタンの活性判定）。 */
  const canCopy =
    selected === "lastWeekWhole"
      ? weekPreview?.status === "ready" && weekPreview.nonEmptyDays > 0
      : dayPreview?.status === "ready" && dayPreview.total > 0;

  /** day コピーで対象日を上書きするか / week は常に上書き（対象週の既存を置換）。 */
  const willOverwrite = selected === "lastWeekWhole" ? true : hasExistingData;

  const reNavigate = useCallback(() => {
    // `?copied=<nonce>` 付きで再ナビゲート → page.tsx がエディタ key に含めて再マウントし複製後データで初期化する
    // （router.refresh では useState(initial…) が残り反映されない・旧ボタンの Reviewer HIGH と同じ回帰ガード）。
    // date も固定する（下校時刻を跨ぐと既定対象日が翌授業日へ再解決され「コピーが消えた」ように見えるため）。
    const params = new URLSearchParams(searchParams);
    params.set("copied", String(Date.now()));
    params.set("date", date);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, searchParams, date]);

  function doApply() {
    startTransition(async () => {
      if (selected === "lastWeekWhole") {
        const res = await copyPreviousWeekAction(classId, date);
        if (res.ok) {
          setMsg({
            ok: true,
            text: `先週の内容をこの週へコピーしました（${res.data.daysCopied} 日分）。`,
          });
          setConfirmOpen(false);
          setOpen(false);
          reNavigate();
        } else {
          setConfirmOpen(false);
          setMsg({ ok: false, text: res.error.message });
        }
        return;
      }
      if (!dayFromDate) {
        setConfirmOpen(false);
        setMsg({ ok: false, text: "コピー元の日付が正しくありません。" });
        return;
      }
      const res = await copyDayFromAction(classId, dayFromDate, date);
      if (res.ok) {
        const summary = res.data.sections
          .filter((s) => s.count > 0)
          .map((s) => `${s.label} ${s.count}`)
          .join(" / ");
        setMsg({
          ok: true,
          text: `${mdw(res.data.fromDate)}を${mdw(date)}にコピーしました${summary ? `（${summary}）` : ""}。`,
        });
        setConfirmOpen(false);
        setOpen(false);
        reNavigate();
      } else {
        setConfirmOpen(false);
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  function requestApply() {
    if (!canCopy) {
      return;
    }
    if (willOverwrite) {
      setConfirmOpen(true);
      return;
    }
    doApply();
  }

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setMsg(null);
          setOpen((v) => !v);
        }}
        disabled={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={secondaryBtnStyle}
      >
        ほかの日からコピー <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={panelStyle}
        >
          <p id={titleId} style={panelTitleStyle}>
            どこからコピーしますか？
          </p>

          <fieldset style={fieldsetStyle}>
            <legend style={srOnlyStyle}>コピー元</legend>
            <SourceOption
              name="copy-source"
              checked={selected === "prevBusiness"}
              onChange={() => setSelected("prevBusiness")}
              disabled={!prevBiz}
              label="前営業日"
              hint={prevBiz ? mdw(prevBiz) : "—"}
            />
            <SourceOption
              name="copy-source"
              checked={selected === "lastWeekSameDay"}
              onChange={() => setSelected("lastWeekSameDay")}
              disabled={!lastWeekSameDay}
              label="先週の同じ曜日"
              hint={lastWeekSameDay ? mdw(lastWeekSameDay) : "—"}
            />
            <SourceOption
              name="copy-source"
              checked={selected === "customDay"}
              onChange={() => setSelected("customDay")}
              label="任意の日を選ぶ"
              hint={
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => {
                    setSelected("customDay");
                    setCustomDate(e.target.value);
                  }}
                  style={dateInputStyle}
                  aria-label="コピー元の日付"
                />
              }
            />
            <div style={dividerStyle} />
            <SourceOption
              name="copy-source"
              checked={selected === "lastWeekWhole"}
              onChange={() => setSelected("lastWeekWhole")}
              label="先週まるごと、この週へ"
              hint="月〜金の5日分"
            />
          </fieldset>

          {/* コピー元プレビュー（押す前に何が入るか）。 */}
          <div style={previewBoxStyle} aria-live="polite">
            {selected === "lastWeekWhole" ? (
              <WeekPreviewLine preview={weekPreview} fromWeek={fromWeek} />
            ) : dayFromDate ? (
              <DayPreviewLine preview={dayPreview} />
            ) : (
              <span style={mutedTextStyle}>
                {selected === "customDay"
                  ? customDate === date
                    ? "同じ日は選べません。ほかの日を選んでください。"
                    : "コピー元の日付を選んでください。"
                  : "—"}
              </span>
            )}
          </div>

          <p style={targetLineStyle}>
            <span style={mutedTextStyle}>コピー先：</span>
            <strong>{targetText}</strong>
          </p>

          {willOverwrite && canCopy ? (
            <p style={warnStyle}>
              {selected === "lastWeekWhole"
                ? "この週に入力がある日は、置き換えられます。"
                : "この日には既に入力があります。コピーすると今の内容は置き換わります。"}
            </p>
          ) : null}

          <div style={actionsStyle}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              style={ghostBtnStyle}
            >
              閉じる
            </button>
            <button
              type="button"
              onClick={requestApply}
              disabled={pending || !canCopy}
              style={canCopy ? primaryBtnStyle : primaryBtnDisabledStyle}
            >
              {pending ? "コピー中…" : "コピーする"}
            </button>
          </div>
        </div>
      ) : null}

      {msg ? <output style={msg.ok ? savedTextStyle : errorTextStyle}>{msg.text}</output> : null}

      <ConfirmDialog
        open={confirmOpen}
        title="今の内容を置き換えますか？"
        description={
          selected === "lastWeekWhole"
            ? `${targetText}を、先週の同じ曜日の${sectionsLabel}で置き換えます。この週の既存の入力は上書きされます。`
            : `${mdw(date)}を、${dayFromDate ? mdw(dayFromDate) : "選んだ日"}の${sectionsLabel}で置き換えます。今の入力は上書きされます。`
        }
        confirmLabel="置き換えてコピー"
        pending={pending}
        onConfirm={doApply}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** コピー元の 1 選択肢（ラジオ + ラベル + 右に実日付 / 入力）。行全体クリックで選択できる。 */
function SourceOption({
  name,
  checked,
  onChange,
  disabled = false,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  hint: React.ReactNode;
}) {
  return (
    <div style={{ ...optionStyle, ...(disabled ? optionDisabledStyle : null) }}>
      <label style={optionLabelStyle}>
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          style={{ margin: 0 }}
        />
        <span style={{ fontWeight: checked ? 600 : 400 }}>{label}</span>
      </label>
      <span style={optionHintStyle}>{hint}</span>
    </div>
  );
}

function DayPreviewLine({ preview }: { preview: DayPreview | null }) {
  if (!preview || preview.status === "loading") {
    return <span style={mutedTextStyle}>コピー元を確認中…</span>;
  }
  if (preview.status === "error") {
    return <span style={mutedTextStyle}>コピー元を確認できませんでした。</span>;
  }
  if (preview.total === 0) {
    return <span style={mutedTextStyle}>この日には内容がありません。</span>;
  }
  const parts = preview.sections.filter((s) => s.count > 0).map((s) => `${s.label} ${s.count}`);
  return (
    <span>
      <span style={mutedTextStyle}>コピー元の内容：</span>
      {parts.join(" / ")}
    </span>
  );
}

function WeekPreviewLine({
  preview,
  fromWeek,
}: {
  preview: WeekPreview | null;
  fromWeek: string[];
}) {
  const range =
    fromWeek[0] && fromWeek[4] ? `先週（${md(fromWeek[0])}〜${md(fromWeek[4])}）` : "先週";
  if (!preview || preview.status === "loading") {
    return <span style={mutedTextStyle}>{range}を確認中…</span>;
  }
  if (preview.status === "error") {
    return <span style={mutedTextStyle}>{range}を確認できませんでした。</span>;
  }
  if (preview.nonEmptyDays === 0) {
    return <span style={mutedTextStyle}>{range}に入力のある日がありません。</span>;
  }
  return (
    <span>
      <span style={mutedTextStyle}>{range}：</span>
      入力がある {preview.nonEmptyDays} 日分を同じ曜日へ
    </span>
  );
}

const { color, fontSize, radius, space } = tokens;

const wrapStyle: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  flexDirection: "column",
  gap: "0.35rem",
  alignItems: "flex-start",
};
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 0.4rem)",
  left: 0,
  zIndex: 40,
  width: "min(22rem, calc(100vw - 2rem))",
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.16)",
  padding: space.md,
  outline: "none",
};
const panelTitleStyle: React.CSSProperties = {
  margin: `0 0 ${space.sm}`,
  fontSize: fontSize.sm,
  fontWeight: 700,
  color: color.ink,
};
const fieldsetStyle: React.CSSProperties = {
  border: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.1rem",
};
const optionStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.45rem 0.4rem",
  borderRadius: radius.sm,
  fontSize: fontSize.sm,
  color: color.ink,
  minHeight: "40px",
};
// ラジオ + ラベル文言だけを包む label（クリックで選択）。hint（実日付 / date 入力）は label 外の兄弟に置く
// ＝1 つの label に labelable control を 2 つ入れない（date 入力ネストの不正 HTML 回避・Reviewer LOW-2）。
const optionLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  cursor: "pointer",
};
const optionDisabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};
const optionHintStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: fontSize.xs,
  color: color.muted,
};
const dividerStyle: React.CSSProperties = {
  height: "1px",
  background: color.border,
  margin: "0.35rem 0",
};
const dateInputStyle: React.CSSProperties = {
  padding: "0.25rem 0.4rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  fontSize: fontSize.xs,
};
const previewBoxStyle: React.CSSProperties = {
  marginTop: space.sm,
  padding: "0.5rem 0.6rem",
  background: color.bgSoft,
  borderRadius: radius.sm,
  fontSize: fontSize.sm,
  color: color.ink,
  minHeight: "2.2rem",
  display: "flex",
  alignItems: "center",
};
const targetLineStyle: React.CSSProperties = {
  margin: `${space.sm} 0 0`,
  fontSize: fontSize.sm,
  color: color.ink,
};
const warnStyle: React.CSSProperties = {
  margin: `${space.sm} 0 0`,
  fontSize: fontSize.xs,
  color: color.warningFg,
  fontWeight: 600,
};
const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: space.sm,
  marginTop: space.md,
};
const primaryBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 1.1rem",
  background: color.primary,
  color: color.surface,
  border: "none",
  borderRadius: radius.sm,
  cursor: "pointer",
  fontWeight: 600,
};
const primaryBtnDisabledStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: color.muted,
  cursor: "not-allowed",
};
const ghostBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 0.8rem",
  background: "transparent",
  color: color.muted,
  border: "none",
  borderRadius: radius.sm,
  cursor: "pointer",
  fontSize: fontSize.sm,
};
const mutedTextStyle: React.CSSProperties = { color: color.muted };
const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};
