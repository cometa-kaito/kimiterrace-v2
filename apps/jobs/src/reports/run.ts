import {
  type AdReachByAd,
  type MonthlySchoolSummary,
  type WithTenantContextOptions,
  createDbClient,
  getMonthlyAdReach,
  getMonthlySchoolSummary,
  listSchools,
  withTenantContext,
} from "@kimiterrace/db";
import { type MonthlyReportPdfData, loadDefaultJpFont, renderMonthlyReportPdf } from "./pdf.js";
import { type ReportPersistPort, createPgReportPersistPort } from "./persist-port.js";
import {
  type ReportStoragePort,
  buildReportObjectPath,
  createGcsReportStorage,
} from "./storage.js";

/**
 * F09 (#45 第2スライス): 月次レポート PDF の全校横断ドライバと実 DB 結線。
 *
 * #429（第1スライス）が用意した純関数 `renderMonthlyReportPdf`（データ → PDF Buffer）に、全校を回す
 * **オーケストレーション**（`renderAllMonthlyReports`、DI で純粋）と、実 PG/フォント結線
 * （`runMonthlyReports`）を与える。embedding バッチ（`embedding/run.ts`）と同じ構成。Cloud Run Job
 * entrypoint（env 読取・終了コード）と配布（GCS 等）は後続スライス。
 *
 * ## テナント分離 (ルール2)
 * 校の列挙は `system_admin` コンテキスト（`listSchools` が全校 SELECT 可、ADR-019 の
 * `system_admin_full_access`）。各校の集計読取は `school_admin` に降格した context で
 * `getMonthlySchoolSummary` / `getMonthlyAdReach` を叩き、自校行だけを RLS で読む。**BYPASSRLS は
 * 使わない**。レポートは校をまたいで合算しない（1 校 1 PDF）ため越境の必要が無い。
 */

/** 1 校 1 か月分のレンダリング結果。 */
export type SchoolMonthlyReport = {
  schoolId: string;
  schoolName: string;
  /** 先頭 `%PDF-` の有効な PDF バイト列。 */
  pdf: Buffer;
  /** 生成時メトリクス即値（履歴 `metrics_snapshot` に保存し過去レポートを後方再現可能にする）。 */
  metrics: { summary: MonthlySchoolSummary; adReach: AdReachByAd[] };
};

/** バッチ全体の結果（対象年月 + 校ごとの PDF）。配布・保存は後続スライスが担う。 */
export type MonthlyReportsResult = {
  year: number;
  month: number;
  schools: number;
  reports: SchoolMonthlyReport[];
};

/** 1 校分の保存・履歴記録の結果（`persistAllMonthlyReports` が校ごとに返す）。 */
export type SchoolReportPersistResult = {
  schoolId: string;
  /** GCS の保存 path（`buildReportObjectPath` の決定論的 path）。 */
  storagePath: string;
  /** 保存した PDF バイト数。 */
  pdfSizeBytes: number;
  /** upsert した monthly_reports 行 id。 */
  reportId: string;
};

/** 保存フェーズ全体の結果（対象年月 + 校ごとの保存 path / 履歴行 id）。 */
export type MonthlyReportsPersistResult = {
  year: number;
  month: number;
  schools: number;
  persisted: SchoolReportPersistResult[];
};

/** `renderAllMonthlyReports` の依存（実 PG / pdfkit をフェイクに差し替えて単体検証する注入点）。 */
export interface RenderAllMonthlyReportsDeps {
  /** 対象年（西暦）。 */
  year: number;
  /** 対象月（1-12）。 */
  month: number;
  /** 処理対象の校（id + 校名）を列挙する（実体は system_admin context の `listSchools`）。 */
  listSchools(): Promise<{ id: string; name: string }[]>;
  /** 1 校分の集計を読む（実体は school_admin 降格 context の月次サマリ + 広告到達）。 */
  loadReportData(
    schoolId: string,
  ): Promise<{ summary: MonthlySchoolSummary; adReach: AdReachByAd[] }>;
  /** PDF を描画する（実体は同梱フォントを注入した `renderMonthlyReportPdf`）。 */
  renderPdf(data: MonthlyReportPdfData): Promise<Buffer>;
}

/**
 * 全校を順に処理し、校ごとの月次レポート PDF を生成する（純粋オーケストレーション、DB/pdfkit は注入）。
 *
 * 1 校でも失敗すると例外を伝播させる（fail-fast、`embedding/run.ts` の `embedAllSchools` と同方針）。
 * 月次レポートは再実行で全校を再生成できる（副作用は呼出側の配布スライスが持つ）ため、校単位の
 * エラー分離は follow-up。
 */
export async function renderAllMonthlyReports(
  deps: RenderAllMonthlyReportsDeps,
): Promise<MonthlyReportsResult> {
  const schools = await deps.listSchools();
  const reports: SchoolMonthlyReport[] = [];
  for (const school of schools) {
    const { summary, adReach } = await deps.loadReportData(school.id);
    const pdf = await deps.renderPdf({ schoolName: school.name, summary, adReach });
    reports.push({
      schoolId: school.id,
      schoolName: school.name,
      pdf,
      metrics: { summary, adReach },
    });
  }
  return { year: deps.year, month: deps.month, schools: schools.length, reports };
}

/** `persistAllMonthlyReports` の依存（実 GCS / 実 PG をフェイクに差し替えて単体検証する注入点）。 */
export interface PersistAllMonthlyReportsDeps {
  /** 対象年（西暦）。 */
  year: number;
  /** 対象月（1-12）。 */
  month: number;
  /** 生成済の校別レポート（PDF + メトリクス）。 */
  reports: SchoolMonthlyReport[];
  /** PDF を保存先へ書き込む（実体は `createGcsReportStorage`）。 */
  storage: ReportStoragePort;
  /** 校ごとの履歴書き込みポートを作る（実体は school_admin 降格 context の `createPgReportPersistPort`）。 */
  makePersistPort(schoolId: string): ReportPersistPort;
}

/**
 * 生成済の校別 PDF を順に **GCS 保存 → `monthly_reports` 履歴 upsert** する（純粋オーケストレーション、
 * GCS/DB は注入）。
 *
 * **保存 → INSERT の順を守る**: `pdf_storage_path` は NOT NULL なので、保存先 path が確定する前に履歴行は
 * 作れない。1 校ずつ「決定論的 path を作る → storage.save → その path で履歴 upsert」を行う。保存と履歴は
 * 冪等（同 path 上書き + `(school, year, month)` upsert）なので、1 校で失敗しても再実行で回収できる
 * （校単位のエラー分離は follow-up、`renderAllMonthlyReports` と同じ fail-fast）。
 */
export async function persistAllMonthlyReports(
  deps: PersistAllMonthlyReportsDeps,
): Promise<MonthlyReportsPersistResult> {
  const persisted: SchoolReportPersistResult[] = [];
  for (const report of deps.reports) {
    const storagePath = buildReportObjectPath(report.schoolId, deps.year, deps.month);
    // 保存を先に行う: 履歴は保存 path を NOT NULL で要求するため、保存成功後にのみ履歴を記録する。
    await deps.storage.save(storagePath, report.pdf);
    const port = deps.makePersistPort(report.schoolId);
    const { id } = await port.record({
      schoolId: report.schoolId,
      year: deps.year,
      month: deps.month,
      storagePath,
      pdfSizeBytes: report.pdf.length,
      metricsSnapshot: report.metrics,
    });
    persisted.push({
      schoolId: report.schoolId,
      storagePath,
      pdfSizeBytes: report.pdf.length,
      reportId: id,
    });
  }
  return {
    year: deps.year,
    month: deps.month,
    schools: deps.reports.length,
    persisted,
  };
}

export type RunMonthlyReportsConfig = {
  /** DB 接続文字列（kimiterrace_app ロール。Secret Manager 経由で注入、ルール5）。 */
  databaseUrl: string;
  /** 対象年（西暦、例 2026）。 */
  year: number;
  /** 対象月（1-12）。範囲外は集計クエリが `RangeError`。 */
  month: number;
  /** PDF 保存先 Cloud Storage バケット名（env `REPORT_BUCKET` 由来、ハードコード禁止・ルール5）。 */
  bucket: string;
  /** テスト用: BYPASSRLS 接続をアプリロールへ降格する SET LOCAL ROLE 先。本番は未指定。 */
  appRole?: string;
};

/** `runMonthlyReports` の戻り値（生成結果 + 保存/履歴結果）。 */
export type RunMonthlyReportsResult = {
  generated: MonthlyReportsResult;
  persisted: MonthlyReportsPersistResult;
};

/**
 * 実 PG + 同梱フォント + Cloud Storage で全校の月次レポートを生成し、GCS へ保存して `monthly_reports` に
 * 履歴を記録する。接続は本関数が開き、終了時に必ず閉じる。env 読取・プロセス終了コードは
 * entrypoint（`report-job.ts`）が担う。配布（メール/DL 導線）と Terraform/lifecycle は後続スライス。
 */
export async function runMonthlyReports(
  config: RunMonthlyReportsConfig,
): Promise<RunMonthlyReportsResult> {
  // 同梱 Noto Sans JP を 1 度だけ読み、全校のレンダリングで共有する（校ごとの再読込を避ける）。
  // **DB 接続より前に読む**: フォント不在で throw しても DB 接続を開かず、接続リークを避ける
  // （#441 Reviewer Low-1）。バケット名も DB 接続前に検証し、未設定で接続を開かない。
  const font = loadDefaultJpFont();
  const storage = createGcsReportStorage({ bucket: config.bucket });
  const { sql, db } = createDbClient(config.databaseUrl);
  const appRoleOptions: WithTenantContextOptions =
    config.appRole !== undefined ? { appRole: config.appRole } : {};
  const { year, month } = config;
  try {
    const generated = await renderAllMonthlyReports({
      year,
      month,
      // 校列挙は system_admin context（全校 SELECT、ルール2）。BYPASSRLS 不使用。
      listSchools: async () => {
        const schools = await withTenantContext(
          db,
          { role: "system_admin" },
          (tx) => listSchools(tx),
          appRoleOptions,
        );
        return schools.map((s) => ({ id: s.id, name: s.name }));
      },
      // 集計は school_admin 降格 context で自校のみ（RLS が越境拒否、ルール2）。サマリと広告到達を
      // 同一 tx で順に読む。
      loadReportData: (schoolId) =>
        withTenantContext(
          db,
          { schoolId, role: "school_admin" },
          async (tx) => {
            const summary = await getMonthlySchoolSummary(tx, { year, month });
            const adReach = await getMonthlyAdReach(tx, { year, month });
            return { summary, adReach };
          },
          appRoleOptions,
        ),
      renderPdf: (data) => renderMonthlyReportPdf(data, { font }),
    });

    // 生成後に「GCS 保存 → 履歴 upsert」を結線する。履歴書込みは school_admin 降格 context（RLS 尊重、
    // ルール2、BYPASSRLS 不使用）で行う。
    const persisted = await persistAllMonthlyReports({
      year,
      month,
      reports: generated.reports,
      storage,
      makePersistPort: (schoolId) =>
        createPgReportPersistPort({ db, schoolId, appRole: config.appRole }),
    });

    return { generated, persisted };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
