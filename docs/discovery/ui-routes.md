# 旧 UI ルート一覧

> **ステータス: 🚧 BLOCKED — 旧プロジェクト未参照**
>
> 参照元 (CLAUDE.md より):
> - `../キミテラス/management/src/**/*`（Next.js pages/app）
> - `../キミテラス/management/package.json`（Next.js バージョン特定）
> - `../キミテラス/management/next.config.*`

## 目的

旧管理 UI のページ一覧と機能を文書化し、v2 Next.js 16 (App Router) へのルート設計
（#16 C4 図 / #12 機能要件）に渡す。

## 必要な記載項目（テンプレート）

### ルート表

| 旧ルート | App Router (Pages?) | 役割 | 必要権限 (claims) | データ依存 (Firestore コレクション) | v2 ルート案 |
|---|---|---|---|---|---|
| `/login` | pages | ログイン | unauth | - | `/login` |
| `/dashboard` | pages | ダッシュボード | auth | `schedules`, `notifications` | `/(app)/dashboard` |
| ... | ... | ... | ... | ... | ... |

### 認可マトリクス

ロール × ルートの 2 次元表を作る。

| ロール | `/dashboard` | `/admin/users` | ... |
|---|---|---|---|
| `student` | ✅ | ❌ | |
| `teacher` | ✅ | ❌ | |
| `school_admin` | ✅ | ✅ | |
| `super_admin` | ✅ | ✅ | |

### コンポーネント分類

- **公開 (unauth)**: ログイン・パスワードリセット等
- **認証必須 (auth)**: ダッシュボード以下
- **管理者専用 (admin claim)**: ユーザー管理・学校設定
- **印刷/サイネージビュー**: firmware 端末が読むビュー（あれば）

### ナビゲーション構造

- グローバルナビ
- サイドバー
- 役割ごとに表示分岐があるか

## v2 設計への引き継ぎ事項

- ルートグループ `(app)` / `(public)` / `(admin)` の切り方
- Server Component / Client Component の境界
- middleware での認可
- データ取得は Server Action か Route Handler か

→ ADR-008 と整合させる。

---

最終更新: BLOCKED 状態 / 旧プロジェクトの参照が必要
