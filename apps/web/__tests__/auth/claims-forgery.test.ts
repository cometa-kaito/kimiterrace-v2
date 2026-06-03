import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S-04 / SEC-006: custom claims 偽造による権限昇格・RLS context 汚染の敵対監査。
 *
 * verifySessionCookie は SDK 検証を通った decoded token (localId + custom claims) を
 * normalizeClaims で値域検証し AuthUser に正規化する。攻撃者が特権 SA を侵害して任意 claim を
 * 載せた場合でも、アプリ層が「正規の role/uid/school_id のみ受理し、それ以外は null
 * (deny-by-default)」で昇格・汚染を止めることを、攻撃 payload で網羅的に固定する。
 *
 * - session.test.ts は仕様(正常系 + 代表異常)を確認する。本スイートは攻撃者の意図
 *   (system_admin への昇格 / RLS context `SET LOCAL app.*` の汚染) ベースで payload を網羅し、
 *   将来 normalizeClaims に trim / 小文字化 / 緩い比較を足したら生じる昇格穴を CI で検知する。
 * - S-01 の JWT 署名改竄 (alg:none / HS256 公開鍵悪用 / 署名不一致) は SDK 側
 *   (getAdminAuth().verifySessionCookie) が拒否する領域で、verify が throw→null に倒すことは
 *   session.test.ts が固定済。本スイートは SDK 検証を**通過した後**のアプリ層 claims 検証を攻める。
 * - 末尾に「正規 claims は通る」対比を置き、全 null になる vacuous テストでないことを保証する。
 */

const verifySessionCookie = vi.fn();
const createSessionCookie = vi.fn();
vi.mock("../../lib/auth/adminApp", () => ({
  getAdminAuth: () => ({ verifySessionCookie, createSessionCookie }),
}));

import { verifySessionCookie as verify } from "../../lib/auth/session";

const VALID_UID = "11111111-1111-4111-8111-111111111111";
const VALID_SCHOOL = "22222222-2222-4222-8222-222222222222";

// decoded claims を攻撃者が制御する任意 payload にして verify を叩くヘルパ
// (SDK 検証は通過した前提 = mockResolvedValue で decoded token を返す)。
async function verifyWithClaims(claims: Record<string, unknown>) {
  verifySessionCookie.mockResolvedValue(claims);
  return verify("attacker-cookie");
}

beforeEach(() => {
  verifySessionCookie.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("S-04: system_admin 昇格を狙う偽 role は全て拒否 (完全一致のみ昇格可)", () => {
  // 正規の "system_admin" 完全一致のみが system_admin になれる。以下は近似・偽装で、
  // null でなければ昇格穴 (大文字化・trim・部分一致などの緩い比較が入った瞬間に破綻する)。
  const forgedRoles = [
    "SYSTEM_ADMIN",
    "System_Admin",
    " system_admin",
    "system_admin ",
    "system_admin\n",
    "system_admin\t",
    "system-admin",
    "systemadmin",
    "root",
    "admin",
    "superadmin",
    "owner",
    "",
    "*",
  ];
  for (const role of forgedRoles) {
    it(`role=${JSON.stringify(role)} → null (昇格不能)`, async () => {
      const user = await verifyWithClaims({ uid: VALID_UID, role, school_id: VALID_SCHOOL });
      expect(user).toBeNull();
    });
  }
});

describe("型混同 claims (JWT は任意 JSON 値を載せられる) は全て拒否", () => {
  // role / uid / school_id に string 以外を載せる攻撃。typeof string チェックで全て deny。
  // 特に { toString } は文字列化で正規値に化ける偽装だが、typeof object ゆえ弾かれること。
  const nonStringValues: { label: string; value: unknown }[] = [
    { label: "array", value: ["system_admin"] },
    { label: "toString-object", value: { toString: () => "system_admin" } },
    { label: "number", value: 123 },
    { label: "boolean", value: true },
    { label: "null", value: null },
  ];
  for (const { label, value } of nonStringValues) {
    it(`role=${label} → null`, async () => {
      const user = await verifyWithClaims({ uid: VALID_UID, role: value, school_id: VALID_SCHOOL });
      expect(user).toBeNull();
    });
    it(`uid=${label} → null`, async () => {
      const user = await verifyWithClaims({ uid: value, role: "teacher", school_id: VALID_SCHOOL });
      expect(user).toBeNull();
    });
  }
});

describe("uid 汚染 (RLS context app.current_user_id へ流す前に倒す)", () => {
  // UUID 以外は全て null。SQLi 様・末尾空白・超長・UUID 近似 (1 桁不足/ハイフン無し) を網羅。
  const taintedUids: { label: string; value: string }[] = [
    { label: "sqli", value: "' OR '1'='1" },
    { label: "sqli-append", value: `${VALID_UID}; DROP TABLE users;--` },
    { label: "trailing-space", value: `${VALID_UID} ` },
    { label: "no-hyphen", value: "11111111111141118111111111111111" },
    { label: "one-short", value: "11111111-1111-4111-8111-11111111111" },
    { label: "oversized", value: "1".repeat(5000) },
    { label: "plain", value: "not-a-uuid" },
  ];
  for (const { label, value } of taintedUids) {
    it(`uid=${label} → null`, async () => {
      const user = await verifyWithClaims({ uid: value, role: "teacher", school_id: VALID_SCHOOL });
      expect(user).toBeNull();
    });
  }
});

describe("school_id 汚染 / 越境注入 (テナント分離キーを汚さない)", () => {
  const taintedSchoolIds: { label: string; value: string }[] = [
    { label: "sqli", value: "' OR '1'='1" },
    { label: "guc-injection", value: `${VALID_SCHOOL}'; SET app.current_school_id='other` },
    { label: "trailing-space", value: `${VALID_SCHOOL} ` },
    { label: "plain", value: "not-a-uuid" },
  ];
  for (const { label, value } of taintedSchoolIds) {
    it(`teacher school_id=${label} → null`, async () => {
      const user = await verifyWithClaims({ uid: VALID_UID, role: "teacher", school_id: value });
      expect(user).toBeNull();
    });
    it(`system_admin school_id=${label} (越境昇格狙い) → null`, async () => {
      const user = await verifyWithClaims({
        uid: VALID_UID,
        role: "system_admin",
        school_id: value,
      });
      expect(user).toBeNull();
    });
  }
});

describe("正の対比 (敵対網羅が vacuous でないことの保証)", () => {
  // 正規 claims は AuthUser を返す。これが通らないと上の全 null は「常に null」の無意味テストになる。
  it("正規の system_admin claims → AuthUser (schoolId=null)", async () => {
    const user = await verifyWithClaims({ uid: VALID_UID, role: "system_admin" });
    expect(user).toEqual({ uid: VALID_UID, role: "system_admin", schoolId: null });
  });

  it("正規の teacher claims → AuthUser", async () => {
    const user = await verifyWithClaims({
      uid: VALID_UID,
      role: "teacher",
      school_id: VALID_SCHOOL,
    });
    expect(user).toEqual({ uid: VALID_UID, role: "teacher", schoolId: VALID_SCHOOL });
  });
});
