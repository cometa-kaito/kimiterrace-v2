# F08: 効果可視化ダッシュボード + AI 効果コメント生成（ボタン起動オンデマンド）

- 状態: 部分実装（ダッシュボード/集計/cross-tenant/在室人感の時間帯・日次表示は完成。AI 効果コメントはボタン起動オンデマンドで実装（月次自動バッチは追加スコープ Phase2）、人感ヒートマップは時間帯別のみ、チャートは CSS バー SSR で Recharts/Visx 不採用）（[#264](https://github.com/cometa-kaito/kimiterrace-v2/pull/264)/[#276](https://github.com/cometa-kaito/kimiterrace-v2/pull/276)/[#284](https://github.com/cometa-kaito/kimiterrace-v2/pull/284)/[#314](https://github.com/cometa-kaito/kimiterrace-v2/pull/314)/[#315](https://github.com/cometa-kaito/kimiterrace-v2/pull/315)/[#432](https://github.com/cometa-kaito/kimiterrace-v2/pull/432)/[#435](https://github.com/cometa-kaito/kimiterrace-v2/pull/435)）
- 関連 ADR: ADR-005 (Vertex AI), ADR-014 (Observability)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#44](https://github.com/cometa-kaito/kimiterrace-v2/issues/44)

## 概要

学校別・コンテンツ別の閲覧・タップ・滞留・Q&A 件数を可視化。AI が「先週比 30% 増、特に体育祭関連の Q&A が多い」のような自然言語コメントを自動生成。

## ユーザーストーリー

- **校務管理者として**、どのコンテンツが効果的か数値で知りたい。
- **システム管理者として**、広告主向け月次レポートの素材を効率的に集めたい。
- **教員として**、自分が出した連絡がどれだけ見られたかフィードバックを受けたい。

## 受け入れ条件

- [x] ダッシュボード（school_admin / teacher 閲覧、school_id スコープ）— 実装済（[#264](https://github.com/cometa-kaito/kimiterrace-v2/pull/264)、`apps/web/app/admin/dashboard/page.tsx`：requireRole(PUBLISHER_ROLES) + withSession で RLS school スコープ）
- [x] system_admin 用 cross-tenant ビュー — 実装済（[#314](https://github.com/cometa-kaito/kimiterrace-v2/pull/314)、`apps/web/app/admin/system/dashboard/page.tsx`：getEventStatsBySchool で全校横断、system_admin_full_access policy 委譲）
- [x] AI コメントは生成 + PII マスキング適用 — 実装済（[#461](https://github.com/cometa-kaito/kimiterrace-v2/pull/461)、[#462](https://github.com/cometa-kaito/kimiterrace-v2/pull/462)、[#466](https://github.com/cometa-kaito/kimiterrace-v2/pull/466)、`apps/web/lib/dashboard/effect-comment-action.ts`／`apps/web/app/admin/dashboard/_components/EffectCommentPanel.tsx`／`packages/ai/src/model/effect-comment-model.ts`：ダッシュボードからの**ボタン起動オンデマンド生成**を 集計 + PII マスク（ルール4）+ Vertex + 監査 で実装）。**月次自動バッチは追加スコープ（Phase2）**: EffectCommentPanel docstring の通り自動生成は Vertex 過剰課金 + 監査ログノイズになるため **ボタン起動オンデマンドを MVP の正仕様**とする（2026-06-03 #44 AC 突合で確定、旧「要再判断」は解消）
- [x] グラフ: 時系列、コンテンツ別ランキング、Q&A 件数 — 実装済（[#276](https://github.com/cometa-kaito/kimiterrace-v2/pull/276) 日次時系列、[#284](https://github.com/cometa-kaito/kimiterrace-v2/pull/284) ask 件数、[#315](https://github.com/cometa-kaito/kimiterrace-v2/pull/315) 時間帯別、`apps/web/app/admin/dashboard/page.tsx`／`packages/db/src/queries/event-stats.ts`）
- [~] **人感センサー検知の時間帯別ヒートマップ**（5/15 分バケット × 平日/休日、データ源 `events.type='presence'`）。詳細仕様は [F13 §3.2](F13-presence-sensor-webhook.md) を参照 — 部分実装（[#425](https://github.com/cometa-kaito/kimiterrace-v2/pull/425)、[#432](https://github.com/cometa-kaito/kimiterrace-v2/pull/432)、`apps/web/app/admin/dashboard/page.tsx`：JST 時間帯別 0-23 時 + 日次 [#435](https://github.com/cometa-kaito/kimiterrace-v2/pull/435)）残: 仕様の 5/15 分バケット × 平日/休日の細分は未実装
- [x] 「カメラ非使用」バッジを常時表示（[ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) 公開透明性）— 実装済（[#425](https://github.com/cometa-kaito/kimiterrace-v2/pull/425)、`apps/web/app/admin/dashboard/page.tsx`：「カメラ不使用」常時表示 + title ツールチップ。system dashboard も同様）
- [x] 旧 LiDAR 由来の「滞留時間ヒートマップ」は **採用しない**。PIR 方式は瞬間検知のため滞留秒数は計測できない（[ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) トレードオフ参照）— 実装済（dwell 滞留ヒートマップは未実装かつ dwell 書込みハンドラ不在・集計も dwell 除外。在室は presence で代替表示 = 仕様の「採用しない」を満たす）
- [~] グラフは Recharts または Visx を採用（React Server Component で SSR 描画）— 部分実装（[#264](https://github.com/cometa-kaito/kimiterrace-v2/pull/264)、`apps/web/app/admin/dashboard/page.tsx`）残: **意図的に** Recharts/Visx を不採用とし、CSS バーの軽量 SSR で描画（依存追加回避）。RSC SSR 要件は満たすがチャートライブラリは未導入（仕様文を「CSS バー軽量 SSR 採用」に改める選択肢あり）
- [x] WCAG 2.2 AA（[NFR05](../non-functional/NFR05-accessibility.md)）に従い、色だけに依存しない凡例 — 実装済（[#264](https://github.com/cometa-kaito/kimiterrace-v2/pull/264)、`apps/web/app/admin/dashboard/page.tsx`：各バー行に件数テキスト併記、ランキングは th scope の table）

## 関連

- 前段: [F07 (イベントログ)](F07-event-logging.md)
- 後段: [F09 (月次レポート)](F09-monthly-report.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md)（system_admin cross-tenant は RLS 経由）
- テスト: `__tests__/ui/dashboard/`, `__tests__/ai/effect-comment/`
