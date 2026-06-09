# キミテラス サイネージ（Google TV / kiosk）監査 + 新規モニタ オンボーディング手順

- **実施日**: 2026-06-09
- **方針**: READ-ONLY 監査（コード・デプロイ・インフラを一切変更していない）。本書の修正提案は未適用。
- **対象**: 学校設置の Google TV サイネージ端末（自作 Android アプリ `com.kimiterrace.tvbridge`）と、それを制御するサーバ側（v2 = `キミテラス-v2`、現行 LP = `kimiteras-lp` / `www.school-signage.net` / Turso）。
- **証拠**: すべて file:line で引用。行番号は本監査時点のもの。

---

## 0. 最重要の前提確認 — TV アプリのソースはこのマシンに存在しない

**結論: `com.kimiterrace.tvbridge`（Google TV 上で動く Android アプリ）のソースコードは `C:\Users\20051\Desktop\app` ツリーに存在しない。**

検証したこと:

- 4 つのプロジェクトルート（`キミテラス`, `キミテラス-v2`, `kimiteras-lp`, `kimiteras-portal`）を `*.kt` / `*.java` / `*.gradle` / `AndroidManifest.xml` / `*.apk` / `*.aab` で再帰検索 → **ヒット 0 件**。
- `キミテラス\firmware\` の中身は LiDAR センサーの Arduino スケッチのみ（`firmware\lidar_sensor\lidar_sensor.ino`）。TV アプリではない。
- `キミテラス\signage-display\` は**完全に空**（再帰アイテム数 0）。
- v2 の `CLAUDE.md`（ディレクトリ構成）と `docs/requirements/functional/F15-tv-device-management.md:189` / `F16:121` は TV 側実装を **「LP リポジトリの `ConfigPoller.kt` / `BootReceiver`」** と明記。これは別リポジトリ `edix-lp`（`C:\Users\20051\Desktop\学校DX事業\06_LP\edix-lp`、`docs/runbooks/prod-bringup-cutover.md:258`）にあり、本マシンの当該パスには配置されていない（`kimiteras-lp` は LP の**サーバ側のみ**で、`scripts/` に TV アプリは含まれない）。

**この監査への影響（重要）**: TV アプリ内部の挙動（スケジュール解釈・黒画面描画・kiosk ロック・スリープ抑止・自動再起動・OTA）は**ソースで検証できない**。よって本書では、それらの項目を **UNVERIFIABLE-FROM-CODE** と明示し、判断はサーバ側エンドポイント・スクリプト・運用 docs・要件 docs に残るコメントから**間接的に推定できる範囲**に限定する。アプリ仕様の確証には `edix-lp` リポジトリ（`ConfigPoller.kt` 等）の入手が必要。

### 0.1 確認できた制御アーキテクチャ（pull 型ポーリング）

ソースで確証できた範囲のデータフロー:

```
[Google TV: com.kimiterrace.tvbridge]
   │  60秒ごと GET /api/tv/config?device_id=<uuid>&key=<secret>   ← TV→サーバの片方向 pull のみ
   ▼
[サーバ]  現行=LP(Vercel)+Turso  /  cutover後=v2(Cloud Run)+Cloud SQL
   - signage_url / target_mac / schedule / version / commands を返す
   - last_seen を更新（＝死活心拍）
```

- ポーリング方式・60 秒間隔・サーバから TV への能動接続なし: `apps/web/app/api/tv/config/route.ts:8-30`、要件 `F15-tv-device-management.md:18`、ADR-022。理由は「学校 Wi-Fi はアウトバウンドのみ許可が多い」（同 route.ts:13）。
- 県教委 Wi-Fi は **FQDN/SNI 許可リスト**で `app.school-signage.net` のみ許可（`.run.app` は遮断）: `docs/discovery/wifi-filter-method.md:7-9,25`、`packages/db/src/seed-ginan-signage.ts:14-16`。

### 0.2 「SwitchBot で TV を物理的に ON/OFF する」は**コード上は実装されていない**

依頼文の前提（SwitchBot で TV 電源を入れる）を検証したが、**SwitchBot を使った TV 電源制御のコードはどのプロジェクトにも存在しない**。

- `kimiteras-lp` 内の SwitchBot 関連は**すべて PIR 人感センサーの検知イベント受信（webhook）**用: `scripts/setup-switchbot-webhook.mjs:43-56`（`webhook/setupWebhook` を登録するだけ）、`app/api/switchbot-webhook/route.ts`（motion_events を INSERT）、`docs/SWITCHBOT_SETUP.md:11-20`（センサー→Hub2→クラウド→webhook の構成図）。
- SwitchBot API の**デバイス操作系**（`/v1.1/devices/{id}/commands`、`turnOn`/`turnOff`/`press`）の呼び出しは **0 件**（`kimiteras-lp` 全体検索）。
- 実機で「電源が勝手に切れた」原因として要件 docs が記録しているのは **TV 本体の電源オフタイマー**であって SwitchBot ではない: `F16-tv-uptime-monitoring.md:20`「1年機（ORION AI PONT）が **TV 本体の電源オフタイマー（16:30）** で勝手に電源OFF」。
- 「起こす（wake）」操作も SwitchBot ではなく、**ポーリング応答の `commands.wake` を受けて TV アプリがスリープ抑止設定を再適用する**ソフト的なもの: `kimiteras-lp/scripts/wake-tv.mjs:2-6`。

→ **本書では「SwitchBot=TV 電源制御」は前提として採用しない。** もし運用上 SwitchBot Bot/プラグ等で物理的に主電源を入り切りしているなら、それは**コード外の手作業**であり、自動化されていない（要件 1 / 3 のギャップとして後述）。

---

## Deliverable 1 — Kiosk 要件監査

### サマリ表

| # | 要件 | 判定 | 一言 |
|---|---|---|---|
| 1 | スケジュール ON/OFF（曜日+時刻、アプリから設定、黒画面 pseudo-off 可） | **PARTIAL** | サーバ側のスケジュール配信・遠隔編集・黒画面 pseudo-off の**意図**は実装/文書化済。ただし実際の黒画面描画は TV アプリ側（ソース未確認）。**cutover 後は wake/reload コマンドが届かない**穴あり |
| 2 | タンパー耐性（リモコン/アプリ切替で改変させない kiosk ロック） | **UNVERIFIABLE-FROM-CODE** | kiosk lockdown / pinned screen / home-app 化はすべて TV アプリ・端末設定側。ソースが無く確認不能 |
| 3 | 夜間バックライト（真の消灯 vs 黒画面） | **FAIL（設計上の限界）** | スキーマ上 OFF=「黒画面」と明記。バックライト/輝度制御の口は**どこにも無い**。黒画面=バックライト点灯のまま=暗所で光る |
| 4 | 初回タッチ後はリモート完結 | **PARTIAL** | signage_url / schedule / reload はリモート可。だが `config_endpoint`（ポーリング先 URL）と焼き込み鍵は**物理/ADB でしか変更不可**。cutover 後はコマンドが届かない |
| 5 | その他（再起動・watchdog・オフライン・OTA・時刻・音声・証明書・秘密 等） | 個別に後述 | 死活監視 last_seen は実装済。自動再起動/OTA/オフラインキャッシュは TV 側で未確認。**単一共有シークレットが読み書き+TV 制御を兼ねる**のが最大の運用リスク |

---

### 要件 1 — スケジュール電源 ON/OFF（最重要・最も精査）

**判定: PARTIAL**

**できていること（サーバ側、ソースで確証）:**

1. **スケジュールのデータモデルは曜日+時刻で表現可能。** `packages/db/src/schema/tv-devices.ts:76-88` の `TvSchedule` 型:
   ```ts
   enabled: boolean;   // false なら黒画面（夜間・休日）  ← :77-78
   onHour?: number;    // 表示開始（JST 0-23）           ← :80-81
   offHour?: number;   // 表示終了（JST 0-23）           ← :82-83
   weekdays?: number[];// 0=日..6=土、指定曜日のみ ON      ← :84-87
   ```
   既定値は平日 08:00–17:00: `seed-ginan-tv-devices.ts:54-59`（`{enabled:true, onHour:8, offHour:17, weekdays:[1,2,3,4,5]}`）。

2. **「黒画面 pseudo-off」が公式の OFF 方式として明記されている。** `tv-devices.ts:77-78`「`enabled` … false なら黒画面（夜間・休日）」。要件 `F16:33`「スケジュール OFF 時間帯（夜間・休日の**黒画面**中）の誤報は抑えてほしい」。→ 真のスリープではなく黒画面で代替する設計意図が文書化されている（依頼文の許容条件に合致）。

3. **曜日+時刻はリモートで設定可能。** v2 管理 UI の編集フォームに「表示開始（時）/表示終了（時）/表示する曜日（日〜土チェックボックス）/有効化」がある: `apps/web/app/admin/tv-devices/[deviceId]/edit/_components/TvConfigEditForm.tsx:150-213`。検証ロジック（0-23 / 0-6 / 重複なし）は `lib/tv/config-edit-core.ts:245-276`（`validateSchedule`）。保存で `version`+1（`F15:118`）。
   現行 LP では CLI `kimiteras-lp/scripts/set-tv-schedule.mjs`（`--on 7:30 --off 16:30 --days weekdays|everyday`、:15-17）で同等操作が可能。LP は `on_hour/off_hour/days_mask`（Calendar 曜日ビット）形式（:79-85,108-119）。

4. **配信はポーリングで TV へ届く。** `version` 差分時のみ TV が反映（`tv-devices.ts:28-29,118`）。最大 60 秒で適用（`set-tv-schedule.mjs:134`）。

**できていない / 未確認:**

- 🔴 **実際に黒画面を描画するのは TV アプリ側で、ソースが無いため未確認（UNVERIFIABLE-FROM-CODE）。** サーバは `schedule_json` を配るだけ。`enabled=false` → 黒画面、`onHour/offHour` の境界処理、JST 判定、曜日マスクの実装は `ConfigPoller.kt`（`F15:189`）にあり本マシンに無い。「スケジュール ON/OFF が**実際に効く**」ことはコードでは保証できず、実機テストか `edix-lp` ソースが必要。
- 🔴 **cutover 後（v2 へ向けた後）、wake/reload 等のコマンドが TV に届かない。** LP 互換層 `apps/web/lib/tv/lp-compat.ts:65-67,92`（`toLpConfigResponse`）と `apps/web/app/api/tv/lp-config/route.ts:62` は、v2 のコマンドキューを **`commands: {}`（空）** で返すと明示。runbook `prod-bringup-cutover.md:179,245` も「wake/reload コマンド連携は follow-up、`commands{}` 空で実機は no-op」と確認。→ **スケジュール変更（schedule_json）は届くが、「今すぐ点ける/消す/リロード」の即時コマンドは cutover 後は無効。**
- 🟡 **真の電源 OFF→ネットワーク復帰（wake-on-LAN 相当）は不可能。** これは設計上の既知制約（`prod-bringup-cutover.md`、ADR-022 のポーリング片方向性）。黒画面方式はこの制約を回避するための代替であり妥当。
- 🟡 v2 のスケジュールは**時（hour）単位**のみ（`TvSchedule` に分が無い、`tv-devices.ts:80-83`）。LP は分まで持つ（`set-tv-schedule.mjs:113-114` の `on_minute/off_minute`）。lp-compat は `on_minute=0/off_minute=0` 固定で変換（`lp-compat.ts:78-79`）。→ cutover 後は「16:30 消灯」のような分指定ができず 16:00 か 17:00 に丸まる。運用上の細かな制約。

**結論**: サーバ側のスケジュール基盤・遠隔編集・黒画面 pseudo-off の意図は揃っており、依頼の MUST に対し設計は妥当。ただし (a) 黒画面の実描画が TV アプリ側で未確認、(b) cutover 後に即時コマンドが届かない、(c) 分単位指定が消える、の 3 点で **PARTIAL**。

**修正案:**
- TV アプリソース（`edix-lp` の `ConfigPoller.kt`）を入手し、`enabled=false`→黒画面、曜日/時刻境界、JST/タイムゾーンの実装を確認・テストする（最優先。これが取れないと MUST の達成を証明できない）。
- cutover の D-(1) LP-as-proxy（`prod-bringup-cutover.md:169-179`）採用時に、`/api/tv/lp-config` で v2 コマンドキューを LP 形 `commands{}` に橋渡しする follow-up を実装（現状 TODO）。または当面はスケジュール（version 差分）だけで運用し、即時 ON/OFF は諦める旨を運用手順に明記。

---

### 要件 2 — タンパー耐性（リモコン/アプリ切替で改変させない）

**判定: UNVERIFIABLE-FROM-CODE**

kiosk lockdown（screen pinning / lock task mode）、ホームアプリ化（HOME intent 奪取）、ランチャー無効化、起動時自動起動（`BOOT_COMPLETED`）、リモコンキー無効化 — これらは**すべて Android アプリの manifest・コードと端末（Google TV）側の設定**で実現するもので、本マシンにソースが無いため確認不能。

サーバ側に残る間接的痕跡:
- TV 常駐サービスを再起動するリモートコマンド `service_restart` が存在（`packages/db/src/_shared/enums.ts:45,48-53`、UI ラベル「サービス再起動」`lib/tv/command-core.ts:34`）。→ 常駐サービスとして動く設計であることは示唆されるが、kiosk ロックの有無は別問題。
- `BootReceiver`（`BOOT_COMPLETED` で起動報告）への言及: `F16:68`。→ 起動時自動起動の意図はあるが実装未確認、かつサーバ側受信口（`POST /api/tv/heartbeat`）は**未実装**（`F16:3,68,91`）。

**修正案**: `edix-lp` の `AndroidManifest.xml` を入手し、(a) `LAUNCHER` + `HOME` カテゴリ（デフォルトランチャー化）、(b) `lockTaskMode` / screen pinning、(c) `RECEIVE_BOOT_COMPLETED` + 起動レシーバ、(d) device owner / MDM（Android Management API）による kiosk 強制、の有無を確認する。ソロ運営かつ少数台なら、最低限「アプリを HOME に設定 + 設定アプリへの導線を物理的に塞ぐ（リモコン回収 or 物理カバー）」を運用で担保し、台数が増えたら Android Management API による完全 kiosk を検討。

---

### 要件 3 — 夜間バックライト（真の消灯 vs 明るい黒画面）

**判定: FAIL（設計上の限界。複数台展開で苦情リスク）**

- OFF の実体は**黒画面**であってバックライト消灯ではない: `tv-devices.ts:77-78`、`F16:33`。液晶 TV の黒画面はバックライトが点灯したままなので、暗い教室・廊下では「画面が薄く光る」状態になり得る。
- **輝度/バックライト制御の口がサーバ・スキーマ・コマンド enum・UI のどこにも無い。** `TvSchedule`（`tv-devices.ts:76-88`）に brightness 等のフィールド無し。リモートコマンド enum（`enums.ts:48-53`）は `signage_reload/open/exit/service_restart` のみで、輝度・電源・スリープ系コマンドは皆無。
- 真の消灯（パネル電源 OFF）は要件 1 と同じくポーリング片方向性ゆえ困難。`commands.wake` は逆方向（スリープ抑止の再適用）で、消灯用ではない（`wake-tv.mjs:4-6`）。

**修正案（影響度順）:**
1. 物理タイマー/スマートプラグ（例: SwitchBot プラグ）で**主電源そのもの**を時刻で入り切りする（コード不要・最も確実に「真っ暗」）。ただし朝の自動 ON が必要で、ここで初めて「SwitchBot で電源 ON」が意味を持つ（現状コード未実装＝手動運用）。
2. TV アプリ側で OFF 時に `WindowManager.LayoutParams.screenBrightness=0` を適用し、可能なら HDMI-CEC / メーカー API でパネルスタンバイに入れる（TV アプリ改修。要 `edix-lp`）。
3. 設置場所を「夜間に人が通らない/光が気にならない」場所に限定する運用回避。

---

### 要件 4 — 初回タッチ後はリモート完結

**判定: PARTIAL**

**リモートで変更可能（初回後の現地不要）:**
- `signage_url`（表示 URL／クラス変更）: 編集 UI `TvConfigEditForm.tsx:113-123` + Server Action（`lib/tv/config-edit-actions.ts`）、検証 `config-edit-core.ts:382-450`。
- `schedule_json`（曜日・時刻）: 要件 1 参照。
- `target_mac`（センサー交換）: `TvConfigEditForm.tsx:137-148`。
- `webhook_url`: `TvConfigEditForm.tsx:125-135`。
- リロード/強制起動/強制終了/サービス再起動: コマンドキュー `tv_device_commands`（`F15:119-120`、enum `enums.ts:48-53`、UI `command-core.ts:30-43`）。
  - ⚠️ **ただし cutover で実機を v2 に向けた後、これらコマンドは LP 互換層で届かない**（要件 1 参照、`lp-compat.ts:92`）。実質「config（url/schedule/mac）はリモート可、コマンドは現状 v2 ネイティブ形を解釈する端末でないと不可」。

**現地/ADB が必須（依頼の `config_endpoint` 確認）:**
- 🔴 **ポーリング先 URL（`config_endpoint`）と焼き込み鍵はリモート更新不可。** `docs/runbooks/cutover.md:40`「`config_endpoint` はリモート更新不可のため物理/ADB 必須」、:69「各 TV を **ADB** で `webhook_url` / `config_endpoint` を v2 サブドメイン + 新キーへ更新」、:94「`config_endpoint` はリモート更新不可 → **ADB で物理復旧**が必須」。
- 🔴 **TV に焼き込まれた共有鍵（key=SWITCHBOT_WEBHOOK_SECRET）もリモート変更不可。** `prod-bringup-cutover.md:157`「起動時に焼き込まれた key … TV の LAN に入れない以上**リモートで変更できない**」、:161「鍵ローテーションには各端末の再構成（ADB/MDM）が要る」。→ だから cutover は「鍵を変えず、ドメイン/プロキシ側で v2 を返す」方式（`prod-bringup-cutover.md:155-161, D 章`）。

**結論**: 日常運用（URL・スケジュール・センサー MAC）はリモート完結できるが、(a) ポーリング先 URL の変更、(b) 鍵ローテーション、(c) アプリ更新（OTA、後述）、(d) cutover 後の即時コマンド、は現地/ADB か別経路が必要。よって **PARTIAL**。依頼文の「`config_endpoint` はリモート更新不可」は **確認済（正しい）**。

**修正案**: `config_endpoint` を「焼き込み固定値」ではなく「初回プロビジョン時に取得し、以後はサーバ応答で上書き可能」な設計に TV アプリ側で変更する（要 `edix-lp` 改修）。当面の cutover はドメイン側で吸収する現行方針（LP-as-proxy）が現実解。鍵は `F15:58,137-138` の `tv_device_tokens`（TV 個別トークン、ハッシュ保存、失効/ローテーション）を実装すれば共有鍵の限界を解消できる（現状**未実装**、共通シークレット `TV_POLL_SECRET` 段階）。

---

### 要件 5 — その他の kiosk チェック

| 観点 | 判定 | 証拠と所見 |
|---|---|---|
| **死活監視 / heartbeat（last_seen）** | **PASS（サーバ側）** | ポーリングが `last_seen_at` を更新（`route.ts:63-70`、`tv-devices.ts:120-121`）。定期チェッカが `now - last_seen_at > 3分` で down 判定し `tv_device_downtime` 記録（`F16:55-62`、`packages/db/src/queries/tv-liveness.ts`、Cloud Run Job 実装 `apps/jobs/src/tv-liveness/`）。OFF 時間帯は閾値 30 分に緩和（`F16:63`）。一覧 UI に🟢/🟡/🔴表示（`tv-devices/page.tsx:48-51,146-152`）。 |
| **down アラートの実配信** | **FAIL（未実装）** | `alert_state` 反転とログのみ。Sentry/メール等の**実通知は未実装**（`F16:3,75-79`、`apps/jobs/src/tv-liveness/run.ts` コメント「アラート配信は follow-up」）。→ down を検知しても founder に**自動で通知が飛ばない**。ダッシュボードを能動的に見る必要あり。 |
| **チェッカ自体の死活（dead-man's-switch）** | **FAIL（未実装）** | cron が止まっても気づけない問題が未対処（`F16:64`）。 |
| **起動報告 / reboot 検知** | **PARTIAL** | `cause_hint='reboot'` 推定ロジックはある（`F16:70`）が、それを駆動する `last_boot_at` を埋める受信口 `POST /api/tv/heartbeat` が**未実装**（`F16:3,68,91`）。→ reboot 判定は現状実効しない。 |
| **自動再起動（クラッシュ/再起動からの自己復帰）** | **UNVERIFIABLE-FROM-CODE** | `service_restart` コマンド（`enums.ts:48`）と `BootReceiver`（`F16:68`）の言及はあるが、watchdog/自動起動は TV アプリ側。ソース無し。PoC では「プロセス kill→10 秒後復帰確認」をチェックリスト化（`kimiteras-lp/docs/POC_OPERATIONS.md:211`）しているが、これは BLE Recorder（PC/Pi 側）の話で TV アプリではない。 |
| **ネットワーク断時の挙動 / オフラインキャッシュ** | **UNVERIFIABLE-FROM-CODE** | TV アプリの WebView がオフラインで最後の signage を保持するか不明。サーバ側は一時 DB エラー時 500 を返し「TV は次のポーリングで自然回復」と想定（`route.ts:83-86`）。LP 構成は「学校 Wi-Fi 不安定前提でローカルファースト」志向（`POC_OPERATIONS.md:27`）だがこれもセンサー側。 |
| **OTA アプリ更新** | **FAIL（未整備）** | 「TV ファームウェアアップデート配布（APK 配信パイプライン）」は将来拡張で未着手（`F15:197`、`F16` 将来拡張）。→ アプリ更新は各端末 ADB sideload が必要（現地作業）。 |
| **時刻 / タイムゾーン** | **PARTIAL** | スケジュールは JST 前提（`tv-devices.ts:80,84`）。サーバ表示も `Asia/Tokyo` 固定（`tv-devices/page.tsx:183`）。TV 端末の時計が JST に合っているかは端末設定依存（未確認）。NTP/時計ズレ対策はコードに無い。 |
| **音声デフォルト OFF** | **UNVERIFIABLE-FROM-CODE** | WebView/メディアの音量は TV アプリ側。サーバに音声制御なし。 |
| **証明書 / HTTPS** | **PASS（前提）** | 配信は `https://app.school-signage.net`（`seed-ginan-signage.ts:38`）。編集 URL は http(s) 必須 + SSRF ガードで内部アドレス拒否（`config-edit-core.ts:115-160,204-218`）。県教委 Wi-Fi は FQDN フィルタ、サードパーティはサーバ側経由（`wifi-filter-method.md:25-29`）。 |
| **秘密の扱い（最大の運用リスク）** | **FAIL（要対処）** | 🔴 **単一の共有シークレット `SWITCHBOT_WEBHOOK_SECRET` が「読み取り（統計）+ 書き込み（設定改ざん）+ TV 制御（wake/reload/signage_url 書換）」をすべて兼ねる**（`kimiteras-lp/app/api/tv/config/route.ts:13-20` の `isAuthorized`、POST も同鍵 :124-127）。さらに**この鍵が公開 GitHub リポジトリの履歴に平文コミットされている**（`kimiteras-lp/docs/AUDIT-2026-06-09.md:84-104`、流出元 `docs/POC_OPERATIONS.md:146`）。→ 第三者が稼働中 TV のスケジュール改ざん・signage_url 書換が可能。**鍵ローテーション必須**だが、TV 焼き込み鍵ゆえローテーションには各端末再構成が要る（要件 4 の制約）。v2 は `TV_POLL_SECRET` を Secret Manager 管理 + 定数時間比較 + fail-closed（`route.ts:53-61`、`F15:75`）に改善済だが、依然**全 TV 共通の単一鍵**（TV 個別トークン `tv_device_tokens` は未実装、`F15:58,137`）。 |
| **テナント分離（RLS）** | **PASS** | `tv_devices` は school_id で RLS（`tv-devices.ts:49-53`、`migrations/0016_tv_devices_rls.sql`）。ポーリングは system_admin context で cross-tenant 解決し BYPASSRLS 不使用（`F15:90`）。device_id はグローバル一意でテナント越境配信を構造的に防止（`tv-devices.ts:42-47,141`）。 |
| **レート制限** | **PASS** | device_id 単位 1 分 5 回、超過 429（`route.ts:44-51`、`F15:92`）。 |
| **監査ログ** | **PASS（設定変更）** | 設定変更・コマンド発行は `audit_log` に記録（`F15:118,143`）。ただしソフトデリート UI 自体が未実装（`F15:121`）。 |

---

## Deliverable 2 — 新規モニタ オンボーディング手順（フラット状態から）

> **前提（必読）**: 以下は **v2 prod を正とする前提**の手順。ただし v2 prod は現時点で **Cloud Run / Cloud SQL 未構築**（`prod-bringup-cutover.md:34-38`「Cloud Run/SQL 無し・確認済」）。本番は今も **LP（`www.school-signage.net` / Turso）が稼働中**。よって「今すぐ 1 台足す」を LP 側でやる場合と、v2 prod を建ててからやる場合で分岐する。本手順は依頼に従い **v2 prod 版**を主とし、LP 即時運用は注記する。
>
> **依存（重要）**: 正規の `signage_url` は `https://app.school-signage.net/signage/<token>`（`seed-ginan-signage.ts:38,57-63`）。**`app.school-signage.net` が v2 を指していること**が前提。これは現在 cutover 進行中（`docs/runbooks/cutover.md`, `prod-bringup-cutover.md` の D 章）。cutover 前は LP が解決するため、v2 で発行した magic-link 形 URL を実機に出すには cutover 完了が条件。

### 凡例: 【現地/物理】＝学校で手を動かす / 【リモート】＝どこからでも可

### フェーズ A — ハードウェア / Google TV 初期設定 【現地/物理】

1. 【現地】Google TV 端末を設置し電源・HDMI を接続。教室の Wi-Fi（県教委ネットワーク）に接続する。
   - 県教委 Wi-Fi は FQDN 許可制。`app.school-signage.net` は許可済（`wifi-filter-method.md:9`）。新サブドメインを足すと別途申請が要る（同 :19）ので増設時も同一ドメイン配下に寄せる。
2. 【現地】Google TV の初期セットアップ（Google アカウント、地域=日本、**時刻を自動（NTP）/ タイムゾーン=JST** に設定）。スケジュールが JST 前提（要件 5 時刻欄）。
3. 【現地】ディスプレイのスリープ/スクリーンセーバを可能な限り無効化。TV 本体に**電源オフタイマー機能がある場合は必ず OFF**にする（PoC で 1 年機がこれで勝手に消えた実績: `F16:20`）。

### フェーズ B — tvbridge アプリの導入（sideload） 【現地/物理】

> ⚠️ **APK の所在はこのマシンに無い**（§0）。APK は `edix-lp` リポジトリのビルド成果物、または別途保管されているはず。入手が前提。OTA 配信パイプラインは未整備（`F15:197`）なので**現状は手動 sideload のみ**。

4. 【現地】`com.kimiterrace.tvbridge` の APK を端末に sideload（USB / `adb install`、または提供元の配布手段）。
5. 【現地】アプリを kiosk として固定する（**TV アプリ側の機能、ソース未確認＝要 `edix-lp` 確認**）。想定: アプリをデフォルトの HOME（ランチャー）に設定し、screen pinning / lock task を有効化、`BOOT_COMPLETED` で自動起動。これらが効くかは実機確認必須（要件 2）。
6. 【現地】初回起動。**アプリが初回起動時に device_id（UUIDv4）を自動生成する**（`tv-devices.ts:94-98`、`F15:36,127`、LP 003 migration `device_id TEXT PRIMARY KEY -- TV が初回起動時に生成する UUIDv4`）。
7. 【現地】アプリにポーリング先（`config_endpoint`）と鍵（`key`）を設定する（焼き込み or 設定画面。**この値は後でリモート変更不可**＝要件 4）。
   - 現行: `https://www.school-signage.net/api/tv/config` + `key=<SWITCHBOT_WEBHOOK_SECRET>`。
   - v2 直結時: `https://app.school-signage.net/api/tv/lp-config`（LP 互換形）+ `key=<TV_POLL_SECRET>`（v2 native 形 `/api/tv/config` は camelCase で旧アプリが解釈不可: `prod-bringup-cutover.md:186`）。

### フェーズ C — device_id の取得 【現地 → リモート】

8. device_id は**アプリが自動生成**するため、人手で発番しない（フェーズ B-6）。取得方法:
   - 【リモート】端末がいったんポーリングを始めれば、サーバ側に「未登録ポーリング（`unknown`）」として現れる。LP なら一覧モード `GET /api/tv/config?key=<secret>`（`kimiteras-lp/app/api/tv/config/route.ts:54-73`）か `node scripts/wake-tv.mjs`（引数なしで一覧表示、`wake-tv.mjs:27-42`）で `device_id / label / last_seen` を確認。
   - v2 は未登録 device_id に `{unknown:true, version:0}` を返す（`route.ts:72-73`、`F15:93`）。
   - 【現地代替】`adb logcat` で生成された device_id を直接読む。

### フェーズ D — v2 `tv_devices` への登録 【リモート】

> v2 prod が建っている前提。3 つの登録手段がある。

**手段 (a): 管理 UI（推奨・少数台）**
9. 【リモート】`/admin/tv-devices/new` を開く（**system_admin 権限が必要**: `tv-devices/page.tsx:42-44`、`ONBOARDING_ROLES`）。フォーム `TvDeviceCreateForm.tsx`:
   - 設置先の学校（必須、:118-134）
   - device_id（フェーズ C で取得した実 UUID を入力。**空欄なら自動採番される**が、実機 cutover では必ず実機生成値を入れる: :136-147, :90-101）
   - 教室ラベル（例「電子工学科 1年」、:149-160）/ signage_url / webhook_url / target_mac / スケジュール（有効化・開始時・終了時、:199-236）/ 死活監視 ON
   - 登録すると採番 device_id が表示される（:91-112）。
   - ⚠️ 注: 要件 docs `F15:125-128` は登録 UI を「未実装」と書くが、**実際にはフォーム（`new/_components/TvDeviceCreateForm.tsx`）と Server Action（`lib/tv/onboarding-actions.ts`）がディスク上に存在する**。docs がやや古い。

**手段 (b): seed CLI（岐南工業を一括投入する初期構築向け）**
10. 【リモート】学校 → TV の順で実行（順序必須）:
    - 学校テナント: `kimiterrace-seed-ginan-sch`（`seed-ginan-school-cli.ts`）— 学校 + 電子工学科 + 1〜3 年 + 各 1 クラス作成（`prod-bringup-cutover.md:121-123`）。
    - TV デバイス: `kimiterrace-seed-ginan-tv`（`packages/db/src/seed-ginan-tv-devices-cli.ts`）。
      - 🔴 **本番では実機 device_id を必ず渡す。** 既定はプレースホルダ `0e1c000N-…`（`seed-ginan-tv-devices.ts:84-103`）。env **`SEED_GINAN_TV_DEVICES_JSON`** に `[{"grade":1,"deviceId":"<実UUID>","targetMac":"<実MAC>"},...]` を設定する（`seed-ginan-tv-devices-cli.ts:36-40,62-64`、`resolveGinanTvDevices` `seed-ginan-tv-devices.ts:195-236`）。未設定だとプレースホルダが入り、実機ポーリングが `unknown` になり無効（`prod-bringup-cutover.md:126-127`）。
      - 実行例: `DATABASE_URL=postgres://...(migrator DSN) node dist/seed-ginan-tv-devices-cli.js` か Cloud Run Job の command 上書き（同 cli :15-17）。
      - 冪等: `ON CONFLICT (device_id) DO NOTHING`（同 cli :141）。スケジュール既定は平日 08:00–17:00（`seed-ginan-tv-devices.ts:54-59`）。

**手段 (c): 直接 INSERT（migrator DSN + system_admin context）** — `prod-bringup-cutover.md:129`。緊急時のみ。

### フェーズ E — magic-link 発行 + signage_url 設定 【リモート】

11. 【リモート】各クラスのサイネージ表示 URL を発行する: `kimiterrace-seed-ginan-signage`（`packages/db/src/seed-ginan-signage-cli.ts`）。
    - 前提: フェーズ D で `tv_devices` 登録 + class_id 紐づけ済（`seed-ginan-signage-cli.ts:25-28`）。
    - 動作: クラスごとに magic-link を発行（32byte 乱数→base64url、DB には SHA-256 hash のみ保存: `seed-ginan-signage.ts:18-20,47-54`）、`tv_devices.signage_url = https://app.school-signage.net/signage/<token>` を UPDATE（`seed-ginan-signage-cli.ts:143-167`）。
    - TTL は既定 **3650 日（10 年）**＝サイネージは常時表示で失効事故を避けるため長寿命（`seed-ginan-signage.ts:23-24,40-41`）。env `SEED_GINAN_SIGNAGE_TTL_DAYS` で上書き可。
    - base は既定 `app.school-signage.net`、env `SIGNAGE_BASE_URL` で上書き可（`seed-ginan-signage.ts:37-38,69-82`）。
    - 冪等: 既に v2 形 signage_url が入っていれば skip（トークンを churn しない、:136-141 / `seed-ginan-signage.ts:105-111`）。**通常 1 回だけ実行**（:38）。
    - 実行例: `DATABASE_URL=postgres://...(migrator DSN) node dist/seed-ginan-signage-cli.js`（:20-21）。
    - 個別調整は管理 UI 編集フォームで signage_url を直接設定/上書きも可（`TvConfigEditForm.tsx:113-123`）。

### フェーズ F — TV を本番（v2）に向ける 【リモート（ドメイン側）/ 場合により現地】

12. cutover 方式（`prod-bringup-cutover.md` D 章）:
    - **D-(1) LP-as-proxy（推奨・端末ゼロ操作・リモート）**: LP（`edix-lp`）の `app/api/tv/config` を v2 `/api/tv/lp-config` へ forward するよう編集して Vercel 再デプロイ（:169-179）。実機は今まで通り `school-signage.net/api/tv/config` を叩き、v2 互換応答を受ける。**人間による Vercel デプロイが必要**。
    - **D-(2) DNS repoint**（お名前.com で v2 Cloud Run に向ける）: パス整形（`/api/tv/config`→`/api/tv/lp-config`）の追加実装が要る（:181-189）。
    - 鍵: prod の `prod-tv-poll-secret` を **LP の `SWITCHBOT_WEBHOOK_SECRET` と同値**にする（焼き込み鍵を変えられないため。:155-161）。
    - 新規端末をいきなり v2 直結にするなら【現地】でフェーズ B-7 の `config_endpoint` を `app.school-signage.net/api/tv/lp-config` に設定する（焼き込み）。

### フェーズ G — SwitchBot（人感センサー）ペアリング 【現地/物理】※TV 電源用ではない

> ⚠️ SwitchBot は**来場検知の PIR 人感センサー**用であって TV 電源制御ではない（§0.2）。要件上「power」と無関係。設置するなら:

13. 【現地】SwitchBot アプリで Hub 2 を学校 Wi-Fi に接続、PIR センサーをペアリング、「クラウドサービス」を有効化（`SWITCHBOT_SETUP.md:42-55`）。センサーの MAC を控える（`tv_devices.target_mac` に入れる値）。
14. 【リモート】SwitchBot Cloud Webhook を登録: `ACTION=setup SWITCHBOT_TOKEN=.. SWITCHBOT_SECRET=.. WEBHOOK_URL=https://<host>/api/.../webhook?key=<secret> node scripts/setup-switchbot-webhook.mjs`（`setup-switchbot-webhook.mjs:43-47`、`SWITCHBOT_SETUP.md:155-186`）。Webhook はアカウント全体で 1 本、`device_mac` で教室識別（同 :257-262）。
   - **もし「夜間に主電源を物理 OFF / 朝 ON」したいなら**、別途 SwitchBot プラグ等を導入し SwitchBot アプリのスケジュール機能で入り切りする（コード非依存の手作業。現状自動化コードは無い＝要件 3 の修正案 1）。

### フェーズ H — 動作検証 【リモート + 現地】

15. 【リモート】v2 管理 UI `/admin/tv-devices` を開く。当該端末の `last_seen`（最終ポーリング）が更新され、ステータスが🟢になることを確認（`tv-devices/page.tsx:48-51,145`）。最大 60 秒で反映。
16. 【リモート】手元から互換エンドポイントを叩いて応答確認（`prod-bringup-cutover.md:206-211`）:
    `curl "https://<host>/api/tv/lp-config?device_id=<実device_id>&key=<secret>"` → `200` / `{version, config:{signage_url, schedule:{days_mask,...}}, commands:{}}`。`{version:0, config:null}` が返るなら**登録漏れ**（device_id 不一致）。
17. 【現地 or 既存監視】物理画面に正しい signage が表示されていること、スケジュール時刻で黒画面になることを確認（黒画面の実描画は TV アプリ依存＝要件 1）。
18. 【リモート】設定変更が通ることを確認: UI でスケジュールを 1 つ変えて保存 → `version`+1 → 次ポーリングで反映。

### 「現地/物理」と「リモート」の境界まとめ

| 作業 | 区分 |
|---|---|
| 設置・配線・Wi-Fi 接続・時刻 JST 化・TV オフタイマー無効化 | 【現地】 |
| APK sideload・kiosk 固定・初回起動・`config_endpoint`/`key` 焼き込み | 【現地】（OTA 未整備のためアプリ更新も毎回現地） |
| SwitchBot Hub/センサーのペアリング・物理設置 | 【現地】 |
| device_id 取得 | 端末がポーリング開始後は【リモート】（一覧/ログ）。初回は【現地】logcat でも可 |
| tv_devices 登録（UI / seed CLI / 直 INSERT） | 【リモート】 |
| signage_url 発行・schedule・target_mac・webhook 変更・リロード | 【リモート】 |
| `config_endpoint`（ポーリング先 URL）・焼き込み鍵の変更 | 🔴【現地/ADB】（リモート不可） |
| cutover（v2 へ向ける） | LP-as-proxy なら【リモート（Vercel デプロイ）】 |
| 動作検証 | 【リモート】（last_seen）+ 【現地】（画面目視） |

---

## 付録: 参照した主なファイル（file:line は本文参照）

- v2 ポーリング: `apps/web/app/api/tv/config/route.ts`、`apps/web/app/api/tv/lp-config/route.ts`、`apps/web/lib/tv/lp-compat.ts`、`apps/web/lib/tv/poll-secret.ts`、`apps/web/lib/tv/rate-limit.ts`
- v2 スキーマ/型: `packages/db/src/schema/tv-devices.ts`、`packages/db/src/_shared/enums.ts`
- v2 管理 UI: `apps/web/app/admin/tv-devices/page.tsx`、`.../new/_components/TvDeviceCreateForm.tsx`、`.../[deviceId]/edit/_components/TvConfigEditForm.tsx`、`apps/web/lib/tv/config-edit-core.ts`、`apps/web/lib/tv/command-core.ts`
- v2 seed/CLI: `packages/db/src/seed-ginan-tv-devices.ts` / `-cli.ts`、`packages/db/src/seed-ginan-signage.ts` / `-cli.ts`
- v2 docs: `docs/runbooks/prod-bringup-cutover.md`、`docs/runbooks/cutover.md`、`docs/requirements/functional/F15-tv-device-management.md`、`F16-tv-uptime-monitoring.md`、`docs/discovery/wifi-filter-method.md`、`CLAUDE.md`
- 現行 LP: `kimiteras-lp/app/api/tv/config/route.ts`、`kimiteras-lp/lib/sensor-db.ts`、`kimiteras-lp/migrations/003_multi_device.sql`、`kimiteras-lp/scripts/{wake-tv,set-tv-schedule,setup-switchbot-webhook}.mjs`、`kimiteras-lp/docs/{POC_OPERATIONS,SWITCHBOT_SETUP,AUDIT-2026-06-09}.md`
- TV アプリ本体: **不在**（`edix-lp` の `ConfigPoller.kt` / `BootReceiver` / `AndroidManifest.xml`、要入手）

*— READ-ONLY 監査。本書の修正提案は未適用。*
