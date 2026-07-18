"use client";

import { confirmMorningDraftAction } from "@/lib/editor/morning-draft-actions";
import type { MorningDraft, MorningDraftProvenance } from "@/lib/editor/morning-draft-core";
import { type ScheduleItem, scheduleSlotLabel } from "@/lib/editor/schedule-core";
import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import { blockLabel } from "@/lib/signage/pattern-blocks";
import { tokens } from "@kimiterrace/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useCopyUndo } from "./CopyUndoContext";
import { errorTextStyle, primaryBtnDisabledStyle, primaryBtnStyle } from "./editor-styles";

/**
 * P0「朝ドラフト」ゾーン1 カード（editor-shipping-and-zero-input-2026-07.md §3.1・PR-Z3）。
 *
 * 空の授業日を開くと、基本時間割 seed と年間行事から**開いた瞬間に組み上がった今日の下書き**を
 * 出所（provenance）バッジ付きで見せ、**1 クリックで盤面へ確定**できるカード。教員の仕事を「毎日ゼロから
 * 入力」から「確認して直すだけ」へ変える（AI 不使用・決定論）。合成は server（`buildMorningDraft` を page.tsx が
 * 実行）で組み、確定は {@link confirmMorningDraftAction}（サーバで再合成・D4）が行う＝client が組んだ items は
 * 信用しない。除外（×）はキーだけをサーバへ渡す。
 *
 * **既存部品の吸収（§3.1・露出を 1 箇所へ）**: 基本時間割 seed の `SeedConfirmButton` と「この日の行事」の
 * `DayEventsPanel` のワンクリック挿入を本カードに集約する（カード表示日は page.tsx がそれらを出さない）。
 * 確定成功後は `SeedConfirmButton` / `DayEventsPanel` と同じ確立済み手法で反映する:
 * `?applied=<nonce>` 再ナビでフォームを確定後データへ再マウント + undo（`res.data.undo`）を
 * {@link useCopyUndo} に載せる＝**既存の `CopyFromMenu`「元に戻す」が `forKey=date` で拾って復元できる**
 * （undo 経路を新規に作らない・完全復元）。
 *
 * 表示は文言に頼らない（バッジ = 出所・見れば分かる）。値は tokens 準拠（skill design-ui）。
 */
export function MorningDraftCard({
  classId,
  date,
  pattern,
  draft,
}: {
  classId: string;
  date: string;
  /** 実効デザインパターン（セクション見出しラベルの単一ソース blockLabel 用）。 */
  pattern: SignageDesignPattern;
  /** page.tsx が server で `buildMorningDraft` した合成結果（非空のときだけ親が本カードを出す）。 */
  draft: MorningDraft;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { setUndo } = useCopyUndo();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const scheduleRows = useMemo(
    () =>
      (draft.sections.schedules ?? []).map((entry) => ({
        key: entry.key,
        provenance: entry.provenance,
        text: scheduleLine(entry.item),
      })),
    [draft.sections.schedules],
  );
  const noticeRows = useMemo(
    () =>
      (draft.sections.notices ?? []).map((entry) => ({
        key: entry.key,
        provenance: entry.provenance,
        text: entry.item.text,
      })),
    [draft.sections.notices],
  );

  // 除外後に残る件数（0 なら確定ボタンを無効化＝サーバの空拒否を押す前に UI で防ぐ）。
  const remaining =
    scheduleRows.filter((r) => !excluded.has(r.key)).length +
    noticeRows.filter((r) => !excluded.has(r.key)).length;

  function toggle(key: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const res = await confirmMorningDraftAction(classId, date, [...excluded]);
      if (res.ok) {
        // undo を CopyUndoContext に載せる＝既存 CopyFromMenu の「元に戻す」が forKey=date で拾う（新規 undo UI 不要）。
        setUndo({ classId, forKey: date, label: "今日の下書き", days: [res.data.undo] });
        // 確定後データでフォームを再マウント（SeedConfirmButton / DayEventsPanel / #1245 と同じ確立済み手法）。
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
    <section aria-labelledby="morning-draft-heading" style={cardStyle}>
      <h3 id="morning-draft-heading" style={headingStyle}>
        <span aria-hidden="true">📝</span> 今日の下書きができています
      </h3>
      {scheduleRows.length > 0 ? (
        <DraftGroup
          label={blockLabel(pattern, "schedule")}
          rows={scheduleRows}
          excluded={excluded}
          onToggle={toggle}
        />
      ) : null}
      {noticeRows.length > 0 ? (
        <DraftGroup
          label={blockLabel(pattern, "notice")}
          rows={noticeRows}
          excluded={excluded}
          onToggle={toggle}
        />
      ) : null}
      <div style={actionRowStyle}>
        <button
          type="button"
          onClick={confirm}
          disabled={pending || remaining === 0}
          style={pending || remaining === 0 ? primaryBtnDisabledStyle : primaryBtnStyle}
        >
          {pending ? "反映中…" : "この下書きで盤面に出す"}
        </button>
        {remaining === 0 ? <span style={allExcludedNoteStyle}>すべて除外されています</span> : null}
      </div>
      {error ? <output style={errorTextStyle}>{error}</output> : null}
    </section>
  );
}

/** カード内 1 セクション（予定 / 連絡）。各行は出所バッジ + 内容 + ×（除外トグル）。 */
function DraftGroup({
  label,
  rows,
  excluded,
  onToggle,
}: {
  label: string;
  rows: { key: string; provenance: MorningDraftProvenance; text: string }[];
  excluded: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div style={groupStyle}>
      <p style={groupLabelStyle}>{label}</p>
      <ul style={listStyle}>
        {rows.map((row) => {
          const off = excluded.has(row.key);
          return (
            <li key={row.key} style={rowStyle}>
              <span style={provenanceBadgeStyle(row.provenance)}>{row.provenance}</span>
              <span style={off ? rowTextExcludedStyle : rowTextStyle}>{row.text}</span>
              <button
                type="button"
                onClick={() => onToggle(row.key)}
                style={excludeBtnStyle}
                aria-pressed={off}
                aria-label={off ? `「${row.text}」を戻す` : `「${row.text}」を除外`}
              >
                {off ? "戻す" : "×"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 予定 1 件の 1 行表示（時限ラベル + 科目 + 場所）。時限/場所は任意。divider は合成されないので考慮不要。 */
function scheduleLine(item: ScheduleItem): string {
  const period = item.period !== undefined ? scheduleSlotLabel(item.period) : "";
  const head = [period, item.subject].filter((s) => s.length > 0).join(" ");
  return item.location ? `${head}　＠${item.location}` : head;
}

// ── styles（tokens 準拠・skill design-ui。生 hex/px を直書きしない）──────────────────

// 「あなたに下書きが用意できている」affordance: 白カード + 左にブランドブルーの細帯（強調・色のみに頼らず
// 見出しテキストと併用）。盤面プレビューの直上に置くので下 margin で間隔を作る。
const cardStyle: React.CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderLeft: `3px solid ${tokens.color.blueStrong}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.surface,
  padding: `${tokens.space.md} ${tokens.space.md}`,
  marginBottom: tokens.space.md,
};
const headingStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: tokens.space.xs,
  fontSize: tokens.fontSize.md,
  fontWeight: 700,
  color: tokens.color.ink,
  margin: `0 0 ${tokens.space.sm}`,
};
const groupStyle: React.CSSProperties = { marginBottom: tokens.space.sm };
// セクションラベル（予定 / 連絡）は「層のラベル」の視覚言語（小さく太く muted）。
const groupLabelStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  fontWeight: 700,
  color: tokens.color.muted,
  letterSpacing: "0.08em",
  margin: `0 0 ${tokens.space.xs}`,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xs,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: tokens.space.sm,
  flexWrap: "wrap",
};
const rowTextStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  color: tokens.color.ink,
  minWidth: 0,
  overflowWrap: "anywhere",
};
// 除外中の行は取り消し線 + muted（色のみに頼らずテキスト装飾でも示す）。
const rowTextExcludedStyle: React.CSSProperties = {
  ...rowTextStyle,
  color: tokens.color.muted,
  textDecoration: "line-through",
};
// 出所バッジ: テキストラベル + トーンの二重表現（色のみに頼らない・NFR05）。基本時間割 = info（青）/
// 年間行事 = warning（琥珀）。どちらも白背景上 AA を満たす前景色（tokens）。
function provenanceBadgeStyle(provenance: MorningDraftProvenance): React.CSSProperties {
  const tone =
    provenance === "基本時間割"
      ? { fg: tokens.color.infoFg, bg: tokens.color.infoBg, border: tokens.color.infoBorder }
      : {
          fg: tokens.color.warningFg,
          bg: tokens.color.warningBg,
          border: tokens.color.warningBorder,
        };
  return {
    flexShrink: 0,
    fontSize: tokens.fontSize.xs,
    fontWeight: 700,
    color: tone.fg,
    background: tone.bg,
    border: `1px solid ${tone.border}`,
    borderRadius: tokens.radius.pill,
    padding: `0.05rem ${tokens.space.sm}`,
    whiteSpace: "nowrap",
  };
}
// ×（除外）/「戻す」トグル。控えめな三次アクション（枠のみ）。
const excludeBtnStyle: React.CSSProperties = {
  marginLeft: "auto",
  minHeight: "28px",
  padding: `0.1rem ${tokens.space.sm}`,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const actionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: tokens.space.sm,
  flexWrap: "wrap",
  marginTop: tokens.space.sm,
};
const allExcludedNoteStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
};
