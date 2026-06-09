#!/usr/bin/env node
// @ts-check
/**
 * C方式 TV プロビジョニング ローカルエージェント（PR5）。
 *
 * 学校 LAN 上の現地ノート PC で **install 時に手動起動**するスタンドアロン CLI（常駐デーモンではない）。
 * system_admin が v2 管理 UI でプロビジョニングジョブを作成 → 本エージェントが claim → adb で TV を
 * 段階的にプロビジョニング → 各ステップを v2 API に報告する。
 *
 *   node scripts/provision-agent/provision-agent.mjs [--once]
 *
 * 依存は最小（Node 20+ グローバル fetch / node:child_process / node:os のみ。外部 npm 依存なし）。
 *
 * === API 契約（main 済 PR1–4） ===
 *  - claim : POST <V2_BASE_URL>/api/tv/provisioning/claim
 *            header `x-provision-agent-key: <secret>`、body `{ agentId }`
 *            → 200 { job: ClaimedProvisioningJob | null }
 *  - status: POST <V2_BASE_URL>/api/tv/provisioning/<jobId>/status
 *            同 header、body `{ agentId, status?, currentStep?, step?, error?, deviceId? }`
 *            status ∈ pending/claimed/preflight/awaiting_physical/provisioning/succeeded/failed/canceled
 *
 * === シークレット（ルール5） ===
 *  - PROVISION_AGENT_SECRET : エージェント API 鍵。env か `gcloud secrets versions access
 *    prod-provision-agent-secret` で取得。
 *  - TV ポーリング鍵        : prefs 書き込み直前に `gcloud secrets versions access prod-tv-poll-secret`
 *    で取得し config_endpoint に埋め込む。**ハードコードしない / ログに出さない / job・steps_json に載せない**。
 *
 * === 段階ワークフロー ===
 *  preflight → awaiting_physical（人間が factory reset + 県 Wi-Fi 再参加）→ provisioning → succeeded/failed。
 *  破壊的な物理 reset は **人間が行う**。エージェントは捕捉値の提示と adb 駆動・状態報告に徹する。
 */

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  TV_BRIDGE_PKG,
  buildGrantCommands,
  buildLaunchCommands,
  buildNoSleepCommands,
  buildPhysicalInstructions,
  buildPrefsCommands,
  buildSetDeviceOwnerCommand,
  buildStatusBody,
  isFactoryMacMatch,
  parseWifiConfig,
} from "./lib.mjs";

// ---- 設定（env、README に文書化） -------------------------------------------------
const V2_BASE_URL = (process.env.V2_BASE_URL ?? "").replace(/\/+$/, "");
const AGENT_ID = process.env.AGENT_ID ?? hostname();
const APK_PATH = process.env.APK_PATH ?? "";
const ADB = process.env.ADB_PATH ?? "adb";
const GCLOUD = process.env.GCLOUD_PATH ?? "gcloud";
const PROVISION_AGENT_SECRET_NAME =
  process.env.PROVISION_AGENT_SECRET_NAME ?? "prod-provision-agent-secret";
const TV_POLL_SECRET_NAME = process.env.TV_POLL_SECRET_NAME ?? "prod-tv-poll-secret";
const ARGS = new Set(process.argv.slice(2));
const RUN_ONCE = ARGS.has("--once");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "5000");
const ADB_REACHABLE_TIMEOUT_MS = Number(process.env.ADB_REACHABLE_TIMEOUT_MS ?? "600000");

/** ログ補助（secret は絶対に渡さない）。 */
const log = (...m) => console.log(`[provision-agent]`, ...m);
const warn = (...m) => console.warn(`[provision-agent][WARN]`, ...m);
const err = (...m) => console.error(`[provision-agent][ERROR]`, ...m);

// ---- シェル / adb ヘルパー（I/O はすべてここ） ------------------------------------

/**
 * 子プロセスを同期実行する。stdout/stderr を文字列で返す。
 * 引数配列は呼び出し側がリテラルで渡す（シェル経由しないため secret は環境に乗らない / プロセス表に出ない）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [opts]
 * @returns {{ ok: boolean, code: number, stdout: string, stderr: string }}
 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const code = r.status ?? (r.error ? 1 : 0);
  const out = { ok: code === 0, code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (!out.ok && opts.allowFail !== true) {
    err(`コマンド失敗 (${code}): ${cmd} ${args.join(" ")}\n${out.stderr.trim()}`);
  }
  return out;
}

/** adb を実行する（引数配列をそのまま渡す）。 */
const adb = (args, opts) => run(ADB, args, opts);

/**
 * `adb shell <oneliner>` を 1 引数として実行する（run-as の sh -c '...' をそのまま渡すため）。
 * @param {string} shellLine
 */
const adbShell = (shellLine, opts) => run(ADB, ["shell", shellLine], opts);

/**
 * Secret Manager から最新版を取得する（ルール5。値はメモリ上のみ・ログ出力しない）。
 * @param {string} name
 * @returns {string}
 */
function fetchSecret(name) {
  const r = run(GCLOUD, ["secrets", "versions", "access", "latest", `--secret=${name}`], {
    allowFail: true,
  });
  if (!r.ok) {
    throw new Error(
      `Secret 取得失敗: ${name}（gcloud 認証 / 権限を確認。値はログに出していません）`,
    );
  }
  return r.stdout.trim();
}

/** PROVISION_AGENT_SECRET を env 優先で、無ければ Secret Manager から取得する。 */
function resolveAgentSecret() {
  const fromEnv = process.env.PROVISION_AGENT_SECRET;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return fetchSecret(PROVISION_AGENT_SECRET_NAME);
}

// ---- v2 API クライアント ----------------------------------------------------------

/**
 * claim エンドポイントを叩く。返す job は ClaimedProvisioningJob 相当（非秘密パラメータのみ）か null。
 * @param {string} secret
 * @returns {Promise<Record<string, unknown> | null>} job または null
 */
async function claimJob(secret) {
  const res = await fetch(`${V2_BASE_URL}/api/tv/provisioning/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-provision-agent-key": secret },
    body: JSON.stringify({ agentId: AGENT_ID }),
  });
  if (!res.ok) {
    throw new Error(`claim 失敗: HTTP ${res.status}`);
  }
  const data = /** @type {{ job: Record<string, unknown> | null }} */ (await res.json());
  return data.job;
}

/**
 * status / step を報告する（非秘密のみ。detail に鍵を入れない契約）。
 * @param {string} secret
 * @param {string} jobId
 * @param {{ status?: string, currentStep?: string, step?: object, error?: string, deviceId?: string }} fields
 */
async function reportStatus(secret, jobId, fields) {
  const body = buildStatusBody({ agentId: AGENT_ID, ...fields });
  const res = await fetch(`${V2_BASE_URL}/api/tv/provisioning/${jobId}/status`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-provision-agent-key": secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    warn(`status 報告失敗 (job=${jobId}): HTTP ${res.status}`);
  }
}

/** step を 1 件 steps_json に追記報告する短縮形。 */
function step(secret, jobId, name, status, detail) {
  return reportStatus(secret, jobId, {
    currentStep: name,
    step: { name, status, detail, at: new Date().toISOString() },
  });
}

// ---- adb 接続・検出 ---------------------------------------------------------------

/**
 * TV に adb 接続する（target_ip があれば network、無ければ USB の既存接続を使う）。
 * @param {string|null} targetIp
 * @returns {boolean} device 表示まで取れたら true
 */
function adbConnect(targetIp) {
  if (typeof targetIp === "string" && targetIp.length > 0) {
    adb(["connect", `${targetIp}:5555`], { allowFail: true });
  }
  const devices = adb(["devices", "-l"], { allowFail: true });
  // "device" 状態が 1 つ以上あるか（"offline" / "unauthorized" は除く）。
  return /\bdevice\b/.test(
    devices.stdout
      .split(/\r?\n/)
      .filter((l) => !l.startsWith("List of devices"))
      .join("\n"),
  );
}

/** TV が adb 到達可能になるまでポーリングする（awaiting_physical の復帰待ち）。 */
async function waitForAdbReachable(targetIp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (adbConnect(targetIp)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** 機種名（ro.product.model）を取得する（非秘密）。 */
function detectModel() {
  const r = adb(["shell", "getprop", "ro.product.model"], { allowFail: true });
  return r.stdout.trim() || "(unknown)";
}

/** Device Owner 済みか（dpm list-owners に pkg が出るか）。 */
function isDeviceOwner(pkg = TV_BRIDGE_PKG) {
  const r = adb(["shell", "dpm", "list-owners"], { allowFail: true });
  return r.stdout.includes(pkg);
}

// ---- 段階ワークフロー -------------------------------------------------------------

/**
 * preflight: 接続 → 機種検出 → 県 Wi-Fi 設定/MAC 捕捉。MAC ランダマイズ検出で警告し reset を止める。
 * @returns {{ proceed: boolean, wifi: ReturnType<typeof parseWifiConfig>, macMatch: boolean, model: string }}
 */
function doPreflight(targetIp) {
  const connected = adbConnect(targetIp);
  if (!connected) {
    throw new Error("preflight: adb device が見つからない（IP/5555 もしくは USB 接続を確認）");
  }
  const model = detectModel();
  log(`機種検出: ${model}`);

  // 工場 MAC と現在 MAC を比較（県 Wi-Fi の MAC 認証可否判定）。現在 MAC/静的設定は ip addr + ip route の
  // 両出力を連結してパース（機種により項目の出方が割れるため取りこぼしを減らす）。
  const factory = adb(["shell", "cmd", "wifi", "get-factory-mac"], { allowFail: true }).stdout;
  const linkText = adb(["shell", "ip", "addr", "show", "wlan0"], { allowFail: true }).stdout;
  const routeText = adb(["shell", "ip", "route"], { allowFail: true }).stdout;
  const wifi = parseWifiConfig(`${linkText}\n${routeText}`);
  const macMatch = isFactoryMacMatch(factory, wifi.mac);

  return { proceed: macMatch, wifi, macMatch, model };
}

/**
 * provisioning: APK install → Device Owner → off-timer 無効化 → prefs 書き込み → 権限 → 起動。
 * 各 adb コマンド列は lib.mjs（provision-googletv.md 写経）から取得し、ここで実行・報告する。
 * @param {string} secret
 * @param {{ id: string, deviceId: string|null, signageUrl: string|null, targetMac: string|null }} job
 */
async function doProvisioning(secret, job) {
  const jobId = job.id;

  // 1. APK install（-r で再インストール許容）。
  if (APK_PATH.length === 0) {
    throw new Error("APK_PATH 未設定（tv-ble-bridge-debug.apk のパスを env で指定）");
  }
  const install = adb(["install", "-r", APK_PATH], { allowFail: true });
  await step(secret, jobId, "install", install.ok ? "ok" : "failed");
  if (!install.ok) throw new Error(`adb install 失敗: ${install.stderr.trim()}`);

  // 2. Device Owner 昇格（owner 済みなら skip）。
  if (isDeviceOwner()) {
    await step(secret, jobId, "device_owner", "skipped", { reason: "already owner" });
  } else {
    const owner = adb(buildSetDeviceOwnerCommand(), { allowFail: true });
    await step(secret, jobId, "device_owner", owner.ok ? "ok" : "failed");
    if (!owner.ok) {
      // アカウント残存 / setup 完了済みで失敗する機種あり（provision-googletv.md §3）。致命にせず継続可。
      warn(
        "Device Owner 昇格に失敗（アカウント残存 / setup 完了済み機種の可能性）。夜間消灯は黒オーバーレイ運用に縮退。",
      );
    }
  }

  // 3. オフタイマー / no-sleep 無効化（settings 網羅）。firmware タイマーは UI でしか消えない機種あり。
  for (const cmd of buildNoSleepCommands()) adb(cmd, { allowFail: true });
  await step(secret, jobId, "off_timer_disable", "ok", {
    note: "settings 網羅適用。firmware オフタイマーは TV 設定 UI で要無効化（screencap+keyevent フォールバックは現地判断）",
  });

  // 4. prefs 書き込み（config_endpoint に poll-secret を埋め込む。鍵は steps_json に載せない）。
  const pollSecret = fetchSecret(TV_POLL_SECRET_NAME); // ★ ここで初めて取得、ログ出力しない
  const configEndpoint = `${V2_BASE_URL}/api/tv/lp-config?key=${pollSecret}`;
  const { commands: prefsCmds } = buildPrefsCommands({
    configEndpoint,
    deviceId: job.deviceId ?? "",
    signageUrl: job.signageUrl ?? "",
    targetMac: job.targetMac,
  });
  let prefsOk = true;
  for (const cmd of prefsCmds) {
    // cmd[0] === "shell" かつ 2 要素なら run-as の oneliner。3 要素以上は通常 adb 引数。
    const r =
      cmd.length === 2 && cmd[0] === "shell"
        ? adbShell(cmd[1], { allowFail: true })
        : adb(cmd, { allowFail: true });
    if (!r.ok) prefsOk = false;
  }
  // detail には config_endpoint や鍵を入れない（device_id のみ非秘密として報告）。
  await step(secret, jobId, "prefs", prefsOk ? "ok" : "failed", { device_id: job.deviceId });
  if (!prefsOk) throw new Error("prefs 書き込み失敗（run-as / base64 経路を確認）");

  // 5. 権限付与 + no-sleep 再適用。
  for (const cmd of buildGrantCommands()) adb(cmd, { allowFail: true });
  await step(secret, jobId, "grant_permissions", "ok");

  // 6. 起動（clean install 直後は MainActivity を必ず一度起動 → サイネージ前面化）。
  for (const cmd of buildLaunchCommands()) adb(cmd, { allowFail: true });
  await step(secret, jobId, "launch", "ok");
}

/**
 * 1 ジョブを段階処理する。preflight → awaiting_physical → provisioning → succeeded/failed。
 * @param {string} secret
 * @param {Record<string, any>} job
 */
async function processJob(secret, job) {
  const jobId = String(job.id);
  log(`claim 済みジョブ: ${jobId}（school=${job.schoolId} device=${job.deviceId ?? "-"}）`);

  try {
    // --- preflight ---
    await reportStatus(secret, jobId, { status: "preflight", currentStep: "preflight 開始" });
    const pf = doPreflight(job.targetIp ?? null);
    await step(secret, jobId, "preflight", "ok", {
      model: pf.model,
      mac_match: pf.macMatch,
      // 捕捉したネットワーク設定は非秘密なので報告してよい（鍵・PII ではない）。
      wifi_captured: {
        ip: pf.wifi.ip,
        gateway: pf.wifi.gateway,
        dns: pf.wifi.dns,
        proxy: pf.wifi.proxy,
      },
    });

    if (!pf.macMatch) {
      // MAC ランダマイズ: reset に進まず ① LP-as-proxy フォールバックを推奨して終了。
      warn(
        "factory-MAC ≠ 現在 MAC（ランダマイズ）。reset を中止し ① LP-as-proxy フォールバックを推奨。",
      );
      console.log(buildPhysicalInstructions(pf.wifi, { macRandomized: true }));
      await reportStatus(secret, jobId, {
        status: "failed",
        currentStep: "MAC ランダマイズ検出",
        error: "factory-MAC mismatch (randomized): reset を中止。LP-as-proxy フォールバック推奨",
      });
      return;
    }

    // --- awaiting_physical（人間が factory reset + 県 Wi-Fi 再参加） ---
    await reportStatus(secret, jobId, {
      status: "awaiting_physical",
      currentStep: "物理作業待ち（オペレータ）",
    });
    console.log(buildPhysicalInstructions(pf.wifi));
    log("オペレータの物理作業 → adb 再到達を待機中…（Ctrl+C で中断可）");
    const reachable = await waitForAdbReachable(job.targetIp ?? null, ADB_REACHABLE_TIMEOUT_MS);
    if (!reachable) {
      await reportStatus(secret, jobId, {
        status: "failed",
        currentStep: "物理作業待ちタイムアウト",
        error: "adb re-reachable 待ちがタイムアウト",
      });
      return;
    }

    // --- provisioning ---
    await reportStatus(secret, jobId, { status: "provisioning", currentStep: "provisioning 開始" });
    await doProvisioning(secret, {
      id: jobId,
      deviceId: job.deviceId ?? null,
      signageUrl: job.signageUrl ?? null,
      targetMac: job.targetMac ?? null,
    });

    await reportStatus(secret, jobId, { status: "succeeded", currentStep: "完了" });
    log(`ジョブ ${jobId} 完了 (succeeded)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`ジョブ ${jobId} 失敗: ${msg}`);
    await reportStatus(secret, jobId, { status: "failed", error: msg });
  }
}

// ---- メインループ -----------------------------------------------------------------

async function main() {
  if (V2_BASE_URL.length === 0) {
    err("V2_BASE_URL 未設定。例: V2_BASE_URL=https://app.school-signage.net");
    process.exitCode = 2;
    return;
  }
  const secret = resolveAgentSecret();
  log(`agentId=${AGENT_ID} base=${V2_BASE_URL} once=${RUN_ONCE}`);

  // claim → 処理 → 次を claim。ジョブが無ければ終了（--once は 1 件処理しても終了）。
  for (;;) {
    let job;
    try {
      job = await claimJob(secret);
    } catch (e) {
      err(`claim エラー: ${e instanceof Error ? e.message : String(e)}`);
      if (RUN_ONCE) {
        process.exitCode = 1;
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (job === null || job === undefined) {
      log("claim 可能なジョブなし。終了。");
      return;
    }

    await processJob(secret, /** @type {Record<string, any>} */ (job));
    if (RUN_ONCE) return;
  }
}

main().catch((e) => {
  err(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
