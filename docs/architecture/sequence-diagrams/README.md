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

## Part C: 生徒・分析系（このディレクトリ）

| ファイル | F# | 内容 |
|---|---|---|
| [magic-link-issuance.md](magic-link-issuance.md) | F05 | クラス magic link 発行 → QR 配布 → 失効 |
| [student-qa.md](student-qa.md) | F06 | 生徒 Q&A → PII mask → RAG → Gemini SSE → 監査 |
| [event-logging.md](event-logging.md) | F07 | tap/view/dwell/ask → events → BigQuery |
| [monthly-report.md](monthly-report.md) | F09 | Cloud Run Job → 集計 → PDF → system_admin DL |

## 図の作法

- すべて Mermaid `sequenceDiagram` 記法
- 前提 / 登場ロール / データ流れ / 監査ポイント / 関連 ADR を必ず記載
- 登場ロールは [v2-mvp.md §3](../../requirements/v2-mvp.md) と一致させる
- DB 書込みは「audit_log にも追記」を明示
