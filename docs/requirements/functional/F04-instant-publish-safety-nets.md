# F04: 即公開フロー + 安全網 4 種

- 状態: 実装済（コア）— サーバー3層 + UI 着地（[#141](https://github.com/cometa-kaito/kimiterrace-v2/pull/141)/[#148](https://github.com/cometa-kaito/kimiterrace-v2/pull/148)/[#156](https://github.com/cometa-kaito/kimiterrace-v2/pull/156)/[#161](https://github.com/cometa-kaito/kimiterrace-v2/pull/161)/[#165](https://github.com/cometa-kaito/kimiterrace-v2/pull/165)）
- 関連 ADR: [ADR-015 (即公開+安全網)](../../adr/015-instant-publish-with-safety-nets.md)（Accepted）
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

教員が「公開」を押すと承認なしで即公開。代わりに 4 種の安全網で事後対応可能にする。

## ユーザーストーリー

- **教員として**、承認待ちのフローではなく即公開で動かしたい。**なぜなら**承認制度は校務階層と相性が悪く、運用が破綻するから。
- **教員として**、間違っていたら 1 操作で巻き戻したい。
- **校務管理者として**、誰が何を何時に公開したか後から完全に追跡したい。

## 受け入れ条件

- [x] **F04.1 audit_log**: 公開操作 (publish / update / unpublish / rollback) を全件記録。誰が何を何時に公開したか追跡可能 — 実装済（[#141](https://github.com/cometa-kaito/kimiterrace-v2/pull/141)、actor 本人性 + hash chain）
- [x] **F04.2 1-click rollback**: 各コンテンツに `content_versions` テーブルで全バージョン保管。教員 UI から 1 ボタンで直前バージョンへ巻き戻し。rollback も新バージョンとして記録（履歴は失わない）— 実装済（[#141](https://github.com/cometa-kaito/kimiterrace-v2/pull/141) サービス + [#165](https://github.com/cometa-kaito/kimiterrace-v2/pull/165) タイムライン UI）
- [~] **F04.3 AI 確信度フラグ**: confidence_score < 0.7 のコンテンツは UI で「⚠️ 要確認」バッジ表示 + AI 推測の根拠引用表示 — 表示部品は実装済（[#161](https://github.com/cometa-kaito/kimiterrace-v2/pull/161) `ConfidenceBadge`、閾値 0.7 + 根拠引用）。**データ配線未了**: confidence は `ai_extractions` 側にあり `contents` に列がない（[ADR-015 実装メモ](../../adr/015-instant-publish-with-safety-nets.md)）。スキーマ整合は別タスク
- [x] **F04.4 公開先明示**: 全コンテンツに `publish_scope` を必須化（NOT NULL）。曖昧な「全校」ボタンを設けず、明示選択させる — 実装済（[#161](https://github.com/cometa-kaito/kimiterrace-v2/pull/161) `PublishScopeSelect`、全校を既定/強調にせず初期未選択）
- [ ] 公開後は即サイネージ + magic link 経由生徒画面に反映 (CDN キャッシュ最大 60 秒) — サイネージ/配信側（別スコープ）
- [ ] 公開先と一致しない magic_link 経由のアクセスは 403 — F05（magic link）側で対応

## 安全網 4 種の詳細仕様

| 安全網 | 実装 | DB |
|---|---|---|
| F04.1 audit_log | publish/update/unpublish/rollback を append-only | `audit_log` テーブル、diff jsonb |
| F04.2 1-click rollback | 教員 UI のタイムライン → 「このバージョンに戻す」 | `content_versions` 全バージョン保管 |
| F04.3 確信度フラグ | UI で `⚠️ 要確認` バッジ + 根拠引用 | `contents.confidence_score` <0.7 で flag |
| F04.4 公開先明示 | UI でクラス選択デフォルト、「全校」は強調しない | `contents.publish_scope` NOT NULL |

## 関連

- 前段: [F01](F01-teacher-file-extraction.md), [F02](F02-teacher-voice-chat-input.md), [F03](F03-ai-structuring.md)
- 後段: [F05 (magic link)](F05-class-magic-link.md), [F06 (生徒対話)](F06-student-qa.md)
- 監査: [NFR04](../non-functional/NFR04-audit-log.md)
- テスト: `__tests__/api/publish/`, `__tests__/api/rollback/`
