# F10: CRM（広告主マスタ・契約・コミュニケーション履歴）

- 状態: 部分実装（3 テーブル + 広告主 CRUD 画面 + 契約/コミュニケーションの Server Action・read 層は実装済。契約/コミュニケーションの UI 画面・nav 導線は未実装）（[#270](https://github.com/cometa-kaito/kimiterrace-v2/pull/270)/[#281](https://github.com/cometa-kaito/kimiterrace-v2/pull/281)/[#286](https://github.com/cometa-kaito/kimiterrace-v2/pull/286)/[#307](https://github.com/cometa-kaito/kimiterrace-v2/pull/307)/[#423](https://github.com/cometa-kaito/kimiterrace-v2/pull/423)/[#427](https://github.com/cometa-kaito/kimiterrace-v2/pull/427)/[#428](https://github.com/cometa-kaito/kimiterrace-v2/pull/428)/[#431](https://github.com/cometa-kaito/kimiterrace-v2/pull/431)/[#434](https://github.com/cometa-kaito/kimiterrace-v2/pull/434)）
- 関連 ADR: ADR-018 (CRM 独自設計, 起票予定), [ADR-019 (RLS 二層)](../../adr/019-rls-two-layer-tenant-isolation.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#46](https://github.com/cometa-kaito/kimiterrace-v2/issues/46)

## 概要

広告主はシステム外だが、社内管理用に CRM 機能を持つ。広告主マスタ、契約期間・金額、訪問記録・メールやり取りの履歴を一元管理する。

## ユーザーストーリー

- **システム管理者として**、広告主への月次レポート配布前に契約状況・直近の会話を素早く確認したい。**なぜなら**専用 CRM (HubSpot 等) を別契約せず、本システム内で完結したいから。

## 受け入れ条件

- [~] advertisers テーブル: 会社名、担当者、連絡先、ステータス（見込/契約中/休止）、業種 — 部分実装（[#270](https://github.com/cometa-kaito/kimiterrace-v2/pull/270)、`packages/db/src/schema/advertisers.ts`、UI: list/new/edit/toggle）残: ステータスは見込/契約中/休止の 3 値でなく `is_active` boolean（論理削除）のみ。仕様文の 3 状態を実装に合わせるか要判断
- [~] contracts テーブル: 広告主 × 学校 × 期間 × 金額 × 出稿コンテンツ — 部分実装（[#423](https://github.com/cometa-kaito/kimiterrace-v2/pull/423)、[#428](https://github.com/cometa-kaito/kimiterrace-v2/pull/428)、[#434](https://github.com/cometa-kaito/kimiterrace-v2/pull/434)、[#442](https://github.com/cometa-kaito/kimiterrace-v2/pull/442)、[#447](https://github.com/cometa-kaito/kimiterrace-v2/pull/447)、[#450](https://github.com/cometa-kaito/kimiterrace-v2/pull/450)、`packages/db/src/schema/contracts.ts`、`apps/web/lib/system-admin/contracts-actions.ts`、`apps/web/app/admin/system/advertisers/[id]/contracts/page.tsx`：create/ステータス遷移 guard/編集 Server Action + 検証 + 読取層 + UI（広告主詳細配下の一覧/新規登録/状態遷移ボタン）を実装）残: 「出稿コンテンツ」紐付け列が contracts スキーマに未実装（現状は 広告主(advertiser_id) × 学校(target_schools jsonb) × 期間(started_at/ended_at) × 金額(monthly_fee_jpy) まで）。⚠ 要再判断: 出稿コンテンツを契約に紐付けるか（仕様文 or スキーマ側を合わせる）
- [~] communications テーブル: 訪問記録、メール内容（手動入力 or 貼付け）、添付ファイル — 部分実装（[#427](https://github.com/cometa-kaito/kimiterrace-v2/pull/427)、[#431](https://github.com/cometa-kaito/kimiterrace-v2/pull/431)、[#458](https://github.com/cometa-kaito/kimiterrace-v2/pull/458)、`packages/db/src/schema/communications.ts`、`apps/web/lib/system-admin/communications-actions.ts`、`apps/web/lib/system-admin/communications-queries.ts`、`apps/web/app/admin/system/advertisers/[id]/communications/page.tsx`：create Action + read 層 + 履歴 UI（一覧/新規登録）を実装。`attachments_json` 列は Cloud Storage object 参照配列として定義済）残: 添付ファイルのアップロード UI（GCS への保存導線）と 編集/削除 Action が未実装
- [x] system_admin のみアクセス可（school_admin は閲覧不可）— 実装済（[#270](https://github.com/cometa-kaito/kimiterrace-v2/pull/270)、`apps/web/lib/system-admin/roles.ts`、`packages/db/migrations/0002_rls_policies.sql`：app 層 requireRole(SYSTEM_ADMIN_ROLES) + DB 層 system_admin_full_access policy の二層防御）
- [x] 全データはテナント横断（school_id を持たない）— 実装済（[#270](https://github.com/cometa-kaito/kimiterrace-v2/pull/270)、`packages/db/src/schema/advertisers.ts`／`contracts.ts`／`communications.ts`：3 テーブルとも school_id カラム無しの cross-tenant マスタ）
- [~] CRM テーブルは RLS の対象外（system_admin の application-level チェックで保護）— 部分実装（[#270](https://github.com/cometa-kaito/kimiterrace-v2/pull/270)、`packages/db/migrations/0001_enable_rls.sql`、`0002_rls_policies.sql`）残: 設計が変更され「RLS 対象外」ではなく **RLS 有効 + system_admin_full_access policy** の二層モデル（ADR-019）。保護目的（system_admin 限定）は満たすが手段が条件文と乖離 — 条件文を ADR-019 二層モデルに書き換えるのが望ましい

## 関連

- 後段: [F09 (月次レポート)](F09-monthly-report.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR04](../non-functional/NFR04-audit-log.md)
- テスト: `__tests__/api/crm/`, `__tests__/rls/non-tenant-tables/`
