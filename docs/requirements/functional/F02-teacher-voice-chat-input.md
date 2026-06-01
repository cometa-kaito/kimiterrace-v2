# F02: 教員音声 / チャット入力

- 状態: 一部実装（入力 UI（音声/テキスト）+ 履歴一覧 + 抽出トリガ配線は実装済。F01 編集 UI 連携は未実装、実 Vertex 呼出は PII ゲート待ち）
- 関連 ADR: ADR-005 (Vertex AI), ADR-006 (Vercel AI SDK), ADR-017 (起票予定)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#38](https://github.com/cometa-kaito/kimiterrace-v2/issues/38)

## 概要

教員が音声 or チャットで「明日 10 時から体育館で○○の説明会」と話しかけると、AI が構造化してコンテンツ草稿を生成する。

## ユーザーストーリー

- **教員として**、職員室で立ち話のように音声入力して、すぐにサイネージへ反映したい。**なぜなら**「ちょっとした連絡」を紙やパソコン入力で作る時間が無駄だから。

## 受け入れ条件

- [~] ブラウザの Web Speech API または Cloud Speech-to-Text で音声 → テキスト — 部分実装（[#282](https://github.com/cometa-kaito/kimiterrace-v2/pull/282)、`apps/web/lib/teacher-input/use-speech-to-text.ts`）残: ブラウザ Web Speech API は実装済、Cloud Speech-to-Text フォールバックは未配線
- [x] 教員 UI のチャット欄から直接テキスト入力も可 — 実装済（[#282](https://github.com/cometa-kaito/kimiterrace-v2/pull/282)、`apps/web/app/admin/teacher-input/_components/TeacherInputComposer.tsx`）
- [~] AI が日時・場所・対象クラス・本文を抽出 — 部分実装（[#157](https://github.com/cometa-kaito/kimiterrace-v2/pull/157)、[#287](https://github.com/cometa-kaito/kimiterrace-v2/pull/287)、`apps/web/app/api/teacher-inputs/[id]/extract/route.ts`）残: F03 構造化抽出トリガ（schedule/announcement 等）は配線済だが、実 Vertex 呼び出しは PII 設計ゲート（#289 後続）待ち
- [ ] 抽出結果は [F01](F01-teacher-file-extraction.md) と同じ編集 UI に流れる — 未実装（F01 の編集 UI 自体が未実装）
- [x] 音声データは保存しない（テキスト化後すぐ破棄、PII 漏洩リスク低減）— 実装済（[#282](https://github.com/cometa-kaito/kimiterrace-v2/pull/282)、`apps/web/lib/teacher-input/use-speech-to-text.ts`：確定テキストのみ state 化、unmount で abort）
- [x] 音声入力時の校内録音は教員端末ローカルのみで処理し、ネットワーク送信はテキスト化後 — 実装済（[#282](https://github.com/cometa-kaito/kimiterrace-v2/pull/282)、`apps/web/lib/teacher-input/use-speech-to-text.ts`：端末ローカル Web Speech のみ、Composer は確定テキストのみ POST）

> 補足: 教員入力 履歴一覧（FR-08、[#309](https://github.com/cometa-kaito/kimiterrace-v2/pull/309)、`apps/web/app/admin/teacher-input/history/`）と nav 導線（[#310](https://github.com/cometa-kaito/kimiterrace-v2/pull/310)）も実装済（本 doc のチェックボックスには直接対応しないが関連）。

## 関連

- 後続: [F03](F03-ai-structuring.md), [F04](F04-instant-publish-safety-nets.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md)
- テスト: `__tests__/ui/teacher-input/`
