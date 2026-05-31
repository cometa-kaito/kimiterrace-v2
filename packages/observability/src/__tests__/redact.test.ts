import { describe, expect, it } from "vitest";
import { redactPii } from "../redact.js";

/**
 * 脅威 I-03: ログ payload の PII 自動マスキング (redactPii) の決定的検証。
 * 「PII を渡したら平文が出力に残らない」を非空虚に固定する (threat-model I-03 の検知方法)。
 */

describe("redactPii — key denylist", () => {
  it("氏名/連絡先/自由記述の key は casing・区切りに依らず値ごと伏せる", () => {
    const out = redactPii({
      fullName: "田中太郎",
      student_name: "佐藤花子",
      "Guardian-Name": "田中一郎",
      phoneNumber: "09012345678",
      email: "taro@example.com",
      address: "岐阜県岐南町...",
      studentEpisode: "太郎くんが...",
      improvement: "もっと...",
    }) as Record<string, unknown>;

    for (const k of [
      "fullName",
      "student_name",
      "Guardian-Name",
      "phoneNumber",
      "email",
      "address",
      "studentEpisode",
      "improvement",
    ]) {
      expect(out[k]).toBe("***");
    }
  });

  it("stable ID 系 (id/schoolId/userId/contentId) は伏せない (rule4 推奨の安全な代替)", () => {
    const ids = {
      id: "11111111-1111-4111-8111-111111111111",
      schoolId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      contentId: "44444444-4444-4444-8444-444444444444",
    };
    expect(redactPii(ids)).toEqual(ids);
  });
});

describe("redactPii — 値の正規表現 (部分置換)", () => {
  it("denylist 外 key の文字列に埋め込まれたメール/電話を部分伏字 (文脈は残す)", () => {
    const out = redactPii({
      message: "連絡先は taro@example.com または 058-271-1111 です",
    }) as Record<string, string>;
    expect(out.message).toBe("連絡先は *** または *** です");
  });

  it("日付 YYYY-MM-DD は電話と誤検知しない (末尾桁不足)", () => {
    const out = redactPii({ when: "2026-05-31 に公開" }) as Record<string, string>;
    expect(out.when).toBe("2026-05-31 に公開");
  });

  it("ハイフン無しの連番 (UUID 断片等) は電話と誤検知しない", () => {
    const out = redactPii({ slug: "abcdef ghijkl", seq: "1234567890" }) as Record<string, string>;
    expect(out.slug).toBe("abcdef ghijkl");
    expect(out.seq).toBe("1234567890");
  });
});

describe("redactPii — phone/email 部分一致 (High-2 回帰)", () => {
  it("実スキーマの contact 系 (phone/email を含む key) を列挙せず部分一致で伏せる", () => {
    const out = redactPii({
      contactPhone: "09011112222", // 実列 contact_phone
      parent_email: "p@example.com",
      mobilePhone: "08033334444",
      guardianEmail: "g@example.com",
      schoolId: "s-1",
    }) as Record<string, unknown>;
    expect(out.contactPhone).toBe("***");
    expect(out.parent_email).toBe("***");
    expect(out.mobilePhone).toBe("***");
    expect(out.guardianEmail).toBe("***");
    expect(out.schoolId).toBe("s-1"); // 非 PII の stable ID は維持
  });

  it("phone/email 部分一致は telemetry/filename/ipAddress/className を誤検知しない", () => {
    const out = redactPii({
      telemetry: { enabled: true },
      fileName: "report.pdf",
      ipAddress: "10.0.0.1",
      className: "1-A",
    }) as Record<string, unknown>;
    expect((out.telemetry as Record<string, unknown>).enabled).toBe(true);
    expect(out.fileName).toBe("report.pdf");
    expect(out.ipAddress).toBe("10.0.0.1");
    expect(out.className).toBe("1-A");
  });
});

describe("redactPii — 再帰 / 構造", () => {
  it("ネストした object / array を深く伏せる", () => {
    const out = redactPii({
      school: { id: "s1", classes: [{ teacher: { fullName: "山田先生", id: "t1" } }] },
    }) as { school: { id: string; classes: Array<{ teacher: { fullName: string; id: string } }> } };
    expect(out.school.id).toBe("s1");
    expect(out.school.classes[0]?.teacher.fullName).toBe("***");
    expect(out.school.classes[0]?.teacher.id).toBe("t1");
  });

  it("非 PII プリミティブ (number/boolean/null) はそのまま", () => {
    expect(redactPii({ count: 5, ok: true, missing: null })).toEqual({
      count: 5,
      ok: true,
      missing: null,
    });
  });

  it("循環参照は [Circular] に倒し無限ループしない", () => {
    const a: Record<string, unknown> = { id: "x" };
    a.self = a;
    const out = redactPii(a) as Record<string, unknown>;
    expect(out.id).toBe("x");
    expect(out.self).toBe("[Circular]");
  });

  it("DAG (兄弟が同一ノードを共有する非循環参照) を [Circular] で消さない (Medium-1 回帰)", () => {
    const shared = { id: "shared-1", label: "x" };
    const out = redactPii({ a: shared, b: shared }) as {
      a: Record<string, unknown>;
      b: Record<string, unknown>;
    };
    // subtree 退出で seen から外れるため、2 度目の出現も完全に保持される (誤 [Circular] 無し)。
    expect(out.a).toEqual({ id: "shared-1", label: "x" });
    expect(out.b).toEqual({ id: "shared-1", label: "x" });
  });

  it("入力オブジェクトを破壊しない (新しい値を返す)", () => {
    const input = { fullName: "田中太郎", id: "x" };
    const out = redactPii(input);
    expect(input.fullName).toBe("田中太郎"); // 元は不変
    expect((out as Record<string, unknown>).fullName).toBe("***");
    expect(out).not.toBe(input);
  });
});
