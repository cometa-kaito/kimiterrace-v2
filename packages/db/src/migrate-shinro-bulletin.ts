/**
 * PR-E（設計書 `docs/design/editor-restructure-bulletin-2026-07.md` §8）: 岐阜工業「進路指導室前」モニタを
 * 掲示板型 pattern5 へ移行する一括データ変換の **純ロジック（副作用なし・DB 非依存）**。
 * 実投入（DB 接続・tx・RLS context・dry-run/apply・バックアップ）は {@link ./migrate-shinro-bulletin-cli.ts}。
 *
 * ## 変換仕様（§8.1）
 * | 現状（教員のハック運用） | 移行先 |
 * |---|---|
 * | `daily_data.schedules` の subject が全てダッシュ類の行 | 区切り線 `{ kind:"divider", subject:"" }` |
 * | `student_callouts` の「------ 校訓 ------」（ダッシュ包み見出し） | お知らせ区切り線 `{ kind:"divider", text:<label>, pinned:true }` |
 * | `student_callouts` の校訓本文（明示選択したID） | お知らせ固定行 `{ text, pinned:true }` |
 * | 実在の呼び出し（氏名を含む行） | 移行しない（pattern5 に呼び出し枠なし。残置＝pattern5 では非表示） |
 *
 * ## 安全設計（CLAUDE.md ルール4=PII）
 * `student_callouts` の表示テキストは **単一列 `student_name`（varchar100）** に入り、校訓本文と生徒実名が同居する。
 * 内容から「校訓本文 vs 氏名」を自動判別すると誤って実名を固定掲示しかねないため、**自動変換はダッシュ包みの
 * 区切り線のみ**（決定論的に検知可能）。校訓本文の固定化は **運用者が dry-run を見て `--pin-callout-ids` で
 * 明示選択した行だけ**を対象にする（推測で pin しない）。未選択の text 行は残置し削除もしない。
 *
 * ## 冪等性
 * ダッシュ行は再実行時に既に divider 化済み→変換対象ゼロ。校訓 callout は初回で削除済み→対象ゼロ。
 * 固定お知らせは同一 signature（`divider:<label>` / `text:<本文>`）が既存 notices にあれば追記しない。→ 収束。
 */

/** 区切り線ラベルの最大長。apps/web の `DIVIDER_LABEL_MAX`（schedule-core.ts:308）と一致させる（packages/db は
 * apps/web に依存できないため定数を複製。ズレると validate で truncate/reject される）。 */
export const DIVIDER_LABEL_MAX = 32;

/** 固定お知らせ本文の最大長。apps/web の `NOTICE_TEXT_MAX`（notice-assignment-core.ts）と一致（callout は 100 だが念のため）。 */
export const NOTICE_TEXT_MAX = 500;

/** 設計書 §8 が対象と定める「進路指導室前」クラス（照合用の既定 expect-class。実対象は端末トークン解決を優先）。 */
export const SHINRO_EXPECTED_CLASS_ID = "7a18ca87-4bcf-4fa7-bb21-bd2cb8231df3";

/** 既知のサイネージデザインパターン（design-pattern.ts の union を複製。端末の現行 `?design=` 判定に使う）。 */
export const KNOWN_DESIGN_PATTERNS = [
  "pattern1",
  "pattern2",
  "pattern3",
  "pattern4",
  "pattern5",
  "pattern6",
] as const;

/**
 * ダッシュ/スペーサ類（§8.1 の正規表現 `/^[-‐−–—ー―_＿=＝\s]+$/` と同一文字クラス）。
 * 半角/全角ハイフン・各種ダッシュ・長音符・アンダースコア・イコールと空白。
 */
const DASH_ONLY_RE = /^[-‐−–—ー―_＿=＝\s]+$/u;
/** 単一文字がダッシュ類か（空白は含めない＝ラベル包みの端が「ダッシュ」であることの判定用）。 */
const DASH_CHAR_RE = /[-‐−–—ー―_＿=＝]/u;
/** 先頭/末尾の連続ダッシュ+空白ラン（ラベル抽出用）。 */
const LEAD_DASH_RUN_RE = /^[-‐−–—ー―_＿=＝\s]+/u;
const TRAIL_DASH_RUN_RE = /[-‐−–—ー―_＿=＝\s]+$/u;

/** 連絡（notices）1 要素の validate 済み想定形（apps/web の NoticeItem を複製）。 */
export type NoticeItem = {
  kind?: "divider";
  text: string;
  isHighlight?: boolean;
  displayDays?: number;
  pinned?: boolean;
};

/** 予定の区切り線行（apps/web の validate が保持する 2 キーのみ）。 */
export type ScheduleDividerRow = { kind: "divider"; subject: string };

/** student_callouts の 1 行（変換に必要な列のみ）。 */
export type CalloutRow = {
  id: string;
  calloutDate: string;
  studentName: string;
  sortOrder: number;
};

/** 対象クラスの 1 日分 daily_data（schedules 列のみ変換対象）。 */
export type DailyScheduleRow = { rowId: string; date: string; schedules: unknown };

/** callout テキストの分類。divider（自動変換）/ text（要明示選択）/ empty（無視）。 */
export type CalloutClass =
  | { kind: "divider"; label: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

/** opaque JSONB 要素が既に区切り線行か（apps/web の isDividerRecord と同判定・defensive narrow）。 */
export function isDividerRecord(item: unknown): boolean {
  return (
    typeof item === "object" && item !== null && (item as { kind?: unknown }).kind === "divider"
  );
}

/** 文字列が全てダッシュ/スペーサ類か（§8.1）。 */
export function isDashOnly(s: string): boolean {
  return DASH_ONLY_RE.test(s);
}

/**
 * callout の表示テキスト（student_name）を分類する。
 * - 全ダッシュ → `divider`（ラベル空。純粋な罫線）
 * - 前後がダッシュ包み（「------ 校訓 ------」）→ `divider`（内側をラベルに）
 * - それ以外（氏名 or 校訓本文）→ `text`（**自動では pin しない**＝要明示選択）
 * - 空 → `empty`
 */
export function classifyCalloutText(raw: string): CalloutClass {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  if (isDashOnly(trimmed)) {
    return { kind: "divider", label: "" };
  }
  const firstIsDash = DASH_CHAR_RE.test(trimmed[0] ?? "");
  const lastIsDash = DASH_CHAR_RE.test(trimmed[trimmed.length - 1] ?? "");
  if (firstIsDash && lastIsDash) {
    const label = trimmed.replace(LEAD_DASH_RUN_RE, "").replace(TRAIL_DASH_RUN_RE, "").trim();
    return { kind: "divider", label: label.slice(0, DIVIDER_LABEL_MAX) };
  }
  return { kind: "text", text: trimmed };
}

/**
 * dry-run 表示用の PII セーフなヒント。**text 行の生内容は出さない**（実名の恐れ・ログに残さない）。
 * divider ラベルは運用者が「校訓」を確認するために表示する。氏名は通常ダッシュで囲まれないため実名がラベルに
 * 出ることはまず無いが、両端がダッシュ類の稀な入力は理論上ラベルに乗りうる（＝必ず dry-run で人間が確認する）。
 */
export function calloutHint(studentName: string, selected: boolean): string {
  const cls = classifyCalloutText(studentName);
  const len = studentName.trim().length;
  if (cls.kind === "empty") {
    return "empty(skip)";
  }
  if (cls.kind === "divider") {
    return `divider label=${JSON.stringify(cls.label)} → お知らせ区切り線(pinned)・削除`;
  }
  return selected
    ? `text len=${len} → 固定お知らせ(pinned)・削除【--pin-callout-ids で選択済】`
    : `text len=${len} → 未分類（移行しない・残置）※校訓本文なら --pin-callout-ids に ID を追加`;
}

/**
 * URL の `/signage/<token>` からトークンを取り出す（端末→クラス解決の入口）。相対・不正・非該当は null。
 */
export function extractSignageToken(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  const idx = parts.indexOf("signage");
  if (idx === -1 || idx + 1 >= parts.length) {
    return null;
  }
  const token = parts[idx + 1];
  if (!token) {
    return null;
  }
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

/** signage_url の `?design=` を取り出す（生値。未指定・パース不能は null＝呼出側が pattern1 に倒す）。 */
export function extractDesignParam(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.searchParams.get("design");
}

/** `?design=` の実効パターン（未指定・未知は既定 pattern1）。 */
export function effectiveDesignPattern(url: string | null | undefined): string {
  const raw = extractDesignParam(url);
  return raw && (KNOWN_DESIGN_PATTERNS as readonly string[]).includes(raw) ? raw : "pattern1";
}

/**
 * daily_data.schedules（JSONB 配列）の「subject が全ダッシュ」の行を区切り線 `{kind:"divider",subject:""}` に
 * 置換する。既に divider の行・非ダッシュ行は不変（位置保持＝冪等）。配列でなければ変換なし。
 */
export function convertScheduleDashRows(rawSchedules: unknown): {
  next: unknown[];
  convertedCount: number;
  skippedNonArray: boolean;
} {
  if (!Array.isArray(rawSchedules)) {
    return { next: [], convertedCount: 0, skippedNonArray: true };
  }
  let convertedCount = 0;
  const next = rawSchedules.map((row) => {
    if (isDividerRecord(row)) {
      return row; // 既に divider（冪等）
    }
    if (row && typeof row === "object") {
      const subject = (row as { subject?: unknown }).subject;
      if (typeof subject === "string" && subject.trim() !== "" && isDashOnly(subject.trim())) {
        convertedCount++;
        const divider: ScheduleDividerRow = { kind: "divider", subject: "" };
        return divider;
      }
    }
    return row;
  });
  return { next, convertedCount, skippedNonArray: false };
}

/**
 * callout 群から固定お知らせ（pinned）アイテム列を構築する。
 * - divider 行（自動検知）→ `{ kind:"divider", text:<label>, pinned:true }`
 * - `selectedBodyIds` に含まれる text 行 → `{ text, pinned:true }`
 * - それ以外の text 行 → 未分類（移行しない・残置）
 * 並びは sortOrder→calloutDate→id の安定順。同一 signature は 1 度だけ（複数日に同じ校訓が入っていても 1 件に集約）。
 */
export function buildBulletinNoticesFromCallouts(
  callouts: readonly CalloutRow[],
  selectedBodyIds: readonly string[],
): {
  items: NoticeItem[];
  dividerCalloutIds: string[];
  bodyCalloutIds: string[];
  unclassifiedCalloutIds: string[];
} {
  const selected = new Set(selectedBodyIds);
  const ordered = [...callouts].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      (a.calloutDate < b.calloutDate ? -1 : a.calloutDate > b.calloutDate ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const items: NoticeItem[] = [];
  const dividerCalloutIds: string[] = [];
  const bodyCalloutIds: string[] = [];
  const unclassifiedCalloutIds: string[] = [];
  const seen = new Set<string>();
  for (const c of ordered) {
    const cls = classifyCalloutText(c.studentName);
    if (cls.kind === "empty") {
      unclassifiedCalloutIds.push(c.id);
      continue;
    }
    if (cls.kind === "divider") {
      dividerCalloutIds.push(c.id);
      const sig = `divider:${cls.label}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        items.push({ kind: "divider", text: cls.label, pinned: true });
      }
      continue;
    }
    // text 行: 明示選択された ID のみ pin。未選択は残置。
    if (selected.has(c.id)) {
      bodyCalloutIds.push(c.id);
      const text = cls.text.slice(0, NOTICE_TEXT_MAX);
      const sig = `text:${text}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        items.push({ text, pinned: true });
      }
    } else {
      unclassifiedCalloutIds.push(c.id);
    }
  }
  return { items, dividerCalloutIds, bodyCalloutIds, unclassifiedCalloutIds };
}

/** notices 要素の重複判定シグネチャ（divider はラベル、通常は本文で同一視）。 */
function noticeSignature(n: unknown): string | null {
  if (!n || typeof n !== "object") {
    return null;
  }
  const o = n as NoticeItem;
  if (o.kind === "divider") {
    return `divider:${typeof o.text === "string" ? o.text.trim() : ""}`;
  }
  return typeof o.text === "string" ? `text:${o.text.trim()}` : null;
}

/**
 * 既存 notices（アンカー日）へ固定お知らせを追記する。同一 signature が既にあれば追記しない（冪等）。
 * 既存行は温存（置換ではなく末尾追記）。
 */
export function mergePinnedNotices(
  existing: unknown,
  additions: readonly NoticeItem[],
): { next: unknown[]; addedCount: number } {
  const base = Array.isArray(existing) ? [...existing] : [];
  const present = new Set<string>();
  for (const n of base) {
    const s = noticeSignature(n);
    if (s) {
      present.add(s);
    }
  }
  let addedCount = 0;
  for (const a of additions) {
    const s = noticeSignature(a);
    if (s && present.has(s)) {
      continue;
    }
    base.push(a);
    if (s) {
      present.add(s);
    }
    addedCount++;
  }
  return { next: base, addedCount };
}

/** 変換計画（純データ）。CLI はこれを表示（dry-run）／実行（apply）する。 */
export type BulletinPlan = {
  scheduleConversions: Array<{
    rowId: string;
    date: string;
    convertedCount: number;
    next: unknown[];
  }>;
  totalScheduleDividers: number;
  pinnedNotices: NoticeItem[];
  anchorDate: string | null;
  deleteCalloutIds: string[];
  dividerCalloutIds: string[];
  bodyCalloutIds: string[];
  unclassifiedCalloutIds: string[];
};

/**
 * 対象クラスの scan 結果（daily_data 群 + callout 群）から変換計画を組む純関数。
 * アンカー日（固定お知らせを載せる日）は既定で変換対象 callout の最古 calloutDate。無ければ `anchorDateFallback`。
 */
export function planBulletinMigration(input: {
  dailyRows: readonly DailyScheduleRow[];
  callouts: readonly CalloutRow[];
  selectedBodyIds: readonly string[];
  anchorDateOverride?: string;
  anchorDateFallback: string;
}): BulletinPlan {
  const scheduleConversions: BulletinPlan["scheduleConversions"] = [];
  let totalScheduleDividers = 0;
  for (const row of input.dailyRows) {
    const { next, convertedCount } = convertScheduleDashRows(row.schedules);
    if (convertedCount > 0) {
      scheduleConversions.push({ rowId: row.rowId, date: row.date, convertedCount, next });
      totalScheduleDividers += convertedCount;
    }
  }
  const { items, dividerCalloutIds, bodyCalloutIds, unclassifiedCalloutIds } =
    buildBulletinNoticesFromCallouts(input.callouts, input.selectedBodyIds);

  const deleteCalloutIds = [...dividerCalloutIds, ...bodyCalloutIds];
  // アンカー日: 変換対象 callout の最古 calloutDate（決定論）。override 優先、無ければ fallback。
  let anchorDate: string | null = null;
  if (items.length > 0) {
    if (input.anchorDateOverride) {
      anchorDate = input.anchorDateOverride;
    } else {
      const deleteSet = new Set(deleteCalloutIds);
      const dates = input.callouts
        .filter((c) => deleteSet.has(c.id))
        .map((c) => c.calloutDate)
        .sort();
      anchorDate = dates[0] ?? input.anchorDateFallback;
    }
  }
  return {
    scheduleConversions,
    totalScheduleDividers,
    pinnedNotices: items,
    anchorDate,
    deleteCalloutIds,
    dividerCalloutIds,
    bodyCalloutIds,
    unclassifiedCalloutIds,
  };
}
