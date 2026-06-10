import { describe, expect, it } from "vitest";
import {
  type TvConfigEditInput,
  isUuid,
  validateSchedule,
  validateTvConfigEdit,
} from "../../lib/tv/config-edit-core";

/**
 * F15 §4.2 (ADR-022): TV 設定編集の純粋検証ロジックの単体テスト（postgres / 認可に依存しない）。
 * trim/空→null 正規化、URL 形式、長さ上限、schedule 形・範囲、システム管理列の非通過を検証する。
 */

describe("isUuid", () => {
  it("UUID は通し、非 UUID は弾く", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe("validateSchedule", () => {
  it("null/undefined は null（スケジュール無し）", () => {
    expect(validateSchedule(null)).toEqual({ ok: true, value: null });
    expect(validateSchedule(undefined)).toEqual({ ok: true, value: null });
  });
  it("enabled 必須 boolean、時刻は 0-23、weekdays は重複なし 0-6", () => {
    expect(validateSchedule({ enabled: true, onHour: 7, offHour: 19 })).toEqual({
      ok: true,
      value: { enabled: true, onHour: 7, offHour: 19 },
    });
    expect(validateSchedule({ enabled: "yes" }).ok).toBe(false);
    expect(validateSchedule({ enabled: true, onHour: 24 }).ok).toBe(false);
    expect(validateSchedule({ enabled: true, weekdays: [1, 1] }).ok).toBe(false);
    expect(validateSchedule({ enabled: true, weekdays: [7] }).ok).toBe(false);
  });
  it("weekdays は昇順に正規化し、余剰キーは落とす", () => {
    const r = validateSchedule({ enabled: true, weekdays: [6, 1, 3], junk: "x" });
    expect(r).toEqual({ ok: true, value: { enabled: true, weekdays: [1, 3, 6] } });
  });
});

describe("validateTvConfigEdit", () => {
  const base: TvConfigEditInput = {
    label: "電子工学科 1年",
    signageUrl: "https://sig.example/?school=A",
    targetMac: "DC:A5:B3:C2:98:A1",
    monitoringEnabled: true,
    schedule: { enabled: true, onHour: 8 },
  };

  it("正常系: trim 正規化 + schedule 反映", () => {
    const r = validateTvConfigEdit({ ...base, label: "  電子工学科 1年  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBe("電子工学科 1年");
      expect(r.value.signageUrl).toBe("https://sig.example/?school=A");
      expect(r.value.scheduleJson).toEqual({ enabled: true, onHour: 8 });
      expect(r.value.monitoringEnabled).toBe(true);
    }
  });

  it("空文字は null（クリア）に正規化", () => {
    const r = validateTvConfigEdit({ ...base, label: "  ", signageUrl: "", targetMac: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBeNull();
      expect(r.value.signageUrl).toBeNull();
      expect(r.value.targetMac).toBeNull();
    }
  });

  it("非 http(s) URL は拒否（javascript: / 相対）", () => {
    expect(validateTvConfigEdit({ ...base, signageUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateTvConfigEdit({ ...base, signageUrl: "/relative/path" }).ok).toBe(false);
    expect(validateTvConfigEdit({ ...base, webhookUrl: "ftp://x" }).ok).toBe(false);
  });

  it("長さ超過は拒否（label/notes）", () => {
    expect(validateTvConfigEdit({ ...base, label: "あ".repeat(201) }).ok).toBe(false);
    expect(validateTvConfigEdit({ ...base, notes: "x".repeat(2001) }).ok).toBe(false);
  });

  it("monitoringEnabled 未指定は true 既定、非 boolean は拒否", () => {
    const r = validateTvConfigEdit({ label: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.monitoringEnabled).toBe(true);
    expect(validateTvConfigEdit({ monitoringEnabled: "true" as unknown as boolean }).ok).toBe(
      false,
    );
  });

  it("システム管理列はパッチに通らない（version / deviceId 等を入れても黙殺）", () => {
    const r = validateTvConfigEdit({
      ...base,
      // 型外の余剰キー（攻撃的入力の模擬）。
      version: 999,
      deviceId: "evil",
      schoolId: "00000000-0000-0000-0000-000000000000",
    } as TvConfigEditInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toHaveProperty("version");
      expect(r.value).not.toHaveProperty("deviceId");
      expect(r.value).not.toHaveProperty("schoolId");
    }
  });
});

/**
 * F15 SSRF 入力境界ガード（PR #494 Reviewer Low-1 / ADR-022）。
 * `signageUrl` / `webhookUrl` は内部・ループバック・リンクローカル・プライベート・既知内部ホスト名を
 * 拒否する。現状サーバ側 fetch シンクは無いが、将来追加時の latent SSRF（GCP メタデータ SA トークン
 * 窃取）を入力境界で先回り遮断する。`signageUrl` で代表検証し、両フィールド同経路を別途確認する。
 */
describe("validateTvConfigEdit: SSRF 内部ホストガード", () => {
  // 内部判定で拒否されるべきホスト（カテゴリごと）。8/16/10 進・IPv6・末尾ドット迂回も含む。
  const blocked: Array<[string, string]> = [
    // ループバック 127.0.0.0/8 + ::1 + 0.0.0.0/8
    ["loopback v4", "http://127.0.0.1/"],
    ["loopback v4 末尾", "http://127.255.255.254/"],
    ["loopback v6", "http://[::1]/"],
    ["unspecified v4 0.0.0.0", "http://0.0.0.0/"],
    // リンクローカル 169.254.0.0/16（GCP メタデータ 169.254.169.254 を含む）
    ["メタデータ IP", "http://169.254.169.254/computeMetadata/v1/"],
    ["メタデータ IP(10進)", "http://2852039166/"],
    ["メタデータ IP(16進)", "http://0xA9FEA9FE/"],
    ["メタデータ IP(8進)", "http://0251.0376.0251.0376/"],
    ["link-local 一般", "http://169.254.1.1/"],
    // プライベート RFC1918
    ["private 10/8", "http://10.0.0.5/"],
    ["private 172.16/12 下端", "http://172.16.0.1/"],
    ["private 172.16/12 上端", "http://172.31.255.255/"],
    ["private 192.168/16", "http://192.168.1.1/"],
    // 既知内部ホスト名
    ["localhost", "http://localhost:8080/"],
    ["metadata.google.internal", "http://metadata.google.internal/computeMetadata/v1/"],
    ["末尾ドット迂回", "http://metadata.google.internal./"],
    [".internal サフィックス", "https://db.internal/x"],
    [".local サフィックス", "http://printer.local/"],
    [".localhost サフィックス", "http://api.localhost/"],
    // IPv6 link-local / unique-local / IPv4-mapped / IPv4-compatible(deprecated)
    ["v6 link-local fe80::/10", "http://[fe80::1]/"],
    ["v6 unique-local fc00::/7", "http://[fc00::1]/"],
    ["v6 unique-local fd00", "http://[fd12:3456::1]/"],
    ["v6 IPv4-mapped メタデータ", "http://[::ffff:169.254.169.254]/"],
    ["v6 IPv4-compatible メタデータ", "http://[::169.254.169.254]/"],
    ["v6 IPv4-compatible loopback", "http://[::127.0.0.1]/"],
  ];

  it.each(blocked)("内部宛先を拒否: %s", (_name, url) => {
    const r = validateTvConfigEdit({ signageUrl: url });
    expect(r.ok).toBe(false);
    // scheme ではなく内部ホスト判定で落ちていることを文言で固定（正しい経路の証明）。
    if (!r.ok) expect(r.message).toContain("内部");
  });

  it("webhookUrl も同じ内部ホストガードを通る", () => {
    const r = validateTvConfigEdit({ webhookUrl: "http://169.254.169.254/" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("内部");
  });

  // 公開ホスト・公開 IP・プライベートレンジ境界外は通す（過剰ブロックの回帰防止）。
  const allowed: Array<[string, string]> = [
    ["公開 https ホスト名", "https://sig.example/?school=A"],
    ["公開ドメイン", "https://example.com/path"],
    ["公開 IP", "https://8.8.8.8/"],
    ["172.16/12 直下の境界外(172.15)", "https://172.15.0.1/"],
    ["172.16/12 直上の境界外(172.32)", "https://172.32.0.1/"],
    ["internal を含むが別 TLD", "https://internal.example.com/"],
    // IPv4-compatible でも埋め込み IPv4 が公開なら通す（内部のみ遮断・過剰ブロックしない）。
    ["v6 IPv4-compatible 公開", "https://[::8.8.8.8]/"],
  ];

  it.each(allowed)("公開宛先は通す: %s", (_name, url) => {
    expect(validateTvConfigEdit({ signageUrl: url }).ok).toBe(true);
    expect(validateTvConfigEdit({ webhookUrl: url }).ok).toBe(true);
  });
});

/**
 * 端末別デザインパターン（`tv_devices.signage_url` の `?design=patternN` に合成・スキーマ非変更）。
 * 編集フォームの design ドロップダウン値が、検証済み signageUrl に正しく合成されることを確認する。
 * pattern1（既定）は後方互換のため `?design` を付けない。未知値は既定に倒す（fail-soft）。
 */
describe("validateTvConfigEdit: 端末別デザイン（?design 合成）", () => {
  const url = "https://sig.example/signage/tok";

  it("design=pattern2 は signageUrl に ?design=pattern2 を合成", () => {
    const r = validateTvConfigEdit({ signageUrl: url, design: "pattern2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.signageUrl).toBe("https://sig.example/signage/tok?design=pattern2");
    }
  });

  it("design 未指定 / pattern1 は ?design を付けない（後方互換）", () => {
    const r1 = validateTvConfigEdit({ signageUrl: url });
    if (r1.ok) expect(r1.value.signageUrl).toBe(url);
    const r2 = validateTvConfigEdit({ signageUrl: url, design: "pattern1" });
    if (r2.ok) expect(r2.value.signageUrl).toBe(url);
  });

  it("未知の design は既定 pattern1 に倒す（?design を付けない）", () => {
    const r = validateTvConfigEdit({ signageUrl: url, design: "bogus" });
    if (r.ok) expect(r.value.signageUrl).toBe(url);
  });

  it("既存 ?design はドロップダウン値で置換（二重に付かない）", () => {
    const r = validateTvConfigEdit({ signageUrl: `${url}?design=pattern1`, design: "pattern2" });
    if (r.ok) expect(r.value.signageUrl).toBe("https://sig.example/signage/tok?design=pattern2");
  });

  it("signageUrl が空（クリア）なら design は無視（合成先が無い）", () => {
    const r = validateTvConfigEdit({ signageUrl: "", design: "pattern2" });
    if (r.ok) expect(r.value.signageUrl).toBeNull();
  });
});
