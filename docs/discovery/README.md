# Discovery

旧システムの棚卸し・外部条件の確認結果を置く。
**事実の記録**であり、設計判断は ADR に書く。

## ファイル一覧

| ファイル | 内容 |
|---|---|
| `wifi-filter-method.md` | 県教委 Wi-Fi のフィルタ方式確認結果 |
| `gcp-project-setup.md` | GCP プロジェクト signage-v2-prod の状態 |
| `dev-tools-setup.md` | 開発ツールのインストール状況 |
| `firestore-collections.md` | (W0 #11) 旧 Firestore コレクション一覧 — 🚧 BLOCKED（旧プロジェクト未参照） |
| `functions-inventory.md` | (W0 #11) Cloud Functions 一覧 — 🚧 BLOCKED |
| `ui-routes.md` | (W0 #11) UI ルート一覧 — 🚧 BLOCKED |
| `firmware-behavior.md` | (W0 #11) firmware 挙動 — 🚧 BLOCKED |
| `auth-claims.md` | (W0 #11) Auth Custom Claims 使い方 — 🚧 BLOCKED |
| `storage-buckets.md` | (W0 #11) Storage バケット構造 — 🚧 BLOCKED |

## #11 のテンプレート方針

`firestore-collections.md` 以下 6 ファイルはテンプレート（記載項目の枠）のみ提供。
旧 Firebase プロジェクト `../キミテラス/` がこの Worker 環境に存在しないため、
**当て推量を避けて中身を空にしている**。実調査時はテンプレートに沿って埋める。
