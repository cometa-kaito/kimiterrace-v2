"use client";

import {
  type CalendarImportDraftActionResult,
  type CalendarImportSaveMode,
  draftCalendarImportAction,
  saveCalendarImportAction,
} from "@/lib/editor/calendar-import-actions";
import type {
  CalendarImportSanitizeDropped,
  FiscalYearWindow,
} from "@/lib/editor/calendar-import-core";
import {
  type CalendarImportReplaceDiff,
  type FileImportedEventSummary,
  diffCalendarImportReplace,
} from "@/lib/editor/calendar-import-diff";
import type { CalendarImportSaveIssue } from "@/lib/editor/calendar-import-save-core";
import {
  eventDateRangeLabel,
  groupEventsByMonth,
  jpDateLabel,
} from "@/lib/editor/calendar-import-view";
// メインバレル @kimiterrace/db は client から import 不可（#1269）。キーは drizzle 非依存サブパスで読む。
import { fileImportEventDiffKey } from "@kimiterrace/db/calendar-import-key";
import { Button, ConfirmDialog, tokens } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

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
  existingFileEvents,
  existingFileName,
  onDirtyChange,
  onSaved,
}: {
  /**
   * 今年度窓内の取込済み（`file:` 名前空間）行事。置き換え確認の文言と、確認ダイアログの
   * 差分表示（追加/継続/**削除される行事**の一覧・#1259 教員 FB）の existing 側に使う。
   * 今年度窓の読みなので過年度に取り込んだ行事は含まない**概算**（置き換え削除自体は
   * `file:` 名前空間全体・page.tsx のコメント参照）。
   */
  existingFileEvents: FileImportedEventSummary[];
  /** 前回取込のファイル名（取込済みが無ければ null）。 */
  existingFileName: string | null;
  /**
   * 「畳む（unmount）と失われる状態」（AI 読み取り中 / プレビュー表示中）の有無を親へ通知する
   * （開閉マネージャが畳む操作に破棄確認を挟む判断に使う・#1274 follow-up）。
   */
  onDirtyChange?: (dirty: boolean) => void;
  /** 置き換え保存の成功通知（保存結果メッセージ付き）。親が取込セクションを自動で畳むのに使う。 */
  onSaved?: (message: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // 「前回の取込」概況。初期値はサーバ props、同一セッションで保存に成功したら保存結果で更新する
  // （2 回目の置き換え確認ダイアログ・ヒント・差分表示が古い内容を出さないため・#1270 L1）。
  const [existing, setExisting] = useState<{
    events: FileImportedEventSummary[];
    fileName: string | null;
  }>({
    events: existingFileEvents,
    fileName: existingFileName,
  });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [piiSurfaces, setPiiSurfaces] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<CalendarImportSaveIssue[] | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 保存モード（2026-07-12 ユーザー判断）。既定は従来どおりの完全置き換え。ファイルを選び直すと
  // resetResults で replace に戻す（前のファイルで選んだマージが意図せず持ち越されない）。
  const [saveMode, setSaveMode] = useState<CalendarImportSaveMode>("replace");
  // 開始日を編集中の行だけは「編集開始時点の月」でグループ位置を凍結する（key + その時の startDate を保持）。
  // 月グループは startDate から毎描画で再計算されるため、凍結しないと 1 押下ごとに別月グループ（別 tbody）へ
  // 行が飛んで tr が remount し、date input のフォーカスが失われる（矢印キーでの月修正が事実上不能・#1274 FB）。
  // 確定（blur / Enter）で null に戻し、最新値で再グループ化する。
  const [freezeStart, setFreezeStart] = useState<{ key: number; date: string } | null>(null);
  const nextKey = useRef(0);

  // 読み取り中（pending）か未保存プレビュー（draft）がある間だけ dirty（親の破棄確認ゲート用）。
  // エラー / PII 警告 / 選択済みファイルだけの状態は選び直しが容易なので dirty に含めない。
  const dirty = pending || draft !== null;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function resetResults() {
    setError(null);
    setPiiSurfaces(null);
    setDraft(null);
    setIssues(null);
    setSavedMsg(null);
    setFreezeStart(null);
    setSaveMode("replace");
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

  /** 保存（ConfirmDialog の確定時のみ・ADR-049 決定 4）。モードは saveMode（置換 / マージ）。 */
  function save() {
    if (!draft || pending) {
      return;
    }
    startTransition(async () => {
      // 表示（月グループ）と同じ順で送る: 保存エラーの「行 N」がプレビューの見た目の行番号と一致する。
      const orderedRows = groupEventsByMonth(draft.rows, (row) => row.startDate).flatMap(
        (g) => g.items,
      );
      const events = orderedRows.map((row) => ({
        summary: row.summary,
        startDate: row.startDate,
        // 空欄は「省略」（単日行事）。schema 側でも空文字は省略に正規化されるが、送る前に落として明示する。
        ...(row.endDate !== "" ? { endDate: row.endDate } : {}),
        allDay: row.allDay,
        ...(row.location.trim() !== "" ? { location: row.location.trim() } : {}),
      }));
      const r = await saveCalendarImportAction(
        events,
        {
          fileName: draft.fileName,
          dropped: draft.dropped,
          suspectedNameCount: draft.suspectedNameCount,
        },
        saveMode,
      );
      setConfirmOpen(false);
      if (r.ok) {
        const message =
          r.mode === "merge"
            ? `保存しました（追加 ${r.inserted - r.deleted} 件・更新 ${r.deleted} 件・既存 ${r.keptExisting} 件はそのまま）。`
            : `保存しました（前回の取込 ${r.deleted} 件を削除し、${r.inserted} 件を登録）。`;
        setSavedMsg(message);
        // 今回の保存結果が次の保存の「既存」になる（#1270 L1: 2 回目の確認文言・差分表示を最新化）。
        const savedEvents: FileImportedEventSummary[] = events.map((ev) => ({
          summary: ev.summary,
          startDate: ev.startDate,
          endDate: ev.endDate ?? null,
          location: ev.location ?? null,
        }));
        // マージは「キー非一致の既存 + 今回保存分」（サーバの keptExisting と同じキー計算・単一ソース）。
        const savedKeys = new Set(savedEvents.map((s) => fileImportEventDiffKey(s)));
        const nextExistingEvents =
          r.mode === "merge"
            ? [
                ...existing.events.filter((ev) => !savedKeys.has(fileImportEventDiffKey(ev))),
                ...savedEvents,
              ]
            : savedEvents;
        setExisting({
          events: nextExistingEvents,
          fileName: draft.fileName,
        });
        setDraft(null);
        setFile(null);
        // 同ページ先頭の「登録済みの行事」（server component）を保存結果で最新化する。
        router.refresh();
        // 親（開閉マネージャ）が取込セクションを自動で畳み、メッセージを一覧の上に引き継ぐ。
        onSaved?.(message);
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

  // 月グループ化した表示順（教員 FB「月順で線で区切って分かり易く」・登録済み一覧と同じ単一ソース）。
  // 保存ペイロードも同順で送る（save() 参照）ので、エラーの「行 N」は見た目の行番号と一致する。
  // 開始日を編集中の行だけは凍結した月キーで位置を固定し、確定まで tbody を跨がせない（remount＝フォーカス喪失防止）。
  const groupingStartDate = (row: PreviewRow): string =>
    freezeStart !== null && freezeStart.key === row.key ? freezeStart.date : row.startDate;
  const previewGroups = draft ? groupEventsByMonth(draft.rows, groupingStartDate) : [];
  const rowOrdinal = new Map(previewGroups.flatMap((g) => g.items).map((row, i) => [row.key, i]));

  // 置き換え保存の差分（確認ダイアログの表示専用・保存ペイロードには関与しない）。「部分ファイルを
  // 取り込むと既存行事が気づかず消える」弱点への対策として、削除される行事を保存前に明示する（#1259）。
  const replaceDiff = draft ? diffCalendarImportReplace(existing.events, draft.rows) : null;

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
        {existing.events.length > 0 ? (
          <p style={hintStyle}>
            取込済み: 今年度の行事 {existing.events.length} 件
            {existing.fileName ? `（${existing.fileName}）` : ""}
            。保存時に「完全に置き換える」か「既存に追加・更新する」かを選べます。
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
            対象年度: <strong>{draft.window.fiscalYear} 年度</strong>（
            {jpDateLabel(draft.window.start)}〜{jpDateLabel(draft.window.end)}
            ）。年度外の日付は取り込みません。
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
              {previewGroups.map((group) => (
                <tbody key={group.monthKey}>
                  {/* 月見出し行（薄地 + 上線 = 月の区切り線・登録済み一覧と同じ見せ方）。 */}
                  <tr>
                    <th colSpan={5} scope="colgroup" style={monthHeadingStyle}>
                      {group.label}
                    </th>
                  </tr>
                  {group.items.map((row) => {
                    const i = rowOrdinal.get(row.key) ?? 0;
                    return (
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
                            // 編集開始時点の月へ位置を凍結（矢印キー等で 1 押下ごとに別 tbody へ飛ぶのを止める）。
                            onFocus={() => setFreezeStart({ key: row.key, date: row.startDate })}
                            // 確定で凍結解除 → 最新値で再グループ化（行が正しい月へ移動）。
                            onBlur={() => setFreezeStart(null)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.currentTarget.blur();
                              }
                            }}
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
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
          {draft.rows.length === 0 ? (
            <p style={hintStyle}>
              行事がありません。保存するには行事が 1 件以上必要です（取込をやり直してください）。
            </p>
          ) : null}

          {/* 保存モード選択（2026-07-12 ユーザー判断）。既定 = 完全置き換え（従来挙動）。 */}
          <fieldset style={modeFieldsetStyle}>
            <legend style={modeLegendStyle}>保存のしかた</legend>
            <label style={modeLabelStyle}>
              <input
                type="radio"
                name="calendar-import-save-mode"
                checked={saveMode === "replace"}
                onChange={() => setSaveMode("replace")}
                disabled={pending}
                style={modeRadioStyle}
              />
              <span>
                <strong>完全に置き換える</strong>
                <span style={modeRecommendStyle}>推奨: 年間予定表の改訂版を取り込むとき</span>
                <span style={modeDescStyle}>
                  前回のファイル取込をすべて削除し、今回の内容だけにします。
                </span>
              </span>
            </label>
            <label style={modeLabelStyle}>
              <input
                type="radio"
                name="calendar-import-save-mode"
                checked={saveMode === "merge"}
                onChange={() => setSaveMode("merge")}
                disabled={pending}
                style={modeRadioStyle}
              />
              <span>
                <strong>既存に追加・更新する</strong>
                <span style={modeRecommendStyle}>部分的な予定表を追加するとき</span>
                <span style={modeDescStyle}>
                  同じ行事名・開始日の行事は今回の内容に更新し、それ以外の取込済み行事はそのまま残します。
                </span>
              </span>
            </label>
          </fieldset>

          <div style={{ display: "flex", gap: space.md, alignItems: "center", flexWrap: "wrap" }}>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={pending || draft.rows.length === 0}
            >
              {saveMode === "merge"
                ? "保存（既存に追加・更新）"
                : "保存（前回のファイル取込を置き換え）"}
            </Button>
            <span style={hintStyle}>
              {draft.rows.length} 件を保存します（{draft.fileName}）
            </span>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={
          saveMode === "merge"
            ? "既存に追加・更新して保存しますか？"
            : "ファイル取込を置き換えて保存しますか？"
        }
        description={
          // マージ: 追加/更新/そのまま残る既存の内訳 + 「削除される行事はありません」を明示。
          saveMode === "merge" && replaceDiff !== null ? (
            <>
              今回の {draft?.rows.length ?? 0} 件を取込済みの行事に追加・更新します。iCal
              連携の行事には影響しません。
              <MergeDiffSummary diff={replaceDiff} />
            </>
          ) : // 置換 & 初回取込（既存 0 件）は消えるものが無いので従来どおりのシンプルな確認。
          existing.events.length > 0 && replaceDiff !== null ? (
            <>
              前回のファイル取込（今年度 {existing.events.length} 件）を削除し、今回の{" "}
              {draft?.rows.length ?? 0} 件で置き換えます。iCal 連携の行事には影響しません。
              <ReplaceDiffSummary diff={replaceDiff} />
            </>
          ) : (
            `${draft?.rows.length ?? 0} 件の行事を保存します。`
          )
        }
        confirmLabel={saveMode === "merge" ? "追加・更新して保存" : "置き換えて保存"}
        // マージは既存を消さないので danger にしない。置換は既存があるときのみ danger（従来どおり）。
        tone={saveMode === "replace" && existing.events.length > 0 ? "danger" : "primary"}
        pending={pending}
        onConfirm={save}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** 削除される行事一覧の表示上限。超過分は件数（「他 N 件」）で必ず明示する（沈黙の切り捨て禁止）。 */
const REMOVED_LIST_MAX = 20;

/**
 * 置き換え保存の差分サマリ（確認ダイアログの description 内・表示専用）。
 * 「追加 / 継続 / 削除される行事」の件数と、**削除される行事の一覧**（日付 + 行事名）を出す。
 * 削除 0 件でも「削除される行事はありません」を明示して安心を与える。
 * ConfirmDialog の description は `<p>` に包まれるため、ブロック要素（div/ul）を使わず
 * `display:block` の span のみで組む（invalid DOM nesting を作らない）。
 */
function ReplaceDiffSummary({
  diff,
}: {
  diff: CalendarImportReplaceDiff<FileImportedEventSummary, { summary: string; startDate: string }>;
}) {
  const removedShown = diff.removed.slice(0, REMOVED_LIST_MAX);
  const removedRest = diff.removed.length - removedShown.length;
  return (
    <>
      <span style={diffCountsStyle}>
        追加 {diff.added.length} 件 / 継続 {diff.kept} 件 /{" "}
        <strong style={diff.removed.length > 0 ? { color: color.dangerFg } : undefined}>
          削除される行事 {diff.removed.length} 件
        </strong>
      </span>
      {diff.removed.length > 0 ? (
        <span style={removedListStyle}>
          {/* 既存イベントは保存時に (summary, startDate) で dedupe 済み = このキーで一意。 */}
          {removedShown.map((ev) => (
            <span key={`${ev.startDate}|${ev.summary ?? ""}`} style={removedItemStyle}>
              {eventDateRangeLabel(ev.startDate, ev.endDate)} {ev.summary ?? "（名称なし）"}
            </span>
          ))}
          {removedRest > 0 ? <span style={removedItemStyle}>他 {removedRest} 件</span> : null}
        </span>
      ) : (
        <span style={diffSafeStyle}>削除される行事はありません。</span>
      )}
    </>
  );
}

/**
 * マージ保存の差分サマリ（確認ダイアログの description 内・表示専用）。同じ diff 計算を
 * マージ意味論で読み替える: kept = キー一致（**更新**される）、removed = 既存のみ（削除されず
 * **そのまま残る**）。マージは既存を消さないので「削除される行事はありません。」を常に明示する。
 */
function MergeDiffSummary({
  diff,
}: {
  diff: CalendarImportReplaceDiff<FileImportedEventSummary, { summary: string; startDate: string }>;
}) {
  return (
    <>
      <span style={diffCountsStyle}>
        追加 {diff.added.length} 件 / 更新 {diff.kept} 件 / そのまま残る既存 {diff.removed.length}{" "}
        件
      </span>
      <span style={diffSafeStyle}>削除される行事はありません。</span>
    </>
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
/** 月見出し行（教員 FB「月順で線で区切って」= 薄地 + 上線で月の境界を明示・登録済み一覧と同トーン）。 */
const monthHeadingStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: fontSize.sm,
  fontWeight: 700,
  color: color.ink,
  background: color.bgSoft,
  padding: "0.45rem 0.5rem",
  borderTop: `2px solid ${color.border}`,
  borderBottom: `1px solid ${color.border}`,
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
/** 保存モード選択（fieldset のブラウザ既定枠を落として card 内の一区画として馴染ませる）。 */
const modeFieldsetStyle: React.CSSProperties = {
  display: "grid",
  gap: space.sm,
  margin: 0,
  padding: "0.6rem 0.75rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.bgSoft,
};
const modeLegendStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: color.ink,
  padding: "0 0.25rem",
};
const modeLabelStyle: React.CSSProperties = {
  display: "flex",
  gap: space.sm,
  alignItems: "flex-start",
  fontSize: fontSize.sm,
  color: color.ink,
  cursor: "pointer",
};
const modeRadioStyle: React.CSSProperties = {
  marginTop: "0.2rem",
  flexShrink: 0,
};
/** モード名の横に添える用途ラベル（推奨/部分取込の使い分けを一目で）。 */
const modeRecommendStyle: React.CSSProperties = {
  marginLeft: space.sm,
  fontSize: fontSize.xs,
  color: color.muted,
};
const modeDescStyle: React.CSSProperties = {
  display: "block",
  fontSize: fontSize.xs,
  color: color.muted,
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
/** 差分サマリの件数行（ダイアログ本文より一段強く・追加/継続/削除を 1 行で）。 */
const diffCountsStyle: React.CSSProperties = {
  display: "block",
  marginTop: space.md,
  color: color.ink,
};
/** 削除される行事の一覧（警告トーン = 既存 danger トークン踏襲・長い場合はスクロール）。 */
const removedListStyle: React.CSSProperties = {
  display: "block",
  marginTop: space.xs,
  maxHeight: "10rem",
  overflowY: "auto",
  color: color.dangerFg,
  background: color.dangerBg,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: radius.md,
  padding: "0.5rem 0.7rem",
};
const removedItemStyle: React.CSSProperties = {
  display: "block",
  lineHeight: 1.7,
};
/** 削除 0 件の明示（安心の一言・muted のまま）。 */
const diffSafeStyle: React.CSSProperties = {
  display: "block",
  marginTop: space.xs,
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
