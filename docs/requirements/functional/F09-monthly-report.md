# F09: 月次レポート (PDF, 手動配布)

- 状態: 部分実装（学校別サマリー画面 + CSV DL + 広告別到達数 + PDF レンダラ単体は実装済。Cloud Run Job / Cloud Storage 保存 / 広告主アカウント別レポート / system_admin DL / 生成履歴 INSERT は未実装）（[#308](https://github.com/cometa-kaito/kimiterrace-v2/pull/308)/[#313](https://github.com/cometa-kaito/kimiterrace-v2/pull/313)/[#337](https://github.com/cometa-kaito/kimiterrace-v2/pull/337)/[#350](https://github.com/cometa-kaito/kimiterrace-v2/pull/350)/[#429](https://github.com/cometa-kaito/kimiterrace-v2/pull/429)）
- 関連 ADR: ADR-002 (Cloud Run, Jobs 含む), [ADR-025 (impression/到達数セマンティクス)](../../adr/025-impression-reach-counting-semantics.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#45](https://github.com/cometa-kaito/kimiterrace-v2/issues/45)

## 概要

学校別・広告主別の月次活動サマリーを PDF 出力し、system_admin が対面 / メールで配布する。**自動配信パイプラインは MVP では作らない**。

## ユーザーストーリー

- **システム管理者として**、毎月の広告主訪問前にレポート PDF をダウンロードしたい。**なぜなら**広告主とのコミュニケーションは対面が前提で、自動配信は不要だから。

## 受け入れ条件

- [~] Cloud Run Job (バッチ) で月初に PDF 生成 — 部分実装（[#429](https://github.com/cometa-kaito/kimiterrace-v2/pull/429)、[#441](https://github.com/cometa-kaito/kimiterrace-v2/pull/441)、[#449](https://github.com/cometa-kaito/kimiterrace-v2/pull/449)、[#465](https://github.com/cometa-kaito/kimiterrace-v2/pull/465)、`apps/jobs/src/reports/report-job.ts`（Job entrypoint）／`run.ts`（`renderAllMonthlyReports` 全校列挙ドライバ + PDF 生成 → GCS 保存 → 履歴 INSERT のオーケストレーション）：レンダラ `renderMonthlyReportPdf` を Job から全校に対し実行）残: 「月初」実行の Cloud Scheduler トリガ（Terraform）が未配線で、Job は手動/テスト経路でのみ起動
- [x] 学校別レポート: 教員向け、サイネージ全体の活動サマリー — 実装済（[#308](https://github.com/cometa-kaito/kimiterrace-v2/pull/308)、[#350](https://github.com/cometa-kaito/kimiterrace-v2/pull/350)、`apps/web/app/admin/reports/page.tsx`、`packages/db/src/queries/monthly-report.ts`：JST 暦月で view/tap/ask/稼働日数/ランキング/広告別到達数）
- [~] 広告主別レポート: その広告主の広告だけの到達・タップ・Q&A 件数 — 部分実装（[#337](https://github.com/cometa-kaito/kimiterrace-v2/pull/337)、[#350](https://github.com/cometa-kaito/kimiterrace-v2/pull/350)、`packages/db/src/queries/ad-reach.ts`：`getMonthlyAdReach` は広告 caption 単位の reach）残: 広告主アカウント単位の集約レポート（advertiser リンク・タップ/Q&A 列）は未実装
- [~] system_admin UI からダウンロード可能 — 部分実装（[#313](https://github.com/cometa-kaito/kimiterrace-v2/pull/313)、[#359](https://github.com/cometa-kaito/kimiterrace-v2/pull/359)、`apps/web/app/api/reports/monthly/route.ts`：CSV DL）残: ダウンロードは publisher（school_admin/teacher）向け CSV で、system_admin 向け cross-tenant DL・PDF DL は未実装
- [x] PDF 生成履歴は monthly_reports テーブルで管理 — 実装済（[#271](https://github.com/cometa-kaito/kimiterrace-v2/pull/271)、[#465](https://github.com/cometa-kaito/kimiterrace-v2/pull/465)、`packages/db/src/schema/monthly-reports.ts`（テーブル定義 + RLS）／`packages/db/src/queries/monthly-reports-write.ts`（`insertMonthlyReport` の冪等 upsert）／`apps/jobs/src/reports/persist-port.ts`：Job が全校の PDF 生成後に monthly_reports へ生成履歴を INSERT/更新する経路を配線）
- [x] PDF テンプレートは pdfkit または React PDF — 実装済（[#429](https://github.com/cometa-kaito/kimiterrace-v2/pull/429)、`apps/jobs/src/reports/pdf.ts`：`renderMonthlyReportPdf` = pdfkit + Noto Sans JP 埋め込み、A4 版面）
- [~] 生成済 PDF は Cloud Storage に保存（90 日後にコールド移送）— 部分実装（[#465](https://github.com/cometa-kaito/kimiterrace-v2/pull/465)、[#467](https://github.com/cometa-kaito/kimiterrace-v2/pull/467)、`apps/jobs/src/reports/storage.ts`（`createGcsReportStorage` で `application/pdf` を GCS へアップロード）／`infrastructure/terraform/modules/report_storage/main.tf`（バケット + age ベースの COLDLINE lifecycle）：アップロードコードと Terraform モジュールは実装済）残: prod の `report_storage` モジュールが `enabled = false`（`infrastructure/terraform/envs/prod/main.tf`）でバケット未プロビジョニング。Phase 開発で enable + Job runtime SA / `REPORT_BUCKET` 配線が必要（ルール8 IaC 化済・適用は未）

## 関連

- 前段: [F07](F07-event-logging.md), [F08](F08-effect-dashboard.md), [F10 (CRM)](F10-crm.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR07](../non-functional/NFR07-compliance.md)
- テスト: `__tests__/jobs/monthly-report/`
