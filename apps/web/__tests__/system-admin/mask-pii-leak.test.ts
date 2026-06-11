import { describe, expect, it } from "vitest";
import { maskIdentifier, maskJsonForDisplay, maskPersonName } from "@/lib/system-admin/mask";

/**
 * UIUX-03 Opus 検証 ISSUE-2 / ISSUE-3 の **修正後ガード**（著者≠検証者）。
 *
 * 旧挙動（漏洩）:
 * - `membership-list` が 16進識別子用の `maskIdentifier` を `users.displayName` に適用し、
 *   2〜4 文字の日本語氏名で姓 / 全体が露出していた。
 * - `maskJsonForDisplay` が人名系キーを伏字対象にせず、audit_log.diff / events.payload の
 *   氏名・連絡先が 120 字未満なら verbatim で出ていた。
 *
 * 修正:
 * - 人名は `maskPersonName`（文字も長さも残さない全伏字 "••"）を使用。
 * - `maskJsonForDisplay` は NAME_KEY_RE で人名/連絡先キーを全伏字にする
 *   （schoolName / className 等の非 PII は監査の有用性のため対象外）。
 */

describe("maskPersonName: 人名は文字も長さも残さない", () => {
  it("2 文字氏名は全伏字（姓も露出しない）", () => {
    expect(maskPersonName("田中")).toBe("••");
  });

  it("3 / 4 文字氏名も姓を露出しない", () => {
    expect(maskPersonName("佐藤健")).toBe("••");
    expect(maskPersonName("山田花子")).toBe("••");
    expect(maskPersonName("田中太郎")).toBe("••");
  });

  it("空 / null / undefined は空文字", () => {
    expect(maskPersonName("")).toBe("");
    expect(maskPersonName(null)).toBe("");
    expect(maskPersonName(undefined)).toBe("");
  });
});

describe("maskIdentifier: 16進識別子用（両端のみ）— 人名には使わない", () => {
  it("長い識別子は両端のみ残す（uuid / mac / hash の正規用途）", () => {
    expect(maskIdentifier("0123456789abcdef")).toBe("0123…cdef");
  });
});

describe("maskJsonForDisplay: 人名 / 連絡先キーは全伏字", () => {
  it("人名・連絡先キーは verbatim で出ない", () => {
    const out = maskJsonForDisplay({
      studentName: "田中太郎",
      parentName: "田中花子",
      phone: "090-1111-2222",
      address: "岐阜県各務原市…",
      email: "kaito@example.jp",
    });
    expect(out).toEqual({
      studentName: "••",
      parentName: "••",
      phone: "••",
      address: "••",
      email: "••",
    });
  });

  it("名簿配列(students)も各要素を伏字", () => {
    const out = maskJsonForDisplay({ students: ["田中太郎", "山田花子"] });
    expect(out).toEqual({ students: ["••", "••"] });
  });

  it("数値の識別子キーも素通ししない", () => {
    const out = maskJsonForDisplay({ user_id: 8675309 });
    expect(out).toEqual({ user_id: "86•••••" });
  });

  it("【対照】非 PII キー(schoolName / className)は監査の有用性のため読める", () => {
    const out = maskJsonForDisplay({ schoolName: "岐南工業高校", className: "1年A組" });
    expect(out).toEqual({ schoolName: "岐南工業高校", className: "1年A組" });
  });

  it("【対照】識別子キーの文字列は両端のみ", () => {
    const out = maskJsonForDisplay({ device_id: "AA:BB:CC:DD:EE:FF" });
    expect(out).toEqual({ device_id: "AA:B…E:FF" });
  });
});
