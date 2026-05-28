# Sequence Diagrams

主要フローのシーケンス図（Mermaid）。Part B（教員系）+ Part C（生徒・分析系）に分割。

## Part B: 教員系（このディレクトリ）

| ファイル | F# | 内容 |
|---|---|---|
| [auth-login.md](auth-login.md) | F11 | 認証 → JWT → RLS context 確立 |
| [teacher-file-extraction.md](teacher-file-extraction.md) | F01 | PDF/Word/Excel → Gemini 構造化 |
| [teacher-voice-input.md](teacher-voice-input.md) | F02 | 音声/チャット → AI 構造化 |
| [instant-publish.md](instant-publish.md) | F04 | 即公開 → audit_log → CDN |
| [rollback.md](rollback.md) | F04.2 | 1-click rollback |

## Part C: 生徒・分析系（別 PR で追加予定）

`magic-link.md` / `student-qa.md` / `event-logging.md` / `monthly-report.md`

## 図の作法

- すべて Mermaid `sequenceDiagram` 記法
- 前提 / 登場ロール / データ流れ / 監査ポイント / 関連 ADR を必ず記載
- 登場ロールは [v2-mvp.md §3](../../requirements/v2-mvp.md) と一致させる
- DB 書込みは「audit_log にも追記」を明示
