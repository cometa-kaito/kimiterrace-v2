import { type TenantTx, auditLog } from "@kimiterrace/db";

/**
 * F09 (#45 / #430): 月次レポート PDF **ダウンロード操作の監査記録** (CLAUDE.md ルール1 / NFR04)。
 *
 * 「誰が・いつ・どの校の・どの月次レポート PDF を DL したか」を `audit_log` に 1 行追記する。生徒
 * データを含みうる校別レポートの持ち出しを追跡可能にし、漏洩時に閲覧/取得範囲を立証できるようにする
 * (NFR04 Repudiation)。`prev_hash` / `row_hash` は audit_log の BEFORE INSERT トリガ (0003) が計算する
 * ため空文字で渡す (他の監査記録 helper と同規律)。
 *
 * ## operation = "insert" / table_name = "monthly_report_downloads" (schema 非変更で記録)
 * `audit_op` enum は `insert/update/delete` のみで「read/access」値を持たない。DL は **アクセス記録の
 * 追記** (= access 行の作成) と捉え、論理 subject `monthly_report_downloads` への `insert` として記録する。
 * 物理テーブル `monthly_reports` の変更履歴 (生成/更新) を汚さず、`WHERE table_name='monthly_report_downloads'`
 * で DL 監査だけを取り出せる。`audit_log_set_hash` トリガは `table_name` を自由 text として扱い実テーブル名を
 * 要求しないため、enum / スキーマ変更 (ルール3 chokepoint) は不要。
 *
 * ## actor / school (ルール1)
 * - `actorUserId`: system_admin は `users` 行ではないため **null** (FK は users(id)、auditColumns の
 *   「システム/非 users actor は null」規約)。`audit_log_insert` policy (0002) は system_admin context で
 *   null actor を許可する。テナントロールが将来本経路を通る場合は uid を載せる。
 * - `schoolId`: **対象レポートの校 id** を載せ、どの校のデータが持ち出されたか追跡可能にする。
 *   system_admin context は任意 school_id を許可する (0002 policy)。
 * - `ipAddress` / `userAgent`: リクエストヘッダ由来 (取得不能なら null)。漏洩調査の補助。
 *
 * ## PII 非格納 (ルール4)
 * `diff` には DL の事実 (action / 保存 object path / 対象年月) のみを記録し、PDF 本文・生徒氏名等の PII は
 * 載せない。保存 path は校 id を含むが個人情報ではない (#430 path 規約)。
 */

/** `writeReportDownloadAudit` の入力 (型は呼び出し側が解決した値)。 */
export type ReportDownloadAuditInput = {
  /** DL 操作者。system_admin は users 行でないため uid を載せない (actor=null)。 */
  actor: { uid: string; role: string };
  /** 対象レポート id (= audit の record_id)。 */
  reportId: string;
  /** 対象レポートの校 id (= audit の school_id、追跡用)。 */
  schoolId: string;
  /** 対象年 (西暦)。diff に残す。 */
  targetYear: number;
  /** 対象月 (1-12)。diff に残す。 */
  targetMonth: number;
  /** GCS 保存 object path (PII 非該当)。diff に残す。 */
  objectPath: string;
  /** クライアント IP (取得不能なら null)。 */
  ip: string | null;
  /** User-Agent (取得不能なら null)。 */
  userAgent: string | null;
};

/** DL 監査記録に使う論理 subject。`audit_op` enum を変えずに DL を表す (上記参照)。 */
export const REPORT_DOWNLOAD_AUDIT_TABLE = "monthly_report_downloads";

/**
 * 月次レポート PDF の DL を `audit_log` に 1 行追記する。RLS context (system_admin) を張った tx 内で呼ぶ。
 * トリガが hash chain を計算するため `rowHash` は空文字で渡す。
 */
export async function writeReportDownloadAudit(
  tx: TenantTx,
  input: ReportDownloadAuditInput,
): Promise<void> {
  const isSystemAdmin = input.actor.role === "system_admin";
  // system_admin は users 行でないため actor / created_by / updated_by は null (FK は users(id))。
  const actorUserId = isSystemAdmin ? null : input.actor.uid;
  await tx.insert(auditLog).values({
    actorUserId,
    schoolId: input.schoolId,
    tableName: REPORT_DOWNLOAD_AUDIT_TABLE,
    recordId: input.reportId,
    operation: "insert",
    diff: {
      action: "download",
      objectPath: input.objectPath,
      targetYear: input.targetYear,
      targetMonth: input.targetMonth,
    },
    ipAddress: input.ip,
    userAgent: input.userAgent,
    rowHash: "",
    createdBy: actorUserId,
    updatedBy: actorUserId,
  });
}
