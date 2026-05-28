# Auth Custom Claims の使い方

> **ステータス: 🚧 BLOCKED — 旧プロジェクト未参照**
>
> 参照元 (CLAUDE.md より):
> - `../キミテラス/functions/handlers/*`（claims を set している箇所を grep）
> - `../キミテラス/firestore.rules`（`request.auth.token.<claim>` を参照している箇所）
> - `../キミテラス/management/src/**/*`（クライアント側で claims を読んでいる箇所）

## 目的

旧 Firebase Auth の Custom Claims がどう使われているかを文書化し、
v2 の Identity Platform + アプリ DB（`users` テーブル + ロール）への移行マッピングを作る。

## 必要な記載項目（テンプレート）

### Claims 一覧

| claim キー | 型 | 取りうる値 | 設定タイミング | 用途 | v2 移行先 |
|---|---|---|---|---|---|
| `role` | string | `student`/`teacher`/`school_admin`/`super_admin` | ユーザー作成時 / ロール変更時 | RBAC | `users.role` カラム + アプリ層認可 |
| `school_id` | string | UUID | ユーザー作成時 | テナント分離 | `users.school_id` + RLS の `app.current_school_id` |
| `device_id` | string? | UUID | サイネージ端末プロビジョニング時 | 端末識別 | `devices` テーブル |
| ... |

> 上は **テンプレートのプレースホルダ**。実調査で確定する。

### Claims 設定箇所

- 初回ユーザー作成: どの Function / どの管理画面
- ロール変更: どの Function / どの管理画面
- 学校移籍時の更新フロー

### Claims 利用箇所

- `firestore.rules`: 何を許可しているか
- クライアント (`management/`): UI 出し分けに使っているもの
- firmware: 使っていれば

### 既知の問題

- Custom Claims の伝播遅延（最大 1 時間）への対処があるか
- claim サイズ制限（1KB）への対応
- claim 改竄不可だが「信頼できる発行源」をどう保証しているか

## v2 設計の方針

- **v2 ではアプリ DB の `users.role` を真実の単一ソースとする** (CLAUDE.md ルール3)
- Identity Platform は認証（誰か）だけ担当、認可（何ができるか）は DB と RLS で判定
- セッション開始時に `app.current_school_id` を必ず SET する（CLAUDE.md ルール2）
- 監査ログに `user_id` を必ず残す（CLAUDE.md ルール1）

→ ADR-003 (Identity Platform) と整合させる。

---

最終更新: BLOCKED 状態 / 旧プロジェクトの参照が必要
