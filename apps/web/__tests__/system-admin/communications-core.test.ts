import { describe, expect, it } from "vitest";
import {
  COMMUNICATION_CHANNELS,
  validateCommunicationCreate,
} from "../../lib/system-admin/communications-core";

/**
 * F10 (#46): validateCommunicationCreate の純粋検証テスト。
 * 必須/任意/値域/日時パース(日付のみ・tz 付き datetime・tz 無し拒否・実在日・年範囲)/件名長/本文長/
 * 添付配列の妥当性を網羅する。
 */

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function validRaw(over: Record<string, unknown> = {}) {
  return {
    advertiserId: ADV_ID,
    channel: "email",
    occurredAt: "2026-04-01",
    subject: "初回商談",
    ...over,
  };
}

describe("validateCommunicationCreate — 必須・既定値", () => {
  it("必須項目のみで成功し、任意は null/空に正規化される", () => {
    const r = validateCommunicationCreate(validRaw());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      advertiserId: ADV_ID,
      contractId: null,
      channel: "email",
      subject: "初回商談",
      bodyMd: "",
      attachments: [],
    });
    expect(r.value.occurredAt.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("全項目指定で成功する", () => {
    const r = validateCommunicationCreate(
      validRaw({
        contractId: CONTRACT_ID,
        channel: "meeting",
        bodyMd: "# 議事録\n合意事項...",
        attachments: ["bucket/obj1.pdf", " bucket/obj2.png "],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contractId).toBe(CONTRACT_ID);
    expect(r.value.channel).toBe("meeting");
    expect(r.value.bodyMd).toBe("# 議事録\n合意事項...");
    expect(r.value.attachments).toEqual(["bucket/obj1.pdf", "bucket/obj2.png"]);
  });
});

describe("validateCommunicationCreate — advertiserId / contractId", () => {
  it("advertiserId が UUID でないと invalid", () => {
    expect(validateCommunicationCreate(validRaw({ advertiserId: "nope" })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ advertiserId: undefined })).ok).toBe(false);
  });

  it("contractId は省略で null、UUID 不正で invalid", () => {
    const omitted = validateCommunicationCreate(validRaw({ contractId: "" }));
    expect(omitted.ok && omitted.value.contractId).toBe(null);
    expect(validateCommunicationCreate(validRaw({ contractId: "bad" })).ok).toBe(false);
  });
});

describe("validateCommunicationCreate — channel", () => {
  it("enum 4 値すべて受理", () => {
    for (const ch of COMMUNICATION_CHANNELS) {
      expect(validateCommunicationCreate(validRaw({ channel: ch })).ok).toBe(true);
    }
  });
  it("enum 外は invalid", () => {
    expect(validateCommunicationCreate(validRaw({ channel: "fax" })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ channel: 1 })).ok).toBe(false);
  });
});

describe("validateCommunicationCreate — occurredAt", () => {
  it("日付のみは UTC 0 時に正規化", () => {
    const r = validateCommunicationCreate(validRaw({ occurredAt: "2026-12-31" }));
    expect(r.ok && r.value.occurredAt.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });
  it("実在しない日付 (2026-02-30) は invalid", () => {
    expect(validateCommunicationCreate(validRaw({ occurredAt: "2026-02-30" })).ok).toBe(false);
  });
  it("Z 付き datetime を instant としてパース", () => {
    const r = validateCommunicationCreate(validRaw({ occurredAt: "2026-04-01T12:30:00Z" }));
    expect(r.ok && r.value.occurredAt.toISOString()).toBe("2026-04-01T12:30:00.000Z");
  });
  it("offset 付き datetime を UTC instant に換算", () => {
    const r = validateCommunicationCreate(validRaw({ occurredAt: "2026-04-01T09:00:00+09:00" }));
    expect(r.ok && r.value.occurredAt.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
  it("timezone 無し datetime は曖昧なので invalid", () => {
    expect(validateCommunicationCreate(validRaw({ occurredAt: "2026-04-01T09:00:00" })).ok).toBe(
      false,
    );
  });
  it("形式不正・年範囲外は invalid", () => {
    expect(validateCommunicationCreate(validRaw({ occurredAt: "yesterday" })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ occurredAt: "1999-12-31" })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ occurredAt: "2101-01-01" })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ occurredAt: 20260401 })).ok).toBe(false);
  });
});

describe("validateCommunicationCreate — subject / bodyMd", () => {
  it("件名は trim され、空は invalid", () => {
    const r = validateCommunicationCreate(validRaw({ subject: "  打合せ  " }));
    expect(r.ok && r.value.subject).toBe("打合せ");
    expect(validateCommunicationCreate(validRaw({ subject: "   " })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ subject: 5 })).ok).toBe(false);
  });
  it("件名 300 字超は invalid", () => {
    expect(validateCommunicationCreate(validRaw({ subject: "あ".repeat(301) })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ subject: "あ".repeat(300) })).ok).toBe(true);
  });
  it("本文は上限超で invalid、非文字列で invalid", () => {
    expect(validateCommunicationCreate(validRaw({ bodyMd: "x".repeat(20_001) })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ bodyMd: 123 })).ok).toBe(false);
  });
});

describe("validateCommunicationCreate — attachments", () => {
  it("配列でないと invalid", () => {
    expect(validateCommunicationCreate(validRaw({ attachments: "obj.pdf" })).ok).toBe(false);
  });
  it("件数上限超は invalid", () => {
    const many = Array.from({ length: 51 }, (_, i) => `obj-${i}`);
    expect(validateCommunicationCreate(validRaw({ attachments: many })).ok).toBe(false);
  });
  it("空文字・非文字列・長すぎ要素は invalid", () => {
    expect(validateCommunicationCreate(validRaw({ attachments: [""] })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ attachments: [42] })).ok).toBe(false);
    expect(validateCommunicationCreate(validRaw({ attachments: ["x".repeat(1025)] })).ok).toBe(
      false,
    );
  });
});
