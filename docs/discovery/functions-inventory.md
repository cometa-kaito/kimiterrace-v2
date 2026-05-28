# 旧 Cloud Functions 棚卸し

> **ステータス: 🚧 BLOCKED — 旧プロジェクト未参照**
>
> 参照元 (CLAUDE.md より):
> - `../キミテラス/functions/index.js`
> - `../キミテラス/functions/handlers/*`
> - `../キミテラス/functions/package.json`（依存トリガとランタイム特定のため）

## 目的

旧 Cloud Functions の役割と依存を文書化し、v2（Next.js Route Handlers + Cloud Run Jobs）への
移行マッピングを明確にする。

## 必要な記載項目（テンプレート）

各 Function ごとに以下を埋める:

### `<functionName>`

- **トリガ種別**: HTTPS Callable / HTTPS Request / Firestore Trigger (`onCreate`/`onUpdate`/`onDelete`/`onWrite`) / Auth Trigger / Pub/Sub / Storage / Scheduler
- **トリガ対象**: コレクションパス・トピック名・cron 式など
- **役割**: 何をするか（1〜3行）
- **入力**: 引数 / リクエストボディの形
- **出力**: レスポンス / 副作用（Firestore 書き込み・通知送信など）
- **依存サービス**: Firestore / Auth / Storage / 外部 API / FCM 等
- **必要な権限**: 呼び出せる Auth Custom Claims、もしくは Admin SDK で何でも可
- **シークレット参照**: `functions.config()` のキー名 → v2 では Secret Manager に移行
- **PII 取り扱い**: あり/なし、ログ出力の有無
- **エラー処理**: リトライ可否・冪等性
- **想定 QPS / 月間呼び出し回数**: わかる範囲で
- **v2 移行先**:
  - HTTPS 系 → `apps/web/app/api/.../route.ts` (Next.js Route Handler)
  - Firestore Trigger → イベント駆動が必要なら Pub/Sub + Cloud Run Jobs、不要なら Server Action 内で実行
  - Scheduler → Cloud Scheduler + Cloud Run Jobs
  - Auth Trigger → Identity Platform のフック（または初回ログイン時の同期処理）

## 集計サマリー（埋める）

| 種別 | 件数 |
|---|---|
| HTTPS Callable | TBD |
| HTTPS Request | TBD |
| Firestore Trigger | TBD |
| Auth Trigger | TBD |
| Scheduler | TBD |
| Pub/Sub | TBD |
| Storage | TBD |

## 移行優先度

各 Function に対し:

- **P0** (Day1 必須): 認証・データ整合性
- **P1**: 通知・スケジューリング
- **P2**: 補助的ジョブ
- **drop**: 廃止可能

を判断する。

---

最終更新: BLOCKED 状態 / 旧プロジェクトの参照が必要
