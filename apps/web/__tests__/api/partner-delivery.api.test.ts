import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）配信受け口
 * `POST /api/partner/delivery` ルートハンドラの単体テスト。
 *
 * 実 PG / 実 GCS は使わず `@kimiterrace/db` の `applyPartnerDelivery` / `withTenantContext` と `lib/db` の
 * `getDb`、asset 再ホストポートをモックして、ルートの「認証 → payload 検証 → asset 再ホスト → upsert → ステータス」
 * 配線と **【要件2】の HTTP ステータス選択（4xx=fatal / 5xx=transient）**を検証する。シークレット検証・payload
 * 検証は本物を通す。RLS/upsert/冪等の実挙動は packages/db 実 PG テスト（CI 実走）で担保する。
 */

// ---- モック: @kimiterrace/db（applyPartnerDelivery + withTenantContext を素通し） ----
const applyPartnerDelivery = vi.fn();
vi.mock("@kimiterrace/db", () => ({
  applyPartnerDelivery: (...args: unknown[]) => applyPartnerDelivery(...args),
  // withTenantContext はコールバックを {} tx で素通し実行（RLS は packages/db テストで担保）。
  withTenantContext: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

// ---- モック: asset 再ホストポート（fetch/GCS を介さず制御） ----
let rehostImpl: (fetchUrl: string, objectId: string) => Promise<string>;
class AssetRehostError extends Error {}
vi.mock("@/lib/partner/asset-rehost", () => ({
  AssetRehostError,
  getAssetRehost: () => ({ rehost: (u: string, id: string) => rehostImpl(u, id) }),
}));

const { POST } = await import("../../app/api/partner/delivery/route");

const SECRET = "test-partner-secret";
const PORTAL_CO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PORTAL_CONTRACT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PORTAL_PLACEMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const V2_SCHOOL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADVERTISER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function validBody(overrides?: Record<string, unknown>) {
  return {
    advertiser: {
      portalCompanyId: PORTAL_CO,
      companyName: "テスト広告社",
      industry: "製造",
      contactEmail: "ad@example.com",
      status: "active",
    },
    contract: {
      portalContractId: PORTAL_CONTRACT,
      monthlyFeeJpy: 30000,
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: null,
      targetV2SchoolIds: [V2_SCHOOL],
    },
    ads: [
      {
        portalPlacementId: PORTAL_PLACEMENT,
        v2SchoolId: V2_SCHOOL,
        scope: "school",
        mediaType: "image",
        durationSec: 7,
        displayOrder: 1,
        assetFetchUrl: "https://signed.example.com/asset.png?token=abc",
        caption: null,
        linkUrl: "https://advertiser.example.com/",
      },
    ],
    ...overrides,
  };
}

function makeReq(body: unknown, opts?: { key?: string; raw?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
  return new Request("https://example.com/api/partner/delivery", {
    method: "POST",
    headers,
    body: opts?.raw ?? JSON.stringify(body),
  });
}

describe("POST /api/partner/delivery (K3 §3)", () => {
  const prevSecret = process.env.PARTNER_API_SECRET;

  beforeEach(() => {
    applyPartnerDelivery.mockReset();
    applyPartnerDelivery.mockResolvedValue({
      applied: { advertisers: 1, contracts: 1, ads: 1 },
      advertiserId: ADVERTISER_ID,
    });
    // 既定: 再ホストは fetchUrl をそのまま返す（passthrough 相当）。
    rehostImpl = async (u) => u;
    process.env.PARTNER_API_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.PARTNER_API_SECRET;
    else process.env.PARTNER_API_SECRET = prevSecret;
  });

  // ---- 認証（401・fatal） ----
  it("シークレット env 未設定 → 401（fail-closed）、upsert なし", async () => {
    delete process.env.PARTNER_API_SECRET;
    const res = await POST(makeReq(validBody(), { key: SECRET }));
    expect(res.status).toBe(401);
    expect(applyPartnerDelivery).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、upsert なし", async () => {
    const res = await POST(makeReq(validBody(), { key: "wrong" }));
    expect(res.status).toBe(401);
    expect(applyPartnerDelivery).not.toHaveBeenCalled();
  });

  it("Authorization ヘッダ欠如 → 401", async () => {
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(401);
    expect(applyPartnerDelivery).not.toHaveBeenCalled();
  });

  // ---- payload 検証（400・fatal） ----
  it("不正 JSON → 400、upsert なし", async () => {
    const res = await POST(makeReq(null, { key: SECRET, raw: "{not json" }));
    expect(res.status).toBe(400);
    expect(applyPartnerDelivery).not.toHaveBeenCalled();
  });

  it("ads 0 件 → 400（最低 1 件、再送で直らない）", async () => {
    const res = await POST(makeReq(validBody({ ads: [] }), { key: SECRET }));
    expect(res.status).toBe(400);
    expect(applyPartnerDelivery).not.toHaveBeenCalled();
  });

  it("portalCompanyId が UUID でない → 400", async () => {
    const res = await POST(
      makeReq(
        validBody({
          advertiser: {
            portalCompanyId: "not-a-uuid",
            companyName: "X",
            industry: null,
            contactEmail: null,
            status: "active",
          },
        }),
        { key: SECRET },
      ),
    );
    expect(res.status).toBe(400);
    expect(applyPartnerDelivery).not.toHaveBeenCalled();
  });

  it("status が enum 外 → 400", async () => {
    const res = await POST(
      makeReq(
        validBody({
          advertiser: {
            portalCompanyId: PORTAL_CO,
            companyName: "X",
            industry: null,
            contactEmail: null,
            status: "deleted",
          },
        }),
        { key: SECRET },
      ),
    );
    expect(res.status).toBe(400);
  });

  // ---- 正常系（200） ----
  it("正鍵 + 正常 payload → 200 + applied + advertiserId", async () => {
    const res = await POST(makeReq(validBody(), { key: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: { advertisers: 1, contracts: 1, ads: 1 },
      advertiserId: ADVERTISER_ID,
    });
    expect(applyPartnerDelivery).toHaveBeenCalledTimes(1);
    // 再ホスト後の mediaUrl が DB 入力に載る（assetFetchUrl をそのまま渡す passthrough）。
    const input = applyPartnerDelivery.mock.calls[0]?.[1] as { ads: { mediaUrl: string }[] };
    expect(input.ads[0]?.mediaUrl).toBe("https://signed.example.com/asset.png?token=abc");
  });

  // ---- 【要件1】null contract ----
  it("contract 省略 → 200（contract は applyPartnerDelivery に null で渡る）", async () => {
    applyPartnerDelivery.mockResolvedValue({
      applied: { advertisers: 1, contracts: 0, ads: 1 },
      advertiserId: ADVERTISER_ID,
    });
    const body = validBody();
    delete (body as { contract?: unknown }).contract;
    const res = await POST(makeReq(body, { key: SECRET }));
    expect(res.status).toBe(200);
    const input = applyPartnerDelivery.mock.calls[0]?.[1] as { contract: unknown };
    expect(input.contract).toBeNull();
  });

  it("contract: null → 200（明示 null も許容）", async () => {
    applyPartnerDelivery.mockResolvedValue({
      applied: { advertisers: 1, contracts: 0, ads: 1 },
      advertiserId: ADVERTISER_ID,
    });
    const res = await POST(makeReq(validBody({ contract: null }), { key: SECRET }));
    expect(res.status).toBe(200);
    const input = applyPartnerDelivery.mock.calls[0]?.[1] as { contract: unknown };
    expect(input.contract).toBeNull();
  });

  it("contract.portalContractId: null → contract は渡るが portalContractId=null（DB 層で upsert 抑止）", async () => {
    applyPartnerDelivery.mockResolvedValue({
      applied: { advertisers: 1, contracts: 0, ads: 1 },
      advertiserId: ADVERTISER_ID,
    });
    const res = await POST(
      makeReq(
        validBody({
          contract: {
            portalContractId: null,
            monthlyFeeJpy: 30000,
            startedAt: "2026-06-01T00:00:00Z",
            endedAt: null,
            targetV2SchoolIds: [V2_SCHOOL],
          },
        }),
        { key: SECRET },
      ),
    );
    expect(res.status).toBe(200);
    const input = applyPartnerDelivery.mock.calls[0]?.[1] as {
      contract: { portalContractId: string | null };
    };
    expect(input.contract.portalContractId).toBeNull();
  });

  // ---- 【要件2】transient（5xx） ----
  it("asset 取得失敗（AssetRehostError）→ 502（transient・再送させる）、upsert なし", async () => {
    rehostImpl = async () => {
      throw new AssetRehostError("signed url expired");
    };
    const res = await POST(makeReq(validBody(), { key: SECRET }));
    expect(res.status).toBe(502);
    expect(applyPartnerDelivery).not.toHaveBeenCalled();
  });

  it("DB 一時エラー（コード無し）→ 500（transient・再送させる）", async () => {
    applyPartnerDelivery.mockRejectedValue(new Error("connection terminated"));
    const res = await POST(makeReq(validBody(), { key: SECRET }));
    expect(res.status).toBe(500);
  });

  it("直列化失敗 40001 → 500（transient）", async () => {
    applyPartnerDelivery.mockRejectedValue(
      Object.assign(new Error("serialization"), { code: "40001" }),
    );
    const res = await POST(makeReq(validBody(), { key: SECRET }));
    expect(res.status).toBe(500);
  });

  // ---- 【要件2】permanent（409） ----
  it("未知 v2School による FK 違反 23503 → 409（恒久・再送で直らない）", async () => {
    applyPartnerDelivery.mockRejectedValue(
      Object.assign(new Error("fk violation"), { code: "23503" }),
    );
    const res = await POST(makeReq(validBody(), { key: SECRET }));
    expect(res.status).toBe(409);
  });

  it("check 制約違反 23514 → 409（恒久）", async () => {
    applyPartnerDelivery.mockRejectedValue(
      Object.assign(new Error("check violation"), { code: "23514" }),
    );
    const res = await POST(makeReq(validBody(), { key: SECRET }));
    expect(res.status).toBe(409);
  });
});
