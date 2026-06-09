# provision-agent — C方式 TV プロビジョニング ローカルエージェント (PR5)

学校 LAN 上の **現地ノート PC で install 時に手動起動**するスタンドアロン CLI（常駐デーモンではない）。
system_admin が v2 管理 UI でプロビジョニングジョブを作成すると、本エージェントがそれを claim し、
adb で Google TV を段階的にプロビジョニングして各ステップを v2 API に報告する。

ソースは v2 リポジトリ内（`scripts/provision-agent/`）に置く。実行はローカルだが、v2 の CI・規約
（biome / vitest / CLAUDE.md 8 ルール）に乗せるため在処は v2。

---

## 前提

- **Node 20+**（グローバル `fetch` を使用。外部 npm 依存なし）
- **adb**（`platform-tools`）が PATH にあるか `ADB_PATH` で指定
- **gcloud** が認証済み（`gcloud auth login`）でシークレットへの読み取り権限を持つ
- PC と TV が **同一 LAN**（ADB over network / port 5555、または USB 接続）
- TV ブリッジ APK（`tv-ble-bridge-debug.apk`、**debug 署名＝`run-as` が使える**）を入手し `APK_PATH` で指定

---

## 環境変数

| 変数 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `V2_BASE_URL` | ✅ | — | v2 のベース URL（例 `https://app.school-signage.net`） |
| `PROVISION_AGENT_SECRET` | ※ | — | エージェント API 鍵。未設定なら Secret Manager から取得 |
| `APK_PATH` | ✅（provisioning 段） | — | `tv-ble-bridge-debug.apk` のパス |
| `AGENT_ID` | | ホスト名 | エージェント識別子（status 報告の認可キー = claim 時の値） |
| `ADB_PATH` | | `adb` | adb 実行ファイルのパス |
| `GCLOUD_PATH` | | `gcloud` | gcloud 実行ファイルのパス |
| `PROVISION_AGENT_SECRET_NAME` | | `prod-provision-agent-secret` | エージェント鍵の Secret Manager 名 |
| `TV_POLL_SECRET_NAME` | | `prod-tv-poll-secret` | TV ポーリング鍵の Secret Manager 名 |
| `POLL_INTERVAL_MS` | | `5000` | claim / 再到達ポーリング間隔 |
| `ADB_REACHABLE_TIMEOUT_MS` | | `600000` | 物理作業後の adb 再到達待ちタイムアウト |

※ `PROVISION_AGENT_SECRET` を env で渡さない場合は、起動時に
`gcloud secrets versions access latest --secret=prod-provision-agent-secret` で取得する。

---

## 実行

```bash
# 1 件だけ処理して終了（現地で 1 台ずつ流すのに推奨）
V2_BASE_URL=https://app.school-signage.net \
APK_PATH=/path/to/tv-ble-bridge-debug.apk \
node scripts/provision-agent/provision-agent.mjs --once

# ジョブが尽きるまで連続処理
node scripts/provision-agent/provision-agent.mjs
```

`--once` は 1 ジョブ処理後に終了。無印は claim 可能なジョブが無くなったら終了する（デーモン化しない）。

---

## 段階ワークフロー

各段階で v2 の status エンドポイント（`POST /api/tv/provisioning/<jobId>/status`）に報告する。

1. **preflight** — `adb connect <target_ip>:5555`（または USB）→ 機種検出 → 県 Wi-Fi の静的設定
   （IP/GW/DNS/proxy）と MAC を捕捉。`cmd wifi get-factory-mac` と現在 wlan0 MAC を比較。
   - **MAC が一致**: `awaiting_physical` へ進む。
   - **MAC 不一致（ランダマイズ）**: 県 Wi-Fi が MAC 認証ならこの端末は接続できない。**reset に進まず**
     ① **LP-as-proxy フォールバック**を推奨して `failed` 報告（後述）。
2. **awaiting_physical** — 捕捉値を埋め込んだ物理手順を表示し、**オペレータの手動作業**（factory reset →
   県 Wi-Fi 再参加、静的 IP/GW/DNS/proxy/MAC）を待つ。adb 再到達をポーリングして次段へ。
3. **provisioning** — `adb install -r <apk>` → `dpm set-device-owner`（owner 済みは skip）→
   オフタイマー / no-sleep 無効化 → prefs 書き込み（`config_endpoint` + device_id + signage_url +
   target_mac を base64 `run-as` で）→ 権限付与 → 起動。各ステップを報告。
4. **succeeded / failed** — 完了 or エラー要約を報告。

> adb 具体コマンド（オフタイマー無効化キー・prefs base64 run-as・no-sleep キー・起動 intent）は
> tv-ble-bridge リポジトリ `dist/provision-googletv.md` §4/§5/§6/§7 を一次ソースに実装している。
> TV パッケージは `com.kimiterrace.tvbridge`、Device Owner 受信機は `.TvDeviceAdminReceiver`。

---

## MAC ミスマッチ時のフォールバック

`cmd wifi get-factory-mac` が現在 MAC と異なる場合は **MAC ランダマイズが有効**。県 Wi-Fi が
MAC アドレス認証だと、工場 MAC で許可登録していてもこの端末は接続できない。この場合エージェントは
**factory reset に進まず**、① **LP-as-proxy フォールバック**（端末は据え置き設定のまま、表示は
v2 lp-config 経由）を推奨し、当該ジョブを `failed`（理由付き）で報告する。reset するかどうかは
運用判断（`provision-googletv.md` §10 も参照）。

---

## 安全・セキュリティ

- **物理 factory reset は人間が行う。** エージェントは破壊的な物理操作を自動化しない（捕捉値の提示と
  adb 駆動・状態報告に徹する）。
- **シークレット（CLAUDE.md ルール5）**:
  - `PROVISION_AGENT_SECRET` は env か Secret Manager から。
  - TV ポーリング鍵は **prefs 書き込み直前**に `gcloud secrets versions access prod-tv-poll-secret`
    で取得し `config_endpoint=<V2_BASE_URL>/api/tv/lp-config?key=<poll-secret>` に埋め込む。
  - 鍵は **ハードコードしない / ログに出さない / job・steps_json に載せない**。prefs XML 経由
    （base64）でのみ端末に渡る。報告する `detail` は非秘密（機種名・MAC 一致可否・捕捉した
    ネットワーク設定）に限る。
- 子プロセスはシェルを介さず引数配列で起動する（鍵が環境変数・プロセス一覧に漏れない）。

---

## テスト

純粋ヘルパー（`lib.mjs`）の単体テストを `__tests__/lib.test.ts` に置く（DB 不要、node 環境）。

```bash
pnpm --filter @kimiterrace/provision-agent test
# もしくはモノレポ全体
pnpm test
```
