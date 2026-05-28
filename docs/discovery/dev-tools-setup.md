# 開発ツールのインストール状況

確認日: 2026-05-28

## インストール済み

| ツール | バージョン | パス |
|---|---|---|
| Node.js | v24.12.0 | (PATH) |
| npm | 11.6.2 | (PATH) |
| pnpm | 11.4.0 | (PATH) |
| git | (有) | (PATH) |
| GitHub CLI | (有) | (PATH) |
| Google Cloud SDK | 570.0.0 | `C:\Users\20051\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin` |
| Terraform | v1.15.5 | `C:\tools\terraform` |

## PATH 環境変数の状態

⚠️ Claude Code 起動時のシェル PATH に **gcloud と terraform が含まれていない**。

新しいターミナルセッションを開けば反映されるはずだが、Claude Code 経由のコマンド実行では絶対パスを使う必要がある。

### 推奨対応（人間タスク）

Windows の「環境変数」設定を確認し、以下が PATH に含まれているか確認:

- `%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin`
- `C:\tools\terraform`

含まれていなければ追加し、**Claude Code を再起動** すると Bash ツール経由でも直接呼べるようになる。

### 当面の運用

絶対パスでも動作確認は取れているため、Terraform 雛形作成時に **wrapper スクリプト** か **環境変数 GCLOUD_BIN / TERRAFORM_BIN** を導入することも検討。

## Sentry アカウント

作成済み。Sentry 関連の DSN 設定は W5 実装フェーズで Secret Manager に投入する。
当面はアカウント作成のみで OK。

## 関連

- Issue: [#19](https://github.com/cometa-kaito/kimiterrace-v2/issues/19)
