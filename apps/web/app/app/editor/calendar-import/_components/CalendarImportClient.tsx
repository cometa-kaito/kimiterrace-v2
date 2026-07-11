"use client";

import {
  type CalendarImportDraftActionResult,
  draftCalendarImportAction,
  saveCalendarImportAction,
} from "@/lib/editor/calendar-import-actions";
import type {
  CalendarImportSanitizeDropped,
  FiscalYearWindow,
} from "@/lib/editor/calendar-import-core";
import type { CalendarImportSaveIssue } from "@/lib/editor/calendar-import-save-core";
import { Button, ConfirmDialog, tokens } from "@kimiterrace/ui";
import { useRef, useState, useTransition } from "react";

const { color, radius, fontSize, space } = tokens;

/**
 * 年間行事予定表ファイル取込のクライアント UI（ADR-049 PR-C）。ファイル選択 → AI 構造化（Server Action）→
 * プレビュー（行の修正・削除 / 年度窓・drop 内訳・氏名 soft-gate の明示）→ 教員の明示確定で置き換え保存。
 * **確認なしの自動保存はしない**（ADR-049 決定 4）。検証・認可・監査・RLS は Server Action 側が担保する。
 */

/** プレビュー表の 1 行（入力欄バインド用に endDate / location は常に文字列・空 = 省略）。 */
type PreviewRow = {
  /** React key 用のローカル連番（行の削除で index が振り直っても入力状態が混線しない）。 */
  key: number;
  summary: string;
  startDate: string;
  endDate: string;
  allDay: boolean;
  location: string;
};

type Draft = {
  rows: PreviewRow[];
  dropped: CalendarImportSanitizeDropped & { malformed: number };
  window: FiscalYearWindow;
  suspectedNameCount: number;
  fileName: string;
};

/** 想定外 reason のフォールバック文言。 */
const GENERIC_ERROR_MESSAGE = "エラーが発生しました。時間をおいて再試行してください。";

/** draft action のエラー reason → 教員向け文言。 */
const DRAFT_ERROR_MESSAGES: Record<string, string> = {
  empty: "ファイルを選択してください。",
  too_large: "ファイルが大きすぎます（上限 10MB）。",
  unsupported_format: "対応していない形式です（Excel(.xlsx) / CSV / PDF / PNG / JPEG のみ）。",
  extract_failed: "ファイルを読み取れませんでした（破損・暗号化の可能性があります）。",
  no_text: "ファイルから文字を読み取れませんでした。",
  too_long: "ファイルの文字量が多すぎます。年間行事予定表のシート/ページだけにしてお試しください。",
  rate_limited: "AI の利用が混み合っています。しばらくおいてから再試行してください。",
  disabled: "AI 機能は現在利用できません。",
  forbidden: "権限がありません。",
  pii_leak:
    "個人情報が残る可能性を検出したため中止しました。ファイルから個人名・連絡先を除いてください。",
  no_result: "行事を読み取れませんでした。ファイルの内容をご確認ください。",
  error: GENERIC_ERROR_MESSAGE,
};

/** drop 内訳キー → 教員向けラベル（沈黙の切り捨て禁止・ADR-049 決定 3 の可視化）。 */
const DROPPED_LABELS: Record<string, string> = {
  invalidDate: "実在しない日付",
  outOfWindow: "年度外の日付",
  duplicates: "重複",
  overCap: "件数上限超過",
  endDateStripped: "終了日のみ破棄（単日にしました）",
  malformed: "読み取れなかった行",
};

export function CalendarImportClient({
  existingCount,
  existingFileName,
}: {
  /** 今年度窓内の取込済み（`file:` 名前空間）行事の概数。置き換え確認の文言に使う。 */
  existingCount: number;
  /** 前回取込のファイル名（取込済みが無ければ null）。 */
  existingFileName: string | null;
}) {
  const [pending, startTransition] = useTransition();
  // 「前回の取込」概況。初期値はサーバ props、同一セッションで保存に成功したら保存結果で更新する
  // （2 回目の置き換え確認ダイアログ・ヒントが古い件数を出さないため・#1270 L1）。
  const [existing, setExisting] = useState<{ count: number; fileName: string | null }>({
    count: existingCount,
    fileName: existingFileName,
  });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [piiSurfaces, setPiiSurfaces] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<CalendarImportSaveIssue[] | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const nextKey = useRef(0);

  function resetResults() {
    setError(null);
    setPiiSurfaces(null);
    setDraft(null);
    setIssues(null);
    setSavedMsg(null);
  }

  function applyDraftResult(r: CalendarImportDraftActionResult) {
    if (r.ok) {
      // 開始日昇順で見やすく（保存順序に意味は無い・表示のみ）。
      const sorted = [...r.events].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
      setDraft({
        rows: sorted.map((ev) => ({
          key: nextKey.current++,
          summary: ev.summary,
          startDate: ev.startDate,
          endDate: ev.endDate ?? "",
          allDay: ev.allDay,
          location: ev.location ?? "",
        })),
        dropped: r.dropped,
        window: r.window,
        suspectedNameCount: r.suspectedNameCount,
        fileName: r.fileName,
      });
      setPiiSurfaces(null);
      setError(null);
      return;
    }
    if (r.reason === "pii_warning") {
      setPiiSurfaces(r.suspectedSurfaces);
      return;
    }
    setError(DRAFT_ERROR_MESSAGES[r.reason] ?? GENERIC_ERROR_MESSAGE);
  }

  /** ファイル → AI 構造化（プレビュー）。`acknowledgePii` は soft-gate 警告後の「続行」時のみ true。 */
  function runDraft(acknowledgePii: boolean) {
    if (!file || pending) {
      return;
    }
    setError(null);
    setIssues(null);
    setSavedMsg(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("file", file);
      applyDraftResult(await draftCalendarImportAction(fd, { acknowledgePii }));
    });
  }

  function updateRow(key: number, patch: Partial<PreviewRow>) {
    setDraft((d) =>
      d ? { ...d, rows: d.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) } : d,
    );
    setIssues(null);
  }

  function removeRow(key: number) {
    setDraft((d) => (d ? { ...d, rows: d.rows.filter((row) => row.key !== key) } : d));
    setIssues(null);
  }

  /** 置き換え保存（ConfirmDialog の確定時のみ・ADR-049 決定 4）。 */
  function save() {
    if (!draft || pending) {
      return;
    }
    startTransition(async () => {
      const events = draft.rows.map((row) => ({
        summary: row.summary,
        startDate: row.startDate,
        // 空欄は「省略」（単日行事）。schema 側でも空文字は省略に正規化されるが、送る前に落として明示する。
        ...(row.endDate !== "" ? { endDate: row.endDate } : {}),
        allDay: row.allDay,
        ...(row.location.trim() !== "" ? { location: row.location.trim() } : {}),
      }));
      const r = await saveCalendarImportAction(events, {
        fileName: draft.fileName,
        dropped: draft.dropped,
        suspectedNameCount: draft.suspectedNameCount,
      });
      setConfirmOpen(false);
      if (r.ok) {
        setSavedMsg(`保存しました（前回の取込 ${r.deleted} 件を削除し、${r.inserted} 件を登録）。`);
        // 今回の保存分が次の置き換え対象になる（#1270 L1: 2 回目の確認文言を最新化）。
        setExisting({ count: r.inserted, fileName: draft.fileName });
        setDraft(null);
        setFile(null);
        return;
      }
      if (r.reason === "invalid") {
        setIssues(r.issues);
        return;
      }
      setError(DRAFT_ERROR_MESSAGES[r.reason] ?? GENERIC_ERROR_MESSAGE);
    });
  }

  const droppedEntries = draft
    ? Object.entries(draft.dropped).filter(([, count]) => count > 0)
    : [];

  return (
    <div style={{ display: "grid", gap: space.lg }}>
      {/* 1) ファイル選択 → 読み取り */}
      <section style={cardStyle} aria-labelledby="calendar-import-file-heading">
        <h2 id="calendar-import-file-heading" style={sectionHeadingStyle}>
          1. ファイルを選ぶ
        </h2>
        <p style={hintStyle}>
          Excel (.xlsx) / CSV / PDF / 画像 (PNG・JPEG) の年間行事予定表に対応しています（上限
          10MB）。書式は学校ごとに違って構いません（AI が読み取ります）。
        </p>
        {existing.count > 0 ? (
          <p style={hintStyle}>
            取込済み: 今年度の行事 {existing.count} 件
            {existing.fileName ? `（${existing.fileName}）` : ""}
            。保存すると前回のファイル取込は丸ごと置き換わります。
          </p>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: space.md, alignItems: "center" }}>
          <input
            type="file"
            accept=".xlsx,.csv,.pdf,.png,.jpg,.jpeg"
            disabled={pending}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              resetResults();
            }}
            aria-label="年間行事予定表ファイル"
          />
          <Button onClick={() => runDraft(false)} disabled={!file || pending}>
            {pending ? "読み取り中…" : "AI で読み取る"}
          </Button>
        </div>
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
        {piiSurfaces ? (
          <div role="alert" style={warnBoxStyle}>
            <p style={{ margin: 0 }}>
              個人名の可能性がある表記が含まれています: <strong>{piiSurfaces.join("、")}</strong>
            </p>
            <p style={{ margin: `${space.xs} 0 0` }}>
              個人名は AI に送らないのが原則です。ファイルから除くのが安全ですが、行事名等の誤検出で
              あればこのまま続行できます。
            </p>
            <div style={{ marginTop: space.sm }}>
              <Button variant="secondary" onClick={() => runDraft(true)} disabled={pending}>
                誤検出なので続行する
              </Button>
            </div>
          </div>
        ) : null}
        {savedMsg ? (
          <p role="status" style={successStyle}>
            {savedMsg}
          </p>
        ) : null}
      </section>

      {/* 2) プレビュー（修正・削除）→ 置き換え保存 */}
      {draft ? (
        <section style={cardStyle} aria-labelledby="calendar-import-preview-heading">
          <h2 id="calendar-import-preview-heading" style={sectionHeadingStyle}>
            2. 内容を確認して保存する
          </h2>
          <p style={hintStyle}>
            対象年度: <strong>{draft.window.fiscalYear} 年度</strong>（{draft.window.start}〜
            {draft.window.end}）。年度外の日付は取り込みません。
          </p>
          {droppedEntries.length > 0 ? (
            <p style={hintStyle}>
              読み取り時に調整した行:{" "}
              {droppedEntries
                .map(([key, count]) => `${DROPPED_LABELS[key] ?? key} ${count} 件`)
                .join(" / ")}
            </p>
          ) : null}
          {draft.suspectedNameCount > 0 ? (
            <p style={warnTextStyle}>
              氏名らしき表記 {draft.suspectedNameCount}{" "}
              件を含む入力から生成しました。行事名に個人名が
              入っていないか確認してから保存してください。
            </p>
          ) : null}

          {issues ? (
            <div role="alert" style={issuesBoxStyle}>
              <p style={{ margin: 0, fontWeight: 600 }}>保存できません。次を修正してください:</p>
              <ul style={{ margin: `${space.xs} 0 0`, paddingLeft: "1.2rem" }}>
                {issues.map((issue) => (
                  <li key={`${issue.index}-${issue.message}`}>
                    {issue.index >= 0 ? `行 ${issue.index + 1}: ` : ""}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* モバイルは表ごと横スクロール（列を潰さない）。 */}
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>行事名</th>
                  <th style={thStyle}>開始日</th>
                  <th style={thStyle}>終了日（複数日のみ）</th>
                  <th style={thStyle}>場所</th>
                  <th style={thStyle}>
                    <span style={srOnlyStyle}>行の削除</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((row, i) => (
                  <tr key={row.key}>
                    <td style={tdStyle}>
                      <input
                        type="text"
                        value={row.summary}
                        maxLength={200}
                        onChange={(e) => updateRow(row.key, { summary: e.target.value })}
                        disabled={pending}
                        style={{ ...inputStyle, minWidth: "12rem" }}
                        aria-label={`行 ${i + 1} の行事名`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="date"
                        value={row.startDate}
                        onChange={(e) => updateRow(row.key, { startDate: e.target.value })}
                        disabled={pending}
                        style={inputStyle}
                        aria-label={`行 ${i + 1} の開始日`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="date"
                        value={row.endDate}
                        onChange={(e) => updateRow(row.key, { endDate: e.target.value })}
                        disabled={pending}
                        style={inputStyle}
                        aria-label={`行 ${i + 1} の終了日（単日は空欄）`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="text"
                        value={row.location}
                        maxLength={100}
                        onChange={(e) => updateRow(row.key, { location: e.target.value })}
                        disabled={pending}
                        style={{ ...inputStyle, minWidth: "8rem" }}
                        aria-label={`行 ${i + 1} の場所`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <Button
                        variant="ghost"
                        onClick={() => removeRow(row.key)}
                        disabled={pending}
                        aria-label={`行 ${i + 1}（${row.summary}）を削除`}
                        style={{ color: color.dangerFg, padding: "0.35rem 0.6rem" }}
                      >
                        削除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft.rows.length === 0 ? (
            <p style={hintStyle}>
              行事がありません。保存するには行事が 1 件以上必要です（取込をやり直してください）。
            </p>
          ) : null}

          <div style={{ display: "flex", gap: space.md, alignItems: "center", flexWrap: "wrap" }}>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={pending || draft.rows.length === 0}
            >
              保存（前回のファイル取込を置き換え）
            </Button>
            <span style={hintStyle}>
              {draft.rows.length} 件を保存します（{draft.fileName}）
            </span>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="ファイル取込を置き換えて保存しますか？"
        description={
          existing.count > 0
            ? `前回のファイル取込（今年度 ${existing.count} 件）を削除し、今回の ${draft?.rows.length ?? 0} 件で置き換えます。iCal 連携の行事には影響しません。`
            : `${draft?.rows.length ?? 0} 件の行事を保存します。`
        }
        confirmLabel="置き換えて保存"
        tone={existing.count > 0 ? "danger" : "primary"}
        pending={pending}
        onConfirm={save}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  display: "grid",
  gap: space.sm,
  padding: "1rem 1.1rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.lg,
  background: color.surface,
};
const sectionHeadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.md,
  fontWeight: 600,
  color: color.ink,
};
const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.muted,
};
const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.dangerFg,
};
const successStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.successFg,
};
const warnTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.warningFg,
};
const warnBoxStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.warningFg,
  background: color.warningBg,
  border: `1px solid ${color.warningBorder}`,
  borderRadius: radius.md,
  padding: "0.75rem 0.9rem",
};
const issuesBoxStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.dangerFg,
  background: color.dangerBg,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: radius.md,
  padding: "0.75rem 0.9rem",
};
const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  minWidth: "640px",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: color.muted,
  padding: "0.4rem 0.5rem",
  borderBottom: `1px solid ${color.border}`,
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderBottom: `1px solid ${color.border}`,
  verticalAlign: "middle",
};
const inputStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.ink,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: "0.35rem 0.5rem",
  width: "100%",
  boxSizing: "border-box",
};
// 視覚的に隠しつつ支援技術には読ませる（.admin-main 配下は position:relative 済で幽霊スクロールしない）。
const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
