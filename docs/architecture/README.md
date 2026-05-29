# Architecture

このディレクトリは設計図と契約を置く。

## 構成

- `c4-context.md` — C4 Level 1 (システムコンテキスト)
- `c4-container.md` — C4 Level 2 (Cloud Run / Cloud SQL / etc.)
- `c4-component.md` — C4 Level 3 (各サービス内部)
- `data-model.md` — ER 図 + 説明
- `api-contracts.openapi.yaml` — OpenAPI 3.1 仕様
- `sequence-diagrams/` — 重要フローのシーケンス図
- `threat-model.md` — STRIDE 脅威モデル
- `disaster-recovery.md` — DR プラン
- `v1-v2-mapping.md` — V1 (Firebase 版) → V2 (Cloud Run) 画面・機能マッピング表 + sub-Issue 分割案（F0 移植の起点）

## 図は全て Mermaid で書く

理由:
- Markdown 内で見える
- Claude Code が直接編集できる
- GitHub で自動レンダリングされる
- バージョン管理しやすい
