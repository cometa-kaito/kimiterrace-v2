# 現地プロビジョニング フロー（ワイヤレスadb基本）+ SwitchBotセンサー設定フロー

- 作成: 2026-06-09
- 前提（解消済）: `app.school-signage.net` → v2 切替・検証済（`/api/health` 200・`/signage` 200・`/api/tv/lp-config` 401）。学校Wi-Fiが通す唯一のFQDN。
- 新TV鍵: `prod-tv-poll-secret`(version3) を v2 が検証中。取得 = `gcloud secrets versions access latest --secret=prod-tv-poll-secret --project=signage-v2-prod`。
- APK: `…/tv-ble-bridge/dist/v2-build/tv-ble-bridge-debug.apk`（既定で v2 lp-config を向く・debug署名＝run-as 可）。
- 役割: 【現】=現地で実機/リモコン操作（あなた） / 【私】=このPCから wireless adb で実行。
- 出典: `tv-ble-bridge/dist/provision-googletv.md`, `kimiteras-lp/docs/SWITCHBOT_SETUP.md`。

---

## フローA — モニタ新規プロビジョニング（ワイヤレスadb・Device Ownerキオスク）

### A-0. 接続前提（ワイヤレスadbの肝）
- **このPC（私が動く端末）と TV を同じ校内LANに接続**する。`adb connect <TV_IP>:5555` で繋ぐ。
- ⚠️ 校内Wi-Fiが**クライアント分離(AP isolation)**だとPC↔TVが届かずwireless adb不可。その場合のみ**USBケーブル**にフォールバック（`adb devices`で出る）。最初に1台で疎通確認する。

### A-1.【現】TVを工場リセット＆アカウント無しで初期設定
1. factory reset。
2. 初期設定で **Wi-Fi接続するが Googleアカウント追加はSKIP**（Device Owner化の必須条件＝アカウント0）。
   - スキップしづらい機種: セットアップ中に一旦ネットを切る→アカウント手順を飛ばす→再接続、等（provision §1）。
3. 開発者オプション有効化: 設定→システム→デバイス情報→「Android TV OS ビルド」を**7回タップ**。
4. 開発者向け→**USBデバッグON**＋**ネットワークデバッグ(ADB over network / 5555)ON**。
5. **TVのIPを控える**（設定→ネットワーク→接続中Wi-Fi）。→ 私に伝える。
6. （オフタイマー無効化は【私】がadbで代行：A-5参照。あなたの手作業は不要）

### A-2.【私】wireless adb 接続 →【現】許可ダイアログ承認
- 私: `adb connect <TV_IP>:5555`
- 現: TV画面の「USBデバッグを許可しますか？」を**リモコンで許可（常に許可ON）**。
- 私: `adb devices -l` で `device` 表示を確認（`unauthorized`なら↑の許可待ち）。

### A-3.【私】APK導入 → Device Owner昇格
```
adb install -r <repo>/tv-ble-bridge/dist/v2-build/tv-ble-bridge-debug.apk
adb shell dpm set-device-owner com.kimiterrace.tvbridge/.TvDeviceAdminReceiver
adb shell dpm list-owners   # device owner に出れば成功
```
- 失敗`already some accounts`→A-1へ（アカウント削除or再factory reset）。

### A-4.【私】設定(prefs)書き込み（config_endpoint＝v2＋新鍵）
prefs XML（Temp等の非追跡領域に作成 → base64でrun-as書き込み, provision §4(b)）の要点:
- `config_endpoint` = `https://app.school-signage.net/api/tv/lp-config?key=<新prod-tv-poll-secret>`
- `device_id` = 空でも可（アプリが初回UUID発行→A-7で登録）。事前seed運用なら該当device_idを記入。
- `signage_url` = ブートフォールバック（device_id一致後はlp-configが返す値で上書き）。
- `target_mac` = センサーMAC（フローB。後から v2 管理UIで遠隔変更可）。

### A-5.【私】権限付与・no-sleep・オフタイマー無効化（provision §5,§6）
- 権限: BLE位置情報 / WRITE_SECURE_SETTINGS / SYSTEM_ALERT_WINDOW / Doze除外。
- Android標準 no-sleep: `settings put` で hdmi_control_auto_device_off_enabled=0 / no_signal_auto_power_off=0 / screen_off_timeout=max / sleep_timeout=-1 / screensaver_enabled=0 / stay_on_while_plugged_in=7。
- **メーカーfirmwareオフタイマー無効化（私がadbで代行・あなたの手作業不要）**:
  1. `adb shell getprop ro.product.model` で機種特定。
  2. `adb shell settings list {global,system,secure} | grep -iE "timer|sleep|power|auto.*off|standby"` で該当キー探索→`settings put`で無効化。
  3. UIメニュー専用の場合: `adb exec-out screencap -p > screen.png`（私が画面確認）＋`adb shell input keyevent`（DPAD/ENTER）でTV設定メニューを操作しオフタイマーをOFF。
  - 例(ORION AI PONT)=16:30電源OFFタイマーが効いていた実績。これを確実に潰す。

### A-6.【私】起動
```
adb shell am start -n com.kimiterrace.tvbridge/.MainActivity   # clean install直後は必須(BOOT_COMPLETED配信のため)
adb shell am start -a com.kimiterrace.tvbridge.OPEN_SIGNAGE
```
Device Ownerなら `startLockTask()` でキオスク化（ホーム/戻るで抜けられない）。

### A-7.【私】v2登録 → signage_url 発行
- アプリが出した device_id が v2 に `unknown` ポーリングで現れる（`/api/tv/lp-config`）。
- `/admin/tv-devices/new`（system_admin）でその device_id を**クラスに紐付け登録**。
- `kimiterrace-seed-ginan-sig` Job で magic-link発行＋`signage_url`焼込（`app.school-signage.net/signage/<token>`・10年・冪等）。

### A-8.【私＋現】検証
- 私: `/admin/tv-devices` で 🟢（last_seen更新）。`curl "https://app.school-signage.net/api/tv/lp-config?device_id=<id>&key=<新鍵>"` → 200+config。
- 現: 画面にサイネージ表示／スケジュールOFF時刻に黒画面（Device Ownerならバックライト実消灯）。
- 私: UIでスケジュールを1つ変更→version+1→60秒以内に反映、を確認。

> 夜間消灯: Device Owner化で `lockNow()`＝バックライト実消灯（現行ソフトの最大配慮）。lockNow非対応機種は黒オーバーレイ(輝度0)＋TV本体タイマー無効化で代替。

---

## フローB — SwitchBot 人感センサー（PIR）設定
> 現状は「保留（センサーがすぐ外れる）」判断。再開時の手順として記録。出典 `SWITCHBOT_SETUP.md`。
> センサー検知の経路は2系統: **(B-1) TVアプリのBLE直接スキャン**（`target_mac`・Hub不要）と **(B-2) SwitchBot Hub2→クラウド→webhook**。

### B-1.【現】物理セットアップ（共通）
1. PIRセンサーに電池(CR2450×2)。SwitchBotアプリでペアリング。
2. （クラウド経路を使うなら）Hub 2 を学校Wi-Fiに接続しペアリング、センサーの「クラウドサービス」を有効化。
3. **センサーのMAC（`DC:xx:..`形式）を控える** → これが識別キー。

### B-2.（経路①推奨・v2ネイティブ）TVアプリのBLE直接スキャン
- 控えたMACを **v2管理UI `/admin/tv-devices/[id]/edit` の `target_mac`** に設定（**遠隔設定可**＝ご要望の「後日リモートでMAC設定」はこれで実現）。
- 次回ポーリング(60秒)でTVアプリのBLEスキャナが対象MACを拾い、`webhook_url`へPOST。Hub2不要。

### B-3.（経路②・クラウドwebhook）SwitchBot Cloud → webhook
1. SwitchBotアプリ→プロフィール→設定→アプリバージョンを10回タップ→開発者モード→**トークン/シークレット**取得。
2. Webhook登録（`setup-switchbot-webhook.mjs` か API直叩き）:
   - URL = `https://app.school-signage.net/api/...webhook?key=<鍵>`（v2移行時はv2の受け口に。現行LPは `www.school-signage.net`）。
   - Webhookはアカウント全体で1本、`device_mac`で教室識別（複数台は管理表で対応）。
3. 検知テスト→`/api/sensor-stats?key=...&hours=1` の totalEvents 増加で確認。

### B-4. 再開時の必須対応（セキュリティ）
- 旧 `SWITCHBOT_WEBHOOK_SECRET`（公開履歴に流出済・新鍵へ移行中）と **Turso `TURSO_AUTH_TOKEN` をローテ**してから本稼働。
- センサーDBをv2へ寄せるか(LP/Turso廃止)、当面LPで受けるかは別途判断。

---

## 今夜の最短チェックリスト
- [ ]【現】TV factory reset → Wi-Fi（アカウントSKIP）→ 開発者/USB/ネットワークデバッグON → IP控える → TVオフタイマー無効化
- [ ]【現】このPCを同じ校内Wi-Fiに接続（or USB接続）
- [ ] IPを私に伝える → 【私】`adb connect` 〜 install 〜 device-owner 〜 prefs(新鍵) 〜 起動 〜 v2登録 〜 表示確認
- [ ] 1台で疎通OK後、残りを同手順で

---

## 今夜1台目 実行手順（ホットスポット経由・③・確定版）
接続方式: **PCとTVを同じスマホ・テザリング/ホットスポットに接続** → wireless adb（PCは県Wi-Fiに入れない / TVはUSB-device adb不可のため）。最終表示は県Wi-Fi。
`adb` フルパス: `/c/Users/20051/AppData/Local/Microsoft/WinGet/Packages/Google.PlatformTools_*/platform-tools/adb.exe`（環境変数 `ADB` に入れて使用）。

### 持ち物 / 現地で先にやること
- スマホ（テザリング）、USB-Cまたは電源、リモコン。
- 【現地】① TVのWi-Fi設定で**県の値を控える/写真**: 静的IP・GW・サブネット・DNS・**プロキシ(host:port or PAC)**・MAC設定（「デバイスのMACを使用」かランダムか）。
- 【現地】② TVを**テザリングに接続** → 設定→システム→デバイス情報→ビルド7回タップ→開発者向け→**USBデバッグ＋ネットワークデバッグ(5555)ON** → **TVのIPを私に伝える**。

### preflight（私・接続＆MAC判定）
```
ADB="/c/Users/.../platform-tools/adb.exe"
$ADB connect <TV_IP>:5555 ; $ADB devices -l                 # device 表示（unauthorizedならTVで許可）
$ADB shell getprop ro.product.model                          # 機種
$ADB shell cmd wifi get-factory-mac                          # ハードMAC ← 県の控えMACと比較
$ADB shell cmd wifi list-networks ; $ADB shell dumpsys wifi | grep -iE "ip|proxy|mac" | head  # 県設定の裏取り
```
→ **県MAC = factory-MAC（デバイスMAC運用）なら③安全**。不一致(ランダム)なら警告 → **①LP-as-proxyへ切替**。

### 物理（あなた）
- ③ factory reset → セットアップで**テザリングに接続・Googleアカウントは追加しない** → 開発者/USB/ネットワークデバッグON → 新IPを私に。

### provisioning（私）
```
$ADB connect <NEW_IP>:5555
$ADB install -r ".../tv-ble-bridge/dist/v2-build/tv-ble-bridge-debug.apk"
$ADB shell dpm set-device-owner com.kimiterrace.tvbridge/.TvDeviceAdminReceiver ; $ADB shell dpm list-owners
# オフタイマー無効化（Android標準 + firmware探索）
$ADB shell settings put global hdmi_control_auto_device_off_enabled 0
$ADB shell settings put global no_signal_auto_power_off 0
$ADB shell settings put system screen_off_timeout 2147483647
$ADB shell settings put secure sleep_timeout -1 ; $ADB shell settings put secure screensaver_enabled 0
$ADB shell settings put global stay_on_while_plugged_in 7
$ADB shell settings list global | grep -iE "timer|sleep|auto.*off|standby"   # firmwareタイマー探索→個別put or screencap+keyevent
# device_id を取得（resetで新規生成される）
$ADB shell "run-as com.kimiterrace.tvbridge cat shared_prefs/tv_ble_bridge.xml" | grep device_id   # 無ければ起動後に生成
# prefs 書込（鍵はSecret Managerから取得し plaintext を echo しない）
KEY=$(gcloud secrets versions access latest --secret=prod-tv-poll-secret --project=signage-v2-prod)
#   → prefs.xml を Temp に作成（config_endpoint=https://app.school-signage.net/api/tv/lp-config?key=$KEY,
#     device_id=<新>, signage_url=<app.school-signage.net/signage/...>, target_mac=<県センサMAC>, autolaunch_signage=true）
#   → base64 → $ADB shell "run-as com.kimiterrace.tvbridge sh -c 'mkdir -p shared_prefs; echo <b64>|base64 -d > shared_prefs/tv_ble_bridge.xml'"
$ADB shell pm grant com.kimiterrace.tvbridge android.permission.ACCESS_FINE_LOCATION
$ADB shell appops set com.kimiterrace.tvbridge SYSTEM_ALERT_WINDOW allow
$ADB shell dumpsys deviceidle whitelist +com.kimiterrace.tvbridge
$ADB shell am start -n com.kimiterrace.tvbridge/.MainActivity ; $ADB shell am start -a com.kimiterrace.tvbridge.OPEN_SIGNAGE
```
> ⚠️ `gcloud secrets versions access`（本番鍵読取）が自動ガードで止まる場合は、あなたが同コマンドを実行して値を教えてください（私は値を表示せず prefs に注入）。

### 県Wi-Fi復帰（あなた）
- TVに**県Wi-Fiを追加**: 「デバイスのMACを使用」＋控えた**静的IP/GW/DNS/プロキシ** → 県に接続。

### v2登録＋signage_url（私・ブラウザ不要）
```
# 実 device_id で tv_devices 登録（seedにenvで実値投入）
gcloud run jobs update kimiterrace-seed-ginan-tv --project=signage-v2-prod --region=asia-northeast1 \
  --update-env-vars='SEED_GINAN_TV_DEVICES_JSON=[{"grade":1,"deviceId":"<新device_id>","targetMac":"<県センサMAC>"}]'
gcloud run jobs execute kimiterrace-seed-ginan-tv --project=signage-v2-prod --region=asia-northeast1 --wait
gcloud run jobs execute kimiterrace-seed-ginan-sig --project=signage-v2-prod --region=asia-northeast1 --wait
```

### 検証（私＋あなた）
```
KEY=...(同上) ; curl -s -w "\n%{http_code}\n" "https://app.school-signage.net/api/tv/lp-config?device_id=<新device_id>&key=$KEY"  # 200+config
```
- `/admin/tv-devices` で 🟢（last_seen更新）。画面に岐南サイネージ表示・スケジュールOFF時刻に黒画面（Device Ownerならバックライト消灯）。
- **失敗（県再接続不可）→ ①LP-as-proxy** にフォールバック（モニタを死なせない）。
