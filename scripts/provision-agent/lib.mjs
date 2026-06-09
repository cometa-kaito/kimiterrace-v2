// @ts-check
/**
 * provision-agent の純粋ヘルパー（PR5）。
 *
 * このモジュールは **副作用ゼロ**: child_process / fetch / fs / gcloud を一切呼ばない。
 * 文字列・オブジェクトの整形だけを行い、I/O はすべて呼び出し側（provision-agent.mjs）に閉じる。
 * → 実機 adb / 実 API なしで vitest 単体テストできる（ルール7、CI で DB 不要）。
 *
 * セキュリティ（ルール5）: ここでは Secret Manager を呼ばない。TV ポーリング鍵は呼び出し側が
 * `gcloud secrets versions access prod-tv-poll-secret` で取得し、`config_endpoint` に埋め込んでから
 * `buildPrefsCommands` に渡す。本モジュールは鍵を「不透明な文字列」として扱うだけで、
 * 鍵単体を引数に取らない / ログ出力しない / steps_json 用の戻り値に載せない。
 *
 * adb 具体コマンド（オフタイマー無効化キー・prefs base64 run-as・no-sleep キー・起動 intent）は
 * tv-ble-bridge リポジトリの `dist/provision-googletv.md` §4/§5/§6/§7 を一次ソースとして写経している。
 */

/** TV ブリッジアプリのパッケージ id（tv-ble-bridge AndroidManifest applicationId）。 */
export const TV_BRIDGE_PKG = "com.kimiterrace.tvbridge";

/** Device Owner 昇格に使う DeviceAdminReceiver（`dpm set-device-owner <pkg>/<RECEIVER>`）。 */
export const TV_DEVICE_ADMIN_RECEIVER = ".TvDeviceAdminReceiver";

/** prefs 実体ファイル名（/data/data/<pkg>/shared_prefs/ 配下、§4 (b)）。 */
export const TV_PREFS_FILE = "tv_ble_bridge.xml";

/**
 * MAC アドレスを比較用に正規化する: 小文字化 + コロン/ハイフン/空白を除去。
 * 例 `"AA:BB:CC:11:22:33"` / `"aa-bb-cc-11-22-33"` → `"aabbcc112233"`。
 * @param {string | null | undefined} mac
 * @returns {string} 正規化済み（入力が空なら空文字）
 */
export function normalizeMac(mac) {
  if (typeof mac !== "string") return "";
  return mac.toLowerCase().replace(/[^0-9a-f]/g, "");
}

/**
 * 工場出荷 MAC（`cmd wifi get-factory-mac`）と現在の wlan0 MAC が一致するか。
 *
 * 不一致 = MAC ランダマイズが有効（接続ごとに別 MAC）。県 Wi-Fi が MAC アドレス認証の場合、
 * 工場 MAC で許可登録した端末でも接続できなくなるため、呼び出し側は reset に進まず
 * ① LP-as-proxy フォールバックを推奨する（preflight で WARN）。
 * @param {string | null | undefined} factoryMac
 * @param {string | null | undefined} currentMac
 * @returns {boolean} 両方が非空かつ正規化後に一致すれば true
 */
export function isFactoryMacMatch(factoryMac, currentMac) {
  const f = normalizeMac(factoryMac);
  const c = normalizeMac(currentMac);
  if (f.length === 0 || c.length === 0) return false;
  return f === c;
}

/**
 * `adb shell ip route` / `ip addr` 等の出力から Wi-Fi 静的設定を抽出する（非秘密のみ）。
 *
 * 緩いパーサ: 行ごとに `key: value` または `key value`（key は ip/gateway/dns/proxy/mac/...）を拾う。
 * 機種ごとに出力形式が割れるため、見つかった項目だけ埋め、無いものは null のままにする。
 * 鍵・PII は含まれない経路（ネットワーク設定のみ）なので steps_json に載せてよい。
 * @param {string} adbText 複数行のテキスト
 * @returns {{ ip: string|null, gateway: string|null, dns: string|null, proxy: string|null, mac: string|null }}
 */
export function parseWifiConfig(adbText) {
  /** @type {{ ip: string|null, gateway: string|null, dns: string|null, proxy: string|null, mac: string|null }} */
  const out = { ip: null, gateway: null, dns: null, proxy: null, mac: null };
  if (typeof adbText !== "string" || adbText.length === 0) return out;

  for (const rawLine of adbText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // "key: value" / "key = value" / "key value" を許容（最初の区切りで分割）。
    const m = line.match(/^([A-Za-z0-9_.\- ]+?)\s*[:=]\s*(.+)$/) ?? line.match(/^(\S+)\s+(.+)$/);
    if (m === null) continue;
    const key = (m[1] ?? "").toLowerCase().replace(/\s+/g, "");
    const value = (m[2] ?? "").trim();
    if (value.length === 0) continue;

    if (out.ip === null && /(^|_)(ip|ipaddress|ipaddr|inet|linkaddress|staticip)$/.test(key)) {
      out.ip = stripCidr(value);
    } else if (out.gateway === null && /(gateway|gw|router)/.test(key)) {
      out.gateway = firstToken(value);
    } else if (out.dns === null && /(dns|nameserver)/.test(key)) {
      out.dns = value;
    } else if (out.proxy === null && /proxy/.test(key)) {
      out.proxy = value;
    } else if (out.mac === null && /(mac|hwaddr|link\/ether|ethernet)/.test(key)) {
      out.mac = firstToken(value);
    }
  }
  return out;
}

/** CIDR 表記（`192.168.1.10/24`）からアドレス部だけ取り出す。 */
function stripCidr(value) {
  const tok = firstToken(value);
  const slash = tok.indexOf("/");
  return slash >= 0 ? tok.slice(0, slash) : tok;
}

/** 空白区切りの最初のトークンを返す。 */
function firstToken(value) {
  const t = value.trim().split(/\s+/)[0];
  return t ?? "";
}

/**
 * SharedPreferences XML を組み立てる（§4 (a)）。`&` を `&amp;` にエスケープして URL を安全に埋める。
 *
 * secret は引数に取らない: `configEndpoint` は呼び出し側が `?key=<poll-secret>` 込みで構築済みの
 * 不透明文字列として渡す。本関数はそれをそのまま（エスケープのみ）XML に入れる。
 * @param {{ configEndpoint: string, deviceId: string, signageUrl: string, targetMac: string|null|undefined }} p
 * @returns {string} prefs XML（UTF-8 前提）
 */
export function buildPrefsXml(p) {
  const lines = [
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
    "<map>",
    `    <string name="config_endpoint">${xmlEscape(p.configEndpoint)}</string>`,
    `    <string name="device_id">${xmlEscape(p.deviceId)}</string>`,
    `    <string name="signage_url">${xmlEscape(p.signageUrl)}</string>`,
  ];
  if (typeof p.targetMac === "string" && p.targetMac.length > 0) {
    lines.push(`    <string name="target_mac">${xmlEscape(p.targetMac)}</string>`);
  }
  lines.push('    <boolean name="autolaunch_signage" value="true" />');
  lines.push("</map>");
  return `${lines.join("\n")}\n`;
}

/** XML テキストノード用の最小エスケープ（`&` を最初に処理）。 */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * prefs を base64 経由で `run-as` 書き込みするコマンド列を組み立てる（§4 (b)）。
 *
 * `input text` は URL の `?`/`&` で事故るため使わない。XML を base64 化し、
 * `run-as <pkg> sh -c 'mkdir -p shared_prefs; echo <b64> | base64 -d > shared_prefs/<file>; ...'` で書く。
 * 稼働中はメモリ上 prefs がファイルを上書きするため、先に force-stop する。
 *
 * 返すのは **adb 引数配列の配列**（呼び出し側が `spawn('adb', cmd)` する）。secret は configEndpoint 内に
 * 埋め込まれて prefs XML → base64 になるだけで、ここで鍵を個別に扱わない（ログにも出ない設計）。
 * @param {{ pkg?: string, configEndpoint: string, deviceId: string, signageUrl: string, targetMac?: string|null }} p
 * @returns {{ prefsXml: string, prefsB64: string, commands: string[][] }}
 */
export function buildPrefsCommands(p) {
  const pkg = p.pkg ?? TV_BRIDGE_PKG;
  const prefsXml = buildPrefsXml({
    configEndpoint: p.configEndpoint,
    deviceId: p.deviceId,
    signageUrl: p.signageUrl,
    targetMac: p.targetMac ?? null,
  });
  const prefsB64 = Buffer.from(prefsXml, "utf8").toString("base64");
  // 1 行で run-as に渡す sh スクリプト（§4 (b) と同形）。読み戻し検証は呼び出し側で別途行う。
  const writeScript = `mkdir -p shared_prefs; echo ${prefsB64} | base64 -d > shared_prefs/${TV_PREFS_FILE}; echo WROTE_OK`;
  /** @type {string[][]} */
  const commands = [
    // (1) 稼働中プロセスを止める（メモリ上 prefs のファイル上書き防止）。
    ["shell", "am", "force-stop", pkg],
    // (2) base64 デコードして prefs を書き込む。
    ["shell", `run-as ${pkg} sh -c '${writeScript}'`],
    // (3) 読み戻して検証（呼び出し側が WROTE_OK / 内容を確認）。
    ["shell", `run-as ${pkg} cat shared_prefs/${TV_PREFS_FILE}`],
  ];
  return { prefsXml, prefsB64, commands };
}

/**
 * オフタイマー / スリープ無効化（no-sleep）の `adb shell settings` コマンド列（§6）。
 *
 * firmware 側オフタイマーは `settings put` で消えない機種があるため（ORION AI PONT の 16:30 電源 OFF）、
 * 呼び出し側は settings 網羅 + 失敗時に screencap+keyevent フォールバック（TV 設定 UI 操作）を併用する。
 * ここでは settings 網羅分だけを返す（純粋・副作用なし）。
 * @returns {string[][]} adb 引数配列の配列
 */
export function buildNoSleepCommands() {
  /** @type {Array<[string, string]>} key, value（§6 の網羅リスト） */
  const globalKeys = [
    ["hdmi_control_auto_device_off_enabled", "0"],
    ["no_signal_auto_power_off", "0"],
    ["stay_on_while_plugged_in", "7"],
  ];
  /** @type {Array<[string, string]>} */
  const systemKeys = [["screen_off_timeout", "2147483647"]];
  /** @type {Array<[string, string]>} */
  const secureKeys = [
    ["sleep_timeout", "-1"],
    ["screensaver_enabled", "0"],
    ["screensaver_activate_on_sleep", "0"],
    ["screensaver_activate_on_dock", "0"],
  ];
  /** @type {string[][]} */
  const cmds = [];
  for (const [k, v] of globalKeys) cmds.push(["shell", "settings", "put", "global", k, v]);
  for (const [k, v] of systemKeys) cmds.push(["shell", "settings", "put", "system", k, v]);
  for (const [k, v] of secureKeys) cmds.push(["shell", "settings", "put", "secure", k, v]);
  return cmds;
}

/**
 * 権限付与コマンド列（§5）。BLE/位置・画面制御・バックグラウンド起動・電池最適化除外。
 * @param {string} [pkg]
 * @returns {string[][]}
 */
export function buildGrantCommands(pkg = TV_BRIDGE_PKG) {
  return [
    ["shell", "pm", "grant", pkg, "android.permission.ACCESS_FINE_LOCATION"],
    ["shell", "pm", "grant", pkg, "android.permission.ACCESS_COARSE_LOCATION"],
    ["shell", "cmd", "location", "set-location-enabled", "true"],
    ["shell", "settings", "put", "secure", "location_mode", "3"],
    // KeepAwakeManager がアプリ自身で no-sleep を再適用するための権限。
    ["shell", "pm", "grant", pkg, "android.permission.WRITE_SECURE_SETTINGS"],
    ["shell", "appops", "set", pkg, "WRITE_SETTINGS", "allow"],
    // バックグラウンドからの画面起動（黒画面/サイネージ startActivity）に必須。
    ["shell", "appops", "set", pkg, "SYSTEM_ALERT_WINDOW", "allow"],
    // 電池最適化からの除外（常駐サービスが Doze で殺されにくくする）。
    ["shell", "dumpsys", "deviceidle", "whitelist", `+${pkg}`],
  ];
}

/**
 * 起動コマンド列（§7）。clean install 直後は必ず一度 MainActivity を起動 → サイネージ前面化。
 * @param {string} [pkg]
 * @returns {string[][]}
 */
export function buildLaunchCommands(pkg = TV_BRIDGE_PKG) {
  return [
    ["shell", "am", "start", "-n", `${pkg}/.MainActivity`],
    ["shell", "am", "start", "-a", `${pkg}.OPEN_SIGNAGE`],
  ];
}

/**
 * Device Owner 昇格コマンド（§3）。owner 済みなら呼び出し側で skip する。
 * @param {string} [pkg]
 * @returns {string[]}
 */
export function buildSetDeviceOwnerCommand(pkg = TV_BRIDGE_PKG) {
  return ["shell", "dpm", "set-device-owner", `${pkg}/${TV_DEVICE_ADMIN_RECEIVER}`];
}

/**
 * status 報告 API（POST /api/tv/provisioning/<jobId>/status）の body を組み立てる。
 *
 * 渡されたフィールドだけを載せる（undefined は API 側で no-op）。`agentId` は claim 時の値と一致必須
 * （状態詐称防止の認可キー）。`step.detail` / `error` は **非秘密に整形済み**である契約（鍵を載せない）。
 * @param {{
 *   agentId: string,
 *   status?: string,
 *   currentStep?: string,
 *   step?: { name: string, status: string, detail?: Record<string, unknown>, at?: string },
 *   error?: string,
 *   deviceId?: string,
 * }} p
 * @returns {Record<string, unknown>}
 */
export function buildStatusBody(p) {
  /** @type {Record<string, unknown>} */
  const body = { agentId: p.agentId };
  if (p.status !== undefined) body.status = p.status;
  if (p.currentStep !== undefined) body.currentStep = p.currentStep;
  if (p.step !== undefined) body.step = p.step;
  if (p.error !== undefined) body.error = p.error;
  if (p.deviceId !== undefined) body.deviceId = p.deviceId;
  return body;
}

/**
 * awaiting_physical 段階でオペレータに提示する物理手順テキストを組み立てる（捕捉値を埋め込む）。
 *
 * 物理 factory reset と県 Wi-Fi 再参加は **人間が行う**（破壊的操作を自動化しない）。
 * 捕捉した静的 IP / GW / DNS / proxy / MAC を文面に埋め、現地でそのまま再設定できるようにする。
 * 値は非秘密（ネットワーク設定）なので表示してよい。MAC ランダマイズ時はフォールバックを促す。
 * @param {{ ip: string|null, gateway: string|null, dns: string|null, proxy: string|null, mac: string|null }} wifi
 * @param {{ macRandomized?: boolean }} [opts]
 * @returns {string} 改行区切りの手順テキスト
 */
export function buildPhysicalInstructions(wifi, opts = {}) {
  const v = (x) => (typeof x === "string" && x.length > 0 ? x : "(未捕捉 — 現地で TV 設定を確認)");
  const lines = [
    "==== 物理作業（オペレータが手動で実施） ====",
    "1. TV を factory reset する（設定 → システム → リセット）。※この破壊的操作は人間が行う。",
    "2. 初期セットアップで Wi-Fi に接続するが Google アカウント追加は必ず SKIP（Device Owner の必須条件）。",
    "3. 県 Wi-Fi に以下の固定設定で再参加する:",
    `     - 静的 IP   : ${v(wifi.ip)}`,
    `     - ゲートウェイ: ${v(wifi.gateway)}`,
    `     - DNS       : ${v(wifi.dns)}`,
    `     - プロキシ  : ${v(wifi.proxy)}`,
    `     - 端末 MAC  : ${v(wifi.mac)}（県側に登録済みの MAC。ランダマイズは OFF にする）`,
    "4. 開発者オプション → USB デバッグ + ネットワークデバッグ(ADB over network/5555) を ON。",
    "5. 完了したらこのエージェントに confirm を返す（adb 再到達をポーリングして次段へ進む）。",
  ];
  if (opts.macRandomized === true) {
    lines.push(
      "",
      "⚠ MAC 不一致を検出（ランダマイズ有効）。県 Wi-Fi が MAC 認証ならこの端末は接続できない。",
      "  → reset に進まず ① LP-as-proxy フォールバック運用を推奨（provision-googletv.md §10 / 運用判断）。",
    );
  }
  return lines.join("\n");
}
