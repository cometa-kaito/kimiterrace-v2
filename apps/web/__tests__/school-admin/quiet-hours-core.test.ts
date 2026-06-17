import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../lib/auth/session";
import {
  readQuietRanges,
  toQuietHoursActor,
  validateQuietHours,
} from "../../lib/school-admin/quiet-hours-core";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("toQuietHoursActor", () => {
  const base: AuthUser = { uid: "u1", role: "school_admin", schoolId: UUID };
  const OTHER = "22222222-2222-2222-2222-222222222222";

  it("school_admin: 自校 actor を返す (userRef=uid / identityUid=null)", () => {
    expect(toQuietHoursActor(base)).toEqual({
      actorUserId: "u1",
      userRef: "u1",
      identityUid: null,
      schoolId: UUID,
    });
  });

  it("school_admin: targetSchoolId は無視し必ず自校に固定する (越境防止)", () => {
    expect(toQuietHoursActor(base, OTHER)).toEqual({
      actorUserId: "u1",
      userRef: "u1",
      identityUid: null,
      schoolId: UUID,
    });
  });

  it("school_admin: 自校 (schoolId) が無ければ null", () => {
    expect(toQuietHoursActor({ ...base, schoolId: null })).toBeNull();
  });

  it("system_admin: 対象校指定で actor を返す (userRef=null で FK 回避 / identityUid=uid)", () => {
    expect(toQuietHoursActor({ ...base, role: "system_admin", schoolId: null }, UUID)).toEqual({
      actorUserId: "u1",
      userRef: null,
      identityUid: "u1",
      schoolId: UUID,
    });
  });

  it("system_admin: 対象校未指定 / 非 UUID は null (呼出側が forbidden 化)", () => {
    expect(toQuietHoursActor({ ...base, role: "system_admin", schoolId: null })).toBeNull();
    expect(toQuietHoursActor({ ...base, role: "system_admin", schoolId: null }, "nope")).toBeNull();
  });
});

describe("validateQuietHours", () => {
  it("正常: 単一時間帯を {ranges:[...]} に正規化する", () => {
    const r = validateQuietHours([{ start: "12:00", end: "13:00" }]);
    expect(r).toEqual({ ok: true, value: { ranges: [{ start: "12:00", end: "13:00" }] } });
  });

  it("正常: 空配列は「静粛時間なし」として許可 (全削除)", () => {
    expect(validateQuietHours([])).toEqual({ ok: true, value: { ranges: [] } });
  });

  it("正常: 複数時間帯を start 昇順に整列する", () => {
    const r = validateQuietHours([
      { start: "15:00", end: "16:00" },
      { start: "09:00", end: "10:00" },
    ]);
    expect(r.ok && r.value.ranges).toEqual([
      { start: "09:00", end: "10:00" },
      { start: "15:00", end: "16:00" },
    ]);
  });

  it("正常: 隣接 (前の end = 次の start) は重なりではなく許可", () => {
    const r = validateQuietHours([
      { start: "09:00", end: "10:00" },
      { start: "10:00", end: "11:00" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("境界: 00:00〜23:59 を許可", () => {
    expect(validateQuietHours([{ start: "00:00", end: "23:59" }]).ok).toBe(true);
  });

  it("異常: 配列でない入力は invalid", () => {
    expect(validateQuietHours("12:00-13:00").ok).toBe(false);
    expect(validateQuietHours(null).ok).toBe(false);
    expect(validateQuietHours({ start: "12:00", end: "13:00" }).ok).toBe(false);
  });

  it("異常: HH:MM 形式でない時刻は invalid", () => {
    expect(validateQuietHours([{ start: "9:00", end: "10:00" }]).ok).toBe(false); // 1桁時
    expect(validateQuietHours([{ start: "24:00", end: "25:00" }]).ok).toBe(false); // 時範囲外
    expect(validateQuietHours([{ start: "12:60", end: "13:00" }]).ok).toBe(false); // 分範囲外
    expect(validateQuietHours([{ start: "12-00", end: "13:00" }]).ok).toBe(false); // 区切り不正
    expect(validateQuietHours([{ start: "", end: "13:00" }]).ok).toBe(false); // 空欄
  });

  it("異常: start >= end (日跨ぎ含む) は invalid", () => {
    expect(validateQuietHours([{ start: "13:00", end: "12:00" }]).ok).toBe(false);
    expect(validateQuietHours([{ start: "12:00", end: "12:00" }]).ok).toBe(false); // 同時刻
  });

  it("異常: start / end を欠く要素は invalid", () => {
    expect(validateQuietHours([{ start: "12:00" }]).ok).toBe(false);
    expect(validateQuietHours([{}]).ok).toBe(false);
    expect(validateQuietHours([null]).ok).toBe(false);
  });

  it("異常: 重なる時間帯は invalid", () => {
    expect(
      validateQuietHours([
        { start: "09:00", end: "12:00" },
        { start: "11:00", end: "13:00" }, // 09-12 と重なる
      ]).ok,
    ).toBe(false);
    expect(
      validateQuietHours([
        { start: "09:00", end: "18:00" },
        { start: "12:00", end: "13:00" }, // 内包される
      ]).ok,
    ).toBe(false);
  });

  it("異常: 件数上限 (25 件) 超過は invalid", () => {
    const many = Array.from({ length: 25 }, (_, i) => {
      const h = String(i).padStart(2, "0");
      return { start: `${h}:00`, end: `${h}:30` };
    });
    expect(validateQuietHours(many).ok).toBe(false);
  });
});

describe("readQuietRanges", () => {
  it("保存済み {ranges:[...]} を復元する", () => {
    expect(readQuietRanges({ ranges: [{ start: "12:00", end: "13:00" }] })).toEqual([
      { start: "12:00", end: "13:00" },
    ]);
  });

  it("未設定 / 不正な value は空配列", () => {
    expect(readQuietRanges(null)).toEqual([]);
    expect(readQuietRanges({})).toEqual([]); // school_configs 既定 '{}'
    expect(readQuietRanges({ ranges: "nope" })).toEqual([]);
    expect(readQuietRanges("string")).toEqual([]);
  });

  it("ranges 内の不正要素は防御的に除外する", () => {
    expect(
      readQuietRanges({
        ranges: [{ start: "12:00", end: "13:00" }, { start: "bad", end: "x" }, null],
      }),
    ).toEqual([{ start: "12:00", end: "13:00" }]);
  });
});
