# F02: 教員音声 / チャット入力

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-005 (Vertex AI), ADR-006 (Vercel AI SDK), ADR-017 (起票予定)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

教員が音声 or チャットで「明日 10 時から体育館で○○の説明会」と話しかけると、AI が構造化してコンテンツ草稿を生成する。

## ユーザーストーリー

- **教員として**、職員室で立ち話のように音声入力して、すぐにサイネージへ反映したい。**なぜなら**「ちょっとした連絡」を紙やパソコン入力で作る時間が無駄だから。

## 受け入れ条件

- [ ] ブラウザの Web Speech API または Cloud Speech-to-Text で音声 → テキスト
- [ ] 教員 UI のチャット欄から直接テキスト入力も可
- [ ] AI が日時・場所・対象クラス・本文を抽出
- [ ] 抽出結果は [F01](F01-teacher-file-extraction.md) と同じ編集 UI に流れる
- [ ] 音声データは保存しない（テキスト化後すぐ破棄、PII 漏洩リスク低減）
- [ ] 音声入力時の校内録音は教員端末ローカルのみで処理し、ネットワーク送信はテキスト化後

## 関連

- 後続: [F03](F03-ai-structuring.md), [F04](F04-instant-publish-safety-nets.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md)
- テスト: `__tests__/ui/teacher-input/`
