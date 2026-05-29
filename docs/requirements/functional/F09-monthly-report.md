# F09: 月次レポート (PDF, 手動配布)

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-002 (Cloud Run, Jobs 含む)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

学校別・広告主別の月次活動サマリーを PDF 出力し、system_admin が対面 / メールで配布する。**自動配信パイプラインは MVP では作らない**。

## ユーザーストーリー

- **システム管理者として**、毎月の広告主訪問前にレポート PDF をダウンロードしたい。**なぜなら**広告主とのコミュニケーションは対面が前提で、自動配信は不要だから。

## 受け入れ条件

- [ ] Cloud Run Job (バッチ) で月初に PDF 生成
- [ ] 学校別レポート: 教員向け、サイネージ全体の活動サマリー
- [ ] 広告主別レポート: その広告主の広告だけの到達・タップ・Q&A 件数
- [ ] system_admin UI からダウンロード可能
- [ ] PDF 生成履歴は monthly_reports テーブルで管理
- [ ] PDF テンプレートは pdfkit または React PDF
- [ ] 生成済 PDF は Cloud Storage に保存（90 日後にコールド移送）

## 関連

- 前段: [F07](F07-event-logging.md), [F08](F08-effect-dashboard.md), [F10 (CRM)](F10-crm.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR07](../non-functional/NFR07-compliance.md)
- テスト: `__tests__/jobs/monthly-report/`
