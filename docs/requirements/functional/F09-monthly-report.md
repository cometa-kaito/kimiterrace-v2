# F09: 月次レポート (PDF, 手動配布)

- 状態: 部分実装（学校別サマリー画面 + CSV DL + 広告別到達数 + PDF レンダラ単体は実装済。Cloud Run Job / Cloud Storage 保存 / 広告主アカウント別レポート / system_admin DL / 生成履歴 INSERT は未実装）（[#308](https://github.com/cometa-kaito/kimiterrace-v2/pull/308)/[#313](https://github.com/cometa-kaito/kimiterrace-v2/pull/313)/[#337](https://github.com/cometa-kaito/kimiterrace-v2/pull/337)/[#350](https://github.com/cometa-kaito/kimiterrace-v2/pull/350)/[#429](https://github.com/cometa-kaito/kimiterrace-v2/pull/429)）
- 関連 ADR: ADR-002 (Cloud Run, Jobs 含む), [ADR-025 (impression/到達数セマンティクス)](../../adr/025-impression-reach-counting-semantics.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#45](https://github.com/cometa-kaito/kimiterrace-v2/issues/45)

## 概要

学校別・広告主別の月次活動サマリーを PDF 出力し、system_admin が対面 / メールで配布する。**自動配信パイプラインは MVP では作らない**。

## ユーザーストーリー

- **システム管理者として**、毎月の広告主訪問前にレポート PDF をダウンロードしたい。**なぜなら**広告主とのコミュニケーションは対面が前提で、自動配信は不要だから。

## 受け入れ条件

- [ ] Cloud Run Job (バッチ) で月初に PDF 生成 — 未実装（PDF レンダラ `renderMonthlyReportPdf` は純関数として実装済 [#429](https://github.com/cometa-kaito/kimiterrace-v2/pull/429) だが、Cloud Run Job entrypoint・月初スケジュール・校列挙ドライバが無く、自テスト以外から呼ばれていない）
- [x] 学校別レポート: 教員向け、サイネージ全体の活動サマリー — 実装済（[#308](https://github.com/cometa-kaito/kimiterrace-v2/pull/308)、[#350](https://github.com/cometa-kaito/kimiterrace-v2/pull/350)、`apps/web/app/admin/reports/page.tsx`、`packages/db/src/queries/monthly-report.ts`：JST 暦月で view/tap/ask/稼働日数/ランキング/広告別到達数）
- [~] 広告主別レポート: その広告主の広告だけの到達・タップ・Q&A 件数 — 部分実装（[#337](https://github.com/cometa-kaito/kimiterrace-v2/pull/337)、[#350](https://github.com/cometa-kaito/kimiterrace-v2/pull/350)、`packages/db/src/queries/ad-reach.ts`：`getMonthlyAdReach` は広告 caption 単位の reach）残: 広告主アカウント単位の集約レポート（advertiser リンク・タップ/Q&A 列）は未実装
- [~] system_admin UI からダウンロード可能 — 部分実装（[#313](https://github.com/cometa-kaito/kimiterrace-v2/pull/313)、[#359](https://github.com/cometa-kaito/kimiterrace-v2/pull/359)、`apps/web/app/api/reports/monthly/route.ts`：CSV DL）残: ダウンロードは publisher（school_admin/teacher）向け CSV で、system_admin 向け cross-tenant DL・PDF DL は未実装
- [~] PDF 生成履歴は monthly_reports テーブルで管理 — 部分実装（[#271](https://github.com/cometa-kaito/kimiterrace-v2/pull/271)、`packages/db/src/schema/monthly-reports.ts`：テーブル定義 + RLS）残: 行を INSERT する生成コードが未実装（生成履歴記録は未配線）
- [x] PDF テンプレートは pdfkit または React PDF — 実装済（[#429](https://github.com/cometa-kaito/kimiterrace-v2/pull/429)、`apps/jobs/src/reports/pdf.ts`：`renderMonthlyReportPdf` = pdfkit + Noto Sans JP 埋め込み、A4 版面）
- [ ] 生成済 PDF は Cloud Storage に保存（90 日後にコールド移送）— 未実装（Cloud Storage アップロード・90 日コールド移送のコードも Terraform バケット定義も無し）

## 関連

- 前段: [F07](F07-event-logging.md), [F08](F08-effect-dashboard.md), [F10 (CRM)](F10-crm.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR07](../non-functional/NFR07-compliance.md)
- テスト: `__tests__/jobs/monthly-report/`
