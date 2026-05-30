# ADR-015: 即公開 + 安全網 4 種（承認フロー非採用）

- 状態: Accepted（2026-05-31 実装完了で Proposed → Accepted）
- 日付: 2026-05-28（起草） / 2026-05-31（実装反映）
- 関連: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [F04](../requirements/functional/F04-instant-publish-safety-nets.md), [v2-mvp.md §8](../requirements/v2-mvp.md), [ADR-008 (Server Actions)](008-nextjs-route-handlers.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [NFR04 (監査ログ)](../requirements/non-functional/NFR04-audit-log.md)
- 実装 PR: [#141](https://github.com/cometa-kaito/kimiterrace-v2/pull/141)（ドメインサービス）/ [#148](https://github.com/cometa-kaito/kimiterrace-v2/pull/148)（Server Actions）/ [#156](https://github.com/cometa-kaito/kimiterrace-v2/pull/156)（read 層）/ [#161](https://github.com/cometa-kaito/kimiterrace-v2/pull/161)（安全網表示部品）/ [#165](https://github.com/cometa-kaito/kimiterrace-v2/pull/165)（エディタ画面）

## 文脈

サイネージに表示するコンテンツの公開フローを設計する必要がある。一般的な業務 SaaS では「ドラフト → 承認待ち → 公開」の二段階承認フローを採るが、本プロジェクトは公立校という階層組織の特性と「教員の働き方改革」という主目的の両方を考慮する必要がある。

選択肢:
- **承認フロー**: 管理職が公開前に内容を確認
- **即公開**: 教員が「公開」を押した瞬間に反映
- **混合**: 重要度別に承認/即公開を切替

特に懸念されるのは:
1. 公立校の階層構造では「承認者」を一意に決めにくい（学年主任・教務主任・教頭・校長のどれか曖昧）
2. 紙の掲示物時代も承認フローは事実上存在せず（教員が掲示板に貼るのが慣例）、デジタル化で過剰な統制を入れるのは現場感覚と乖離
3. AI 構造化の結果は教員が UI で編集してから公開する前提のため、教員自身が一次レビュー者になる
4. 一方、AI 抽出の誤りや公開先指定ミス（クラス間違い）の事後対応は必須

## 決定

**即公開フローを採用**し、「承認フロー」は実装しない。
代わりに **安全網 4 種** で誤公開リスクを事後対応で許容可能にする:

| # | 安全網 | 役割 |
|---|---|---|
| F04.1 | audit_log | 全公開操作の append-only 記録 |
| F04.2 | 1-click rollback | content_versions で全バージョン保管、教員 UI から 1 操作で巻き戻し |
| F04.3 | AI 確信度フラグ | confidence_score < 0.7 で「⚠️ 要確認」表示 + 根拠引用 |
| F04.4 | 公開先明示 | publish_scope NOT NULL、「全校」を強調しない UI |

## 検討した代替案

### 代替 A: 二段階承認（管理職承認）
- 却下理由: 承認者を一意に決められない公立校特性、運用が破綻するリスクが高い
- 副次理由: 承認待ちの間にサイネージが古い情報のままになり、即時性が損なわれる

### 代替 B: ピア承認（教員相互）
- 却下理由: 承認 UI を回す運用負荷が「教員の働き方改革」と矛盾
- 副次理由: 同僚教員の負担増加に対する反発が予想される

### 代替 C: 重要度別ハイブリッド
- 却下理由: 「重要度」の判定基準が学校ごと/教員ごとに揺れ、運用が不安定
- 副次理由: 教員が「これは重要かどうか」を毎回判断するコストが追加される

### 代替 D: 警告のみ（安全網なしで即公開）
- 却下理由: 誤公開時の追跡・巻き戻しができず、責任説明が立たない
- 副次理由: 公立校データを扱う以上、最低限の事後検証手段がないと監査要件を満たせない

## 結果（Consequences）

### 良い影響

- 教員の公開操作速度が紙時代と同等以下まで短縮できる（働き方改革の趣旨に合致）
- 承認フロー UI の実装・運用コストがゼロになる
- AI 抽出 + 教員レビュー + 即公開が一連の流れで完結し、UX が分かりやすい
- 安全網 4 種により、誤公開発生時の事後対応は確実

### 悪い影響 / リスク

- **誤公開リスクが残る**（特に公開先指定ミス）。F04.4 (公開先明示) で UI 上の予防を強化するが、ゼロにはできない
- **rollback 操作の認知負荷**: 教員が「巻き戻せる」ことを認識しないと安全網が機能しない → オンボーディング/ヘルプで明示する必要
- **AI 確信度の根拠表示精度**: F04.3 の根拠引用が不明瞭だと、教員が確信度フラグを無視する可能性 → F03 (AI 構造化) で根拠を引用文字列として返す要件を必須化

### トレードオフ

- 「事前統制 vs 事後検証」のうち**事後検証**に振った設計
- 公立校の慣例とは整合するが、上位機関（教育委員会等）からの監査時に「承認フロー無し」を説明する文書（[NFR07 コンプライアンス](../requirements/non-functional/NFR07-compliance.md)）が必要
- 将来「承認フロー必須」の要件が出た場合、F04 を改修して二段階フローを追加する余地は残している（content_versions テーブルが既に状態遷移を持つ構造）

## 実装メモ（2026-05-31、実装完了時に追記）

本 ADR の決定は F04 として実装済み（[#141](https://github.com/cometa-kaito/kimiterrace-v2/pull/141) / [#148](https://github.com/cometa-kaito/kimiterrace-v2/pull/148) / [#156](https://github.com/cometa-kaito/kimiterrace-v2/pull/156) / [#161](https://github.com/cometa-kaito/kimiterrace-v2/pull/161) / [#165](https://github.com/cometa-kaito/kimiterrace-v2/pull/165)）。各安全網の実装方式と、起草時の想定との差分を記録する。

### 実装方式

- **F04.1 audit_log**: `publish` / `update` / `unpublish` / `rollback` の各操作で、ドメインサービス（`packages/db/src/queries/contents-publish.ts`）が **明示的に `audit_log` へ追記**する（テーブル変更の自動トリガではなく、操作単位で意味のある diff を残すアプリ層の書き込み）。`actor_user_id` は常に操作者本人を載せ、`audit_log_insert` policy（[#100](https://github.com/cometa-kaito/kimiterrace-v2/issues/100) / [#105](https://github.com/cometa-kaito/kimiterrace-v2/issues/105)）の詐称・NULL 拒否を満たす。`prev_hash` / `row_hash` の hash chain は `migration 0003` の BEFORE INSERT トリガが計算（[NFR04](../requirements/non-functional/NFR04-audit-log.md)）。
- **F04.2 1-click rollback**: 変更のたびに `content_versions` に**全バージョンを保管**し、rollback も履歴を消さず **新バージョンとして追記**する（巻き戻しも 1 イベントとして記録）。`publishes` が「どのバージョンを公開中か」を保持。UI は `VersionTimeline`（[#165](https://github.com/cometa-kaito/kimiterrace-v2/pull/165)）で最新版以外に「このバージョンに戻す」を提示。
- **F04.4 公開先明示**: `contents.publish_scope` NOT NULL。UI（`PublishScopeSelect`、[#161](https://github.com/cometa-kaito/kimiterrace-v2/pull/161)）は全スコープを**対等に並べ全校を既定/強調にせず、初期未選択で明示選択を強制**する。
- **認可とテナント分離**: 公開操作は Server Action 層で publisher（`school_admin` / `teacher`）のみ許可（[ADR-008](008-nextjs-route-handlers.md)）。本体の分離は RLS（[ADR-019](019-rls-two-layer-tenant-isolation.md)）が DB レベルで強制。

### 起草時との差分（F04.3 確信度フラグ）

本 ADR・F04 要件は **`contents.confidence_score < 0.7`** を想定していたが、実スキーマでは確信度は **`ai_extractions.confidence_score`**（[ADR-017](017-gemini-ai-structuring-with-confidence.md)）側に存在し、`contents` には列がない。実装では `ConfidenceBadge`（[#161](https://github.com/cometa-kaito/kimiterrace-v2/pull/161)）を **`score` を prop で受ける純粋表示コンポーネント**として先行実装し、閾値判定（< 0.7）と「⚠️ 要確認」＋根拠引用の表示までを完成させた。**どの値を詳細画面に渡すか（`ai_extractions` 連携 or `contents` への列追加）のデータ配線とスキーマ整合判断は未了**で、別タスクに送る。確信度フラグの「閾値・見せ方」の決定は本 ADR どおりで変更なし。

### 既知の follow-up（本決定を覆さない範囲の改善）

- [#145](https://github.com/cometa-kaito/kimiterrace-v2/issues/145): `content_versions(content_id, version)` のバージョン採番レース（本番マルチユーザー化前に UNIQUE 制約等で対処）。
- [#150](https://github.com/cometa-kaito/kimiterrace-v2/issues/150): Server Action 層の堅牢化（scope enum 同期ガード / body 検証 / 拒否イベント監査）。
- [#166](https://github.com/cometa-kaito/kimiterrace-v2/issues/166): `system_admin` は `system_admin_full_access` policy で全校横断可視のため、`/admin/contents` に学校識別列が要る UX。
- F04.3 confidence データ配線（上記差分）。
