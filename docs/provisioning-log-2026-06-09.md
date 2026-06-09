# 実機プロビジョニング・ログ（2026-06-09 / 岐南 3台・③＋ホットスポットadb）

> 目的: 現地③（reset→Device Owner→v2）の**実体験を記録**し、(a) C自動化（provision-agent）開発の入力、(b) 今後の横展開の運用知、にする。
> 凡例: ✅ スムーズ / ⚠️ ハマり・要対応（こうせざるを得なかった） / 📌 確定した手順・教訓 / ❓未解決。
> 接続: PC＋TVを同じスマホ・テザリングに接続→wireless adb（PCは県Wi-Fi不可・TVはUSB-device adb不可）。最終表示は県Wi-Fi。

---

## 全体（共通の気づき）
- （実行しながら追記）

## 環境/前提（確定済）
- prod 稼働・`app.school-signage.net`→v2（DNS=Vercel管理）・新 `prod-tv-poll-secret` v3・登録Job `seed-ginan-tv`/`-sig`・adb v1.0.41（フルパス）。

---

## 1台目: 電子工学科2年 / IP=10.176.78.28（adbはホットスポット `Pixel_6653` 経由）
- 機種: **KONKA ASTEX 4K Android**（model `ASTEX 4K Android` / device `kenton` / `KKRTK2851_ASTEX`）, **Android 11 (API30)**。※docsのORIONとは別機種。
- 現状(reset前): tvbridge導入済・**Googleアカウント `kimiterasusignage@gmail.com` あり**（→`set-device-owner`不可＝Device Owner化にreset必須）。config_endpoint=**旧LP**(`www.school-signage.net/api/tv/config`・旧鍵)、signage_url=**旧v1形式**(`app.school-signage.net/?school=…`)＝**v2ドメイン上で404**（現表示は壊れている可能性大）。
- 旧device_id=`6c14d31f-b6fb-4dba-ac35-937c043bc9f4`（**reset後は再生成**→新IDを登録）。
- **MAC判定（最重要・🟢③安全）**: 県=`gifu-edu` の `macRandomizationSetting: 0`＝**デバイスMAC使用** → reset後「デバイスのMAC使用」で同一MAC → 県ホワイトリスト一致＝**再接続可**。（`get-factory-mac`はshell拒否だが設定0ゆえMAC値不要）
- **県(gifu-edu)設定キャプチャ（保険・reset後に再入力）**: 静的IP **172.16.20.202/24** / GW **172.16.20.40** / DNS **192.168.103.111, 192.168.103.115** / プロキシ=adb上は未検出（要UI確認）。
- device_id(reset後): （provision保留中）
- ⚠️🔴 **Device Owner化＝この機種では不可（確定・証拠あり）**: `ro.build.type=user` / `release-keys` / `debuggable=0`、`adb root`不可、`dpm set-device-owner` はクリーン状態（user 1台・アカウント0・既存admin/owner無し・receiver認識済）＋ `user_setup_complete=0`/`device_provisioned=0` に落としても**拒否**（DPMS理由ログも出ず＝ファーム封印）、さらに **`com.android.managedprovisioning` パッケージが全く存在せず QR/NFC プロビジョニングも不可**。→ 標準手段では一切DO化できない。`dpm set-active-admin` のみ成功（**active admin止まり**＝`lockNow`(夜間消灯)は効く可能性、`lock-task`キオスク固定は不可）。
- ⚠️🔴 **HOMEランチャー差し替え(C)も不可（確定・実機検証）**: APKにHOMEカテゴリ追加→再ビルド→install済で `tvbridge` はHOME候補に登録され `cmd shortcut get-default-launcher` も tvbridge を返すが、**`am start -c HOME` も genuine reboot(uptime34s確認)後も 実効HOMEは `com.google.android.tvlauncher` のまま**。`pm clear-package-preferred-activities`／`cmd role` は本機で Unknown command。→ **KONKAファームがランチャーをピン留め＝HOME差し替え不可**。
- 📌 **教訓（最重大・ハードウェア選定に直結）**: KONKA `ASTEX 4K`（brand `ASTEX`・`nosdcard,tv`・user/release build）は **DO も HOMEランチャー差し替えも両方ブロック ＝ ハードキオスクは本機では実現不可能**。
  - **DO（ハードキオスク）が必須なら機種選定が唯一の解**: 「setup前に adb `set-device-owner` が通る」or「`managedprovisioning` 搭載（QR enrollment可）」or「HOMEランチャー差し替えを許す（`set-home-activity`が実効）」端末を選ぶ。検収時に**1台で『reset→set-device-owner成功』or『HOME差し替えが実効』を確認**してから調達すべき。
  - 本機で**実現できる耐タンパー = A) `pm disable-user` で Settings/Store/YouTube等を無効化 + B) リモコン物理保管**。アプリは BootReceiver で自動起動・前面化・Backキー阻止、**夜間消灯は active-admin の `lockNow` で実効（DO不要・設定済）**。
  - C自動化(provision-agent)は preflight で「DO可否」「HOME差し替え可否」を実測し、不可機は **no-DO + A/B ハードニング**に自動フォールバック、要件次第で「非対応機」警告。
- ✅ ビルド環境: 日本語パス(`学校DX事業`)はAGPが拒否→**ASCIIパスにコピーしてビルド**で回避（`android.overridePathCheck`だけでは不十分、aapt2も嫌うためコピーが確実）。cached gradle 8.9 + JDK21(jbr) + Android SDK でローカルビルド可。
- ⚠️🔴 **再起動でアプリ自動復帰せず＋常駐サービスが死ぬ（実機検証・最重大）**: genuine reboot(uptime42s)後、**前面=`tvlauncher`**（tvbridgeが自動起動せず・appのBootReceiver発火痕跡なし）、**BleService非稼働**（電池最適化除外済でも）。`am start`後も75秒間 ConfigPoller/BleService の稼働痕跡ゼロ＝**設定/死活ポーリングが起動後すぐ停止し復帰しない**（v2側は18:27で last_seen 停止→🟡静穏）。表示は**手動起動時のみ**（SignageActivity前面＝WebViewの`/data`ポーリングで内容更新は動く）。OEMの自動起動マネージャは見当たらず＝**アプリ実装側の堅牢性問題の比重大**。
- 📌 **総合判定（KONKA ASTEX 4K・最重要）**: ①DO不可 ②HOME差替不可 ③reboot自動起動不可 ④常駐サービス維持不可（→liveness/夜間消灯スケジュール/設定sync が不成立）。**現状このハード+現アプリ版は「無人で確実に動き続けるサイネージ」には不適**。対策2系統:
  - (a) **アプリ堅牢化（C/新スレッドで実装）**: foregroundサービスをSTART_STICKY+堅牢化、BootReceiver確実発火（受信後すぐstartForegroundService）、watchdog/WorkManagerで死活再起動、ConfigPollerをサービスから分離 → **KONKAで再検証**（OEMブロックでなくapp起因なら解決の可能性大）。
  - (b) **DO/auto-start対応ハードへ変更**（最終手段）。
  - **検収基準**: 調達前に1台で『reset→DO成功 or HOME差替が実効 or 最低でも reboot後に自動でサイネージ復帰＋BleService継続＋last_seen更新』を確認する。
- ✅🟢 **解決: アプリ堅牢化で③④を解消（実機検証済 2026-06-09 19:13）**: 根本原因＝`BootReceiver`/`MainActivity` が **`webhook_url` 未設定だと BleService を起動しない**実装だった（センサ用webhookとConfigPoller常駐が密結合）。修正3点: (1) BootReceiver の webhook ゲート削除＝**boot時に必ず BleService 起動**、(2) MainActivity 同上、(3) BleService に `onTaskRemoved` 再起動追加（START_STICKY と二重化）。→ **genuine reboot後、手動起動なしで `BootReceiver: BOOT_COMPLETED` 発火→BleService 稼働継続(uptime196sでも健在)→ConfigPoller がv2ポーリング→`ScheduleManager.applyCurrentState` で時間帯に応じ黒画面/サイネージ**を確認。**③reboot自動復帰・④常駐ポーリング・夜間消灯スケジュール すべて成立**。
  - ⚠️ 残caveat: boot時の foreground-service-from-background は **location/BLE 権限を持てない**（Android11制約・ログに警告）→ **BLEセンサ受信はアプリを一度前面起動した時のみ**。ConfigPoller(HTTP＝設定/死活/スケジュール)は location 不要で boot時も動く。センサ運用クラスは「再起動後にアプリを一度開く」運用 or 将来 location-while-in-use 対応。
  - 📌 **結論更新: KONKAでも『no-DO + アプリ堅牢化』で「無人サイネージ＋夜間消灯(active-admin lockNow)＋死活監視」は成立**（DO/HOMEは依然不可だが、耐タンパーは A:不要アプリ無効化 + B:リモコン保管 で代替）。robust APK = `/c/tmp/tvbridge-build/app/build/outputs/apk/debug/app-debug.apk`（HOMEカテゴリ＋webhook非依存起動＋onTaskRemoved）。**1・3年もこの robust APK をinstall**。コード修正の本体は `tv-ble-bridge`（BootReceiver.kt / MainActivity.kt / BleService.kt）にも反映済→要commit/PR。
- ステップ結果（✅**2年 完了** 2026-06-09）:
  - connect/install: ホットスポット経由adb○ / robust APK install○
  - Device Owner: ✗不可（KONKAファーム封印）→ active-admin止まり（lockNow可）
  - prefs: config_endpoint=v2 lp-config＋新鍵○ / device_id=`e5e0a86a` / signage_url=2年(prefsフォールバック・v2側null)
  - 起動/キオスク/夜間消灯: **自動起動○（robust APK・reboot後BootReceiver発火を本番県ネットで実証）** / lock-taskキオスク✗(DO無) / **夜間消灯○（active-admin lockNow・schedule 8-17でBlackScreen）**
  - 県Wi-Fi復帰: ✅gifu-edu再接続完了。⚠️**reset で保存パスワードも消失→学校から再入手して接続**（adbでpw読めず＝reset前提の重大注意）。静的IP 172.16.20.202/24・デバイスMAC。
  - 耐タンパー: 不要アプリ(Store/YT/Netflix/media)無効化○ / Settings無効化は県切替でadb切れ未実施→**リモコン保管(B)**で代替
  - v2登録: seed-ginan-tv(device_id `e5e0a86a`)○ / lp-config 200○
  - 検証: ✅**県で reboot→自動起動→黒画面(時間外正常)→ポーリング🟢稼働中 確認＝完了**
- 📌 2年確定: **no-DO + robust APK で「自動起動・夜間消灯・死活監視」成立**。残follow-up: スケジュール7-17化・正規signage_url焼き直し（v2側）。
- ⚠️🔴 **reset の隠れ前提＝Wi-Fiパスワード**: factory reset は保存Wi-Fiパスワードも消す。adbでは読めない。**reset前にパスワードの入手可否を確認**。無いと県へ戻れず立ち往生（2年で発生・学校から入手して解決）。→ **1・3年はreset回避（no-reset repoint＋アカウントはSettingsで削除）**に方針変更。

## 2台目: 電子工学科1年 / IP=10.176.78.70（ホットスポット経由・**別メーカー**）
- 機種: **Changhong / ORION AI PONT（model AI_PONT・device longshan・brand ORION）**, Android11 user/release/debuggable=0。※docsが想定の"ORION"はコレ。2年KONKAとは別メーカー。
- **capability probe（ユーザー要望＝メーカー差で"やりたかったこと"が通るか非破壊検証）**:
  - DO: ✗（クリーン0アカウント＋user_setup_complete=0でも `set-device-owner` 拒否・`managedprovisioning`無し）＝**KONKAと同じ封印**
  - HOMEランチャー差替: ✗（set-home成功だが `am start -c HOME` は tvlauncher のまま＝**ピン留め**）＝KONKAと同じ
  - 📌 **結論: メーカーが違っても DO/HOME 両方ブロック＝廉価Google TV箱(user/release)共通の制約**。検証した価値＝"諦め"に確証。→ no-DO + robust APK で統一。
- 接続時すでに**クリーン**（tvbridge未導入・**0アカウント**・gifu-edu未保存）＝リセット済の状態。⚠️**そのため県の静的IPをキャプチャできず**（2年は reset 前に取得できた）。
- provisioning（2年と同一フロー・no-reset）: robust APK install○ / prefs(config_endpoint=v2+新鍵・device_id=`91bc4164-ccdb-43e6-9f50-bdea5935a8bd`・signage_url=`/signage/GsxLXAYlvEE6mTX7TN01mdomB2WXslKitZTxQIAFifY`＝**1年A組・HTTP200検証済**)○ / active-admin○ / no-sleep○ / 不要アプリ(vending/youtube/netflix/amazon)無効化○
- v2登録: seed-ginan-tv(device_id `91bc4164`・grade1・targetMac `DC:A5:B3:C2:98:D7`＝source検証済)○ / lp-config 200(label 1年・schedule)○・signage_url=null(2年同様dup起因→prefsフォールバックで表示)
- ✅ **reboot自動起動テスト合格（ORION）**: uptime33s後 BootReceiver発火→BleService onCreate→applyCurrentState OFF→BlackScreen。**robust APKはmake非依存で機能**。
- 表示: ✅ホットスポット上で1年A組サイネージ表示（SignageActivity）。
- ✅ **gifu-edu(県)接続完了**: 学校台帳の値で再追加→接続成功（**MAC一致確認**）。静的IP **`172.16.20.201`** / GW 172.16.20.40 / DNS 192.168.103.111,115 / **プロキシ `proxygate2.gifu-net.ed.jp:8080`（バイパス `*gifu-net.ed.jp,localhost`）** / デバイスMAC `28:7e:80:13:e1:5e`。
- ⚠️🔴 **県は認証プロキシ運用（最重要・runbook/C自動化へ）**: `proxygate2.gifu-net.ed.jp:8080`・バイパス `*gifu-net.ed.jp,localhost`。**app.school-signage.net はバイパス外＝プロキシ経由**（FQDN許可制はこのプロキシで実装と推定）。tvbridge(WebView＋okhttpはシステムプロキシ尊重)で動作。**gifu-edu再設定時はプロキシも必須入力**。台帳値はTVごと: 静的IP(1年`.201`/2年`.202`)・デバイスMAC(1年`28:7e:80:13:e1:5e`)はデバイス固有、GW/DNS/プロキシは共通。→ **reset時は「パスワード＋静的IP＋デバイスMAC＋プロキシ」を学校台帳から事前入手すべき**（adbで取れるのは静的IP/DNSのみ・pw/proxyは要台帳）。
- 📌 **トークン記録**: 1年=`GsxLXAYlvEE6mTX7TN01mdomB2WXslKitZTxQIAFifY` / 2年=`ojNOGwbWda7zSLTbwvl7pkREBCuD4PkrFEklcDe81OQ` / 3年=`hUhhEFDHpDhUUpEi4RLGPJFZi_Xu-aGrNjF292-_PWc`（90日トークン・要follow-upで10年化）。

## 3台目: 電子工学科3年 / IP=10.176.78.127（ホットスポット経由・**さらに別メーカー**）
- 機種: **HKC / 4K SA Google TV（model `4K SA Google TV`・brand `VEZZER`・device `lakeside`）**, Android11 user/release/dbg=0。2年KONKA・1年ORIONとも違う第3のメーカー。
- **capability probe（メーカー差の検証）— 🎉DO成功！**:
  - **Device Owner: ✅成功**（`Success: Device owner set to package ...TvDeviceAdminReceiver`）。クリーン0アカウントから `dpm set-device-owner` が**通った**＝**KONKA/ORIONと違いHKCはadb DOを許す**！
  - HOMEランチャー差替: ✗（`am start -c HOME` は `launcherx/VanillaModeHomeActivity` のまま＝ピン留め）。但しDOがあればlock-taskで代替できるのでHOME差替は不要。
  - managedprovisioning: 無し。
  - 📌 **最重要知見: メーカーでDO可否が分かれる**。KONKA(ASTEX)/ORION(AI PONT)=DO封印、**HKC(VEZZER/4K SA Google TV)=DO可**。→ **DOフルキオスクが要件なら HKC系を選定**。capability probe（reset/接続後に1台 `set-device-owner` 試行）が機種選定・検収に必須。
- provisioning（**DOフルキオスク**）: robust APK○ / DO set○ / prefs(config_endpoint=v2+鍵・device_id=`c6c8c16f-f5c9-4e6d-8a23-d205bb4be548`・signage_url=`/signage/hUhhEFDHpDhUUpEi4RLGPJFZi_Xu-aGrNjF292-_PWc`＝**3年・HTTP200検証済**)○ / 権限・no-sleep○
- v2登録: seed-ginan-tv(grade3・device_id `c6c8c16f`・targetMac `E2:E2:E8:85:3A:32`＝**ユーザー承認**)○ / lp-config 200(label 3年・schedule)○
- ✅ **キオスク実証**: 起動→SignageActivity前面→`mLockTaskModeState=LOCKED`＝**リモコンHOMEでも抜けられないハードキオスク**（3台で唯一）。夜間消灯はDO lockNow。
- ✅ **reboot自動復帰テスト合格（HKC・DO）**: uptime41s後 BootReceiver→BleService→applyCurrentState OFF→BlackScreen、**DO永続**。lock-taskはサイネージ表示中に発動（黒画面中はNONE＝正常）。
- ⏳ **pending: gifu-edu(県)** — 学校から「3年の静的IP（≒`172.16.20.203`）＋デバイスMAC」入手要（GW/DNS/プロキシ `proxygate2.gifu-net.ed.jp:8080` は1年と共通）。

---

## 確定手順（3台終了後にまとめる・C自動化へ反映）
- preflight / 物理依頼 / provisioning の各段で「実際に必要だった操作」を確定形に。
- 機種固有の罠（オフタイマー所在・lockNow可否・Device Owner昇格条件・県Wi-Fi再設定UI）。
- provision-agent（新スレッド）に渡す具体パラメータ・順序・冪等性の注意。

## メモリ化候補（durable lessons）
- （3台終了後、非自明で再利用価値のある教訓を `~/.claude/.../memory/` へ）
