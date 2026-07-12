import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { fiscalYearWindow } from "@/lib/editor/calendar-import-core";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { FILE_IMPORT_UID_PREFIX, getCalendarEvents } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { CalendarImportClient } from "./_components/CalendarImportClient";
import {
  type RegisteredEventRow,
  RegisteredEventsSection,
} from "./_components/RegisteredEventsSection";

const { color, fontSize, space } = tokens;

/**
 * 年間行事予定表ページ（ADR-049 PR-C 起点・**school 単位**・classId なし）。教員 FB（2026-07 実運用）を
 * 受けて「取込専用ページ」から**管理画面**へ再構成: 先頭に今年度の登録済み行事を月ごとに一覧表示し、
 * その下に既存のファイル取込フロー（アップロード → AI → プレビュー → 置き換え保存）を置く。
 *
 * 認可 = 教員 + school_admin（`EDITOR_ROLES`・ADR-049 決定「権限 = 教員 + 学校管理者」。エディタと同じ
 * ロールゲート）。system_admin はテナント文脈が無く対象外（`/forbidden`。代行が要件化したら ADR-041 の
 * schoolId override パターンで追補する）。実データの越境は RLS が止める（ルール2 多層防御）。
 *
 * サーバ側では今年度窓の行事一覧（登録済みセクション用）と「前回のファイル取込」概況を読み、
 * 取込フロー本体（ファイル → AI 構造化 → プレビュー → 置き換え保存）は client island に委ねる。
 * 保存成功時は client が router.refresh() するので本一覧も最新化される。
 */
export default async function CalendarImportPage() {
  const user = await requireRole(EDITOR_ROLES);
  // EDITOR_ROLES はテナント claim を持つので schoolId は実運用では非 null。万一 null（claim 欠落）の
  // 場合は読み自体をスキップする（#1270 L2: 空文字を getCalendarEvents の uuid 比較に渡すと
  // 22P02 で 500 になるため。取込フロー本体は Server Action 側の toEditorActor が forbidden で弾く）。
  const schoolId = user.schoolId;
  const window = fiscalYearWindow(Date.now());
  const rows = schoolId
    ? await withSession((tx) =>
        // 今年度窓の行事（ファイル取込 + iCal 連携の両方）。RLS が自校スコープを強制する（ルール2）。
        getCalendarEvents(tx, schoolId, window.start, window.end),
      )
    : [];

  const events: RegisteredEventRow[] = rows.map((r) => ({
    id: r.id,
    startDate: r.startDate,
    endDate: r.endDate,
    summary: r.summary,
    location: r.location,
    // 境界は schema コメントどおり `source_id IS NULL AND uid LIKE 'file:%'` の二重条件。
    isFileImport: r.sourceId === null && r.uid.startsWith(FILE_IMPORT_UID_PREFIX),
  }));

  // 置き換え対象の可視化（ADR-049 決定 4 の確認 UI 補助）。読みは今年度窓に限るため、過年度に取り込んだ
  // 行事は数に入らない**概算**（置き換え削除自体は `file:` 名前空間全体・replaceFileImportedEvents）。
  const fileRows = rows.filter(
    (r) => r.sourceId === null && r.uid.startsWith(FILE_IMPORT_UID_PREFIX),
  );
  const raw = fileRows[0]?.raw;
  const existingFileName =
    raw !== null &&
    typeof raw === "object" &&
    "fileName" in raw &&
    typeof (raw as { fileName?: unknown }).fileName === "string"
      ? (raw as { fileName: string }).fileName
      : null;

  return (
    <div style={{ display: "grid", gap: space.md, padding: `${space.md} 0` }}>
      <div>
        <Link href="/app/editor" style={backLinkStyle}>
          ← エディタへ戻る
        </Link>
      </div>
      <header style={{ display: "grid", gap: space.xs }}>
        <h1 style={titleStyle}>年間行事予定表</h1>
        <p style={leadStyle}>
          学校の年間行事カレンダーを確認・取込できます。年間行事予定表ファイルを AI
          で読み取って登録でき、読み取り結果は保存前に必ず確認・修正できます。
        </p>
      </header>
      <RegisteredEventsSection events={events} window={window} />
      <section
        style={{ display: "grid", gap: space.sm }}
        aria-labelledby="calendar-import-flow-heading"
      >
        <h2 id="calendar-import-flow-heading" style={importHeadingStyle}>
          ファイルから取り込む
        </h2>
        <CalendarImportClient existingCount={fileRows.length} existingFileName={existingFileName} />
      </section>
    </div>
  );
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.xl,
  fontWeight: 700,
  color: color.ink,
};
const leadStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.muted,
};
const importHeadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.lg,
  fontWeight: 700,
  color: color.ink,
};
const backLinkStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.blueStrong,
  textDecoration: "none",
};
