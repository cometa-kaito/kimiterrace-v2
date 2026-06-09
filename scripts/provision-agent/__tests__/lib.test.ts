import { describe, expect, it } from "vitest";
import {
  TV_BRIDGE_PKG,
  TV_DEVICE_ADMIN_RECEIVER,
  buildPhysicalInstructions,
  buildPrefsCommands,
  buildSetDeviceOwnerCommand,
  buildStatusBody,
  isFactoryMacMatch,
  normalizeMac,
  parseWifiConfig,
} from "../lib.mjs";

/**
 * provision-agent 純粋ヘルパーの単体テスト（PR5、DB 不要）。
 * カバー: MAC 一致/不一致、Wi-Fi パース、status-body 形状、prefs コマンド構築（ダミー鍵）、
 * 物理手順への捕捉値埋め込み。
 */

describe("normalizeMac / isFactoryMacMatch", () => {
  it("区切り文字と大文字小文字を無視して一致判定する", () => {
    expect(normalizeMac("AA:BB:CC:11:22:33")).toBe("aabbcc112233");
    expect(isFactoryMacMatch("AA:BB:CC:11:22:33", "aa-bb-cc-11-22-33")).toBe(true);
    expect(isFactoryMacMatch("aabbcc112233", "AABBCC112233")).toBe(true);
  });

  it("不一致（ランダマイズ）を検出する", () => {
    expect(isFactoryMacMatch("AA:BB:CC:11:22:33", "DE:AD:BE:EF:00:01")).toBe(false);
  });

  it("どちらかが空なら false（捕捉失敗を一致扱いしない）", () => {
    expect(isFactoryMacMatch("", "aa:bb:cc:11:22:33")).toBe(false);
    expect(isFactoryMacMatch("aa:bb:cc:11:22:33", null)).toBe(false);
    expect(isFactoryMacMatch(undefined, undefined)).toBe(false);
  });
});

describe("parseWifiConfig", () => {
  it("key: value / key value の混在から ip/gw/dns/proxy/mac を拾い CIDR を剥がす", () => {
    const text = [
      "IP: 192.168.10.42/24",
      "gateway = 192.168.10.1",
      "dns 8.8.8.8",
      "proxy: proxy.kennet.example:8080",
      "link/ether aa:bb:cc:11:22:33 brd ff:ff:ff:ff:ff:ff",
    ].join("\n");
    const cfg = parseWifiConfig(text);
    expect(cfg.ip).toBe("192.168.10.42");
    expect(cfg.gateway).toBe("192.168.10.1");
    expect(cfg.dns).toBe("8.8.8.8");
    expect(cfg.proxy).toBe("proxy.kennet.example:8080");
    expect(cfg.mac).toBe("aa:bb:cc:11:22:33");
  });

  it("空入力では全て null", () => {
    expect(parseWifiConfig("")).toEqual({
      ip: null,
      gateway: null,
      dns: null,
      proxy: null,
      mac: null,
    });
  });
});

describe("buildStatusBody", () => {
  it("agentId は必須、渡したフィールドだけ載る（undefined は載せない）", () => {
    expect(buildStatusBody({ agentId: "laptop-01" })).toEqual({ agentId: "laptop-01" });
  });

  it("status / currentStep / step / error / deviceId を反映する", () => {
    const body = buildStatusBody({
      agentId: "laptop-01",
      status: "provisioning",
      currentStep: "install",
      step: { name: "install", status: "ok" },
      error: undefined,
      deviceId: "dev-123",
    });
    expect(body).toEqual({
      agentId: "laptop-01",
      status: "provisioning",
      currentStep: "install",
      step: { name: "install", status: "ok" },
      deviceId: "dev-123",
    });
    expect("error" in body).toBe(false);
  });
});

describe("buildPrefsCommands（ダミー鍵）", () => {
  const DUMMY_SECRET = "DUMMY_POLL_SECRET_xyz";
  const configEndpoint = `https://app.example.net/api/tv/lp-config?key=${DUMMY_SECRET}`;
  const result = buildPrefsCommands({
    configEndpoint,
    deviceId: "1bf201a2-bd76-4ed9-a900-3b989d49a871",
    signageUrl: "https://signage.example.net/room?a=1&b=2",
    targetMac: "AA:BB:CC:11:22:33",
  });

  it("XML に config_endpoint/device_id/signage_url/target_mac を入れ & をエスケープする", () => {
    expect(result.prefsXml).toContain(
      '<string name="config_endpoint">https://app.example.net/api/tv/lp-config?key=DUMMY_POLL_SECRET_xyz</string>',
    );
    expect(result.prefsXml).toContain(
      '<string name="device_id">1bf201a2-bd76-4ed9-a900-3b989d49a871</string>',
    );
    // signage_url の & は &amp; にエスケープ（生 & を含まない）。
    expect(result.prefsXml).toContain("a=1&amp;b=2");
    expect(result.prefsXml).not.toContain("a=1&b=2");
    expect(result.prefsXml).toContain('<string name="target_mac">AA:BB:CC:11:22:33</string>');
  });

  it("3 段（force-stop → run-as 書き込み → 読み戻し）を返し、base64 が XML を表す", () => {
    expect(result.commands).toHaveLength(3);
    expect(result.commands[0]).toEqual(["shell", "am", "force-stop", TV_BRIDGE_PKG]);
    // 2 段目は base64 を含む run-as oneliner。
    expect(result.commands[1][1]).toContain(`run-as ${TV_BRIDGE_PKG}`);
    expect(result.commands[1][1]).toContain(result.prefsB64);
    // base64 をデコードすると元の XML に戻る（secret 含む config_endpoint が prefs 経由でのみ載る）。
    expect(Buffer.from(result.prefsB64, "base64").toString("utf8")).toBe(result.prefsXml);
  });

  it("コマンド引数自体には鍵を直接置かない（鍵は base64 化された XML 内のみ）", () => {
    // run-as oneliner 文字列に平文の鍵が出ない（base64 化されているため）。
    expect(result.commands[1][1]).not.toContain(DUMMY_SECRET);
  });
});

describe("buildSetDeviceOwnerCommand", () => {
  it("pkg/.TvDeviceAdminReceiver を dpm set-device-owner で渡す", () => {
    expect(buildSetDeviceOwnerCommand()).toEqual([
      "shell",
      "dpm",
      "set-device-owner",
      `${TV_BRIDGE_PKG}/${TV_DEVICE_ADMIN_RECEIVER}`,
    ]);
  });
});

describe("buildPhysicalInstructions", () => {
  const wifi = {
    ip: "192.168.10.42",
    gateway: "192.168.10.1",
    dns: "8.8.8.8",
    proxy: "proxy.kennet.example:8080",
    mac: "aa:bb:cc:11:22:33",
  };

  it("捕捉した静的 IP/GW/DNS/proxy/MAC を文面に埋め込む", () => {
    const text = buildPhysicalInstructions(wifi);
    expect(text).toContain("192.168.10.42");
    expect(text).toContain("192.168.10.1");
    expect(text).toContain("8.8.8.8");
    expect(text).toContain("proxy.kennet.example:8080");
    expect(text).toContain("aa:bb:cc:11:22:33");
    // 物理 reset は人間が行う旨を明示。
    expect(text).toContain("factory reset");
  });

  it("MAC ランダマイズ時は LP-as-proxy フォールバックを促す", () => {
    const text = buildPhysicalInstructions(wifi, { macRandomized: true });
    expect(text).toContain("LP-as-proxy");
  });

  it("未捕捉値はプレースホルダで埋める（undefined を露出しない）", () => {
    const text = buildPhysicalInstructions({
      ip: null,
      gateway: null,
      dns: null,
      proxy: null,
      mac: null,
    });
    expect(text).not.toContain("null");
    expect(text).toContain("未捕捉");
  });
});
