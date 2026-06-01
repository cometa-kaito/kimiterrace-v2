import { describe, expect, it } from "vitest";
import { type ContractStatus, validateContractCreate } from "../../lib/system-admin/contracts-core";

/**
 * F10 (#46): validateContractCreate の純粋検証テスト。必須/任意/範囲/日付実在性/終了日順序/
 * targetSchools UUID/月額整数化を pin する。
 */

const ADV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHOOL_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCHOOL_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function base(over: Record<string, unknown> = {}) {
  return {
    advertiserId: ADV,
    status: "active" as ContractStatus,
    startedAt: "2026-04-01",
    monthlyFeeJpy: 50000,
    ...over,
  };
}

describe("validateContractCreate", () => {
  it("最小の必須項目で ok、任意は null / 空配列に正規化", () => {
    const v = validateContractCreate(base());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.advertiserId).toBe(ADV);
    expect(v.value.status).toBe("active");
    expect(v.value.startedAt.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(v.value.endedAt).toBeNull();
    expect(v.value.monthlyFeeJpy).toBe(50000);
    expect(v.value.targetSchools).toEqual([]);
    expect(v.value.notes).toBeNull();
  });

  it("全項目 (endedAt / targetSchools / notes) を受け付ける", () => {
    const v = validateContractCreate(
      base({
        endedAt: "2027-03-31",
        targetSchools: [SCHOOL_A, SCHOOL_B],
        notes: "  年度契約  ",
      }),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.endedAt?.toISOString()).toBe("2027-03-31T00:00:00.000Z");
    expect(v.value.targetSchools).toEqual([SCHOOL_A, SCHOOL_B]);
    expect(v.value.notes).toBe("年度契約");
  });

  it("advertiserId が UUID でないと invalid", () => {
    const v = validateContractCreate(base({ advertiserId: "not-a-uuid" }));
    expect(v).toMatchObject({ ok: false });
  });

  it("status が enum 外だと invalid", () => {
    const v = validateContractCreate(base({ status: "expired" }));
    expect(v).toMatchObject({ ok: false });
  });

  it.each(["draft", "active", "paused", "terminated"])("status=%s は ok", (status) => {
    expect(validateContractCreate(base({ status })).ok).toBe(true);
  });

  it("startedAt が形式不正だと invalid", () => {
    expect(validateContractCreate(base({ startedAt: "2026/04/01" })).ok).toBe(false);
    expect(validateContractCreate(base({ startedAt: "" })).ok).toBe(false);
    expect(validateContractCreate(base({ startedAt: undefined })).ok).toBe(false);
  });

  it("実在しない日付 (2026-02-30) は invalid", () => {
    expect(validateContractCreate(base({ startedAt: "2026-02-30" })).ok).toBe(false);
  });

  it("endedAt が startedAt より前だと invalid", () => {
    const v = validateContractCreate(base({ startedAt: "2026-04-01", endedAt: "2026-03-31" }));
    expect(v).toMatchObject({ ok: false });
  });

  it("endedAt == startedAt は許可 (同日終了)", () => {
    const v = validateContractCreate(base({ startedAt: "2026-04-01", endedAt: "2026-04-01" }));
    expect(v.ok).toBe(true);
  });

  it("月額: 負値・非整数・桁あふれは invalid", () => {
    expect(validateContractCreate(base({ monthlyFeeJpy: -1 })).ok).toBe(false);
    expect(validateContractCreate(base({ monthlyFeeJpy: 1.5 })).ok).toBe(false);
    expect(validateContractCreate(base({ monthlyFeeJpy: 100_000_001 })).ok).toBe(false);
  });

  it("月額: 0 と 数字のみ文字列 を受ける", () => {
    expect(validateContractCreate(base({ monthlyFeeJpy: 0 })).ok).toBe(true);
    const v = validateContractCreate(base({ monthlyFeeJpy: "50000" }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.monthlyFeeJpy).toBe(50000);
  });

  it("targetSchools に非 UUID が混ざると invalid", () => {
    const v = validateContractCreate(base({ targetSchools: [SCHOOL_A, "bad"] }));
    expect(v).toMatchObject({ ok: false });
  });

  it("targetSchools が配列でないと invalid", () => {
    expect(validateContractCreate(base({ targetSchools: "x" })).ok).toBe(false);
  });

  it("notes 超過 (2001 文字) は invalid", () => {
    expect(validateContractCreate(base({ notes: "あ".repeat(2001) })).ok).toBe(false);
  });
});
