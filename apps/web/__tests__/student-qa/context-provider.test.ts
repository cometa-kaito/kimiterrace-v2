import { beforeEach, describe, expect, it, vi } from "vitest";

// packages/db のクエリ層を mock する (実 DB 不使用、ADR-012)。RLS / 公開状態の実 PG 挙動は
// packages/db 側の結合テストが担い、ここでは **プロバイダの合成ロジック** (status フィルタ /
// private 除外 / limit クランプ / activePublish 権威ゲート / 順序 / マッピング) のみを決定的に固める。
vi.mock("@kimiterrace/db", () => ({
  listContents: vi.fn(),
  getContentDetail: vi.fn(),
  getRelevantPublishedContent: vi.fn(),
}));

import type { EmbeddingClient } from "@kimiterrace/ai";
import { getContentDetail, getRelevantPublishedContent, listContents } from "@kimiterrace/db";
import type { TenantTx } from "@kimiterrace/db";
import {
  createPublishedContentProvider,
  createRagContentProvider,
} from "../../lib/student-qa/context-provider";

const CLASS_ID = "00000000-0000-0000-0000-0000000000bb";

// mock 関数の型付きハンドル。
const mockListContents = vi.mocked(listContents);
const mockGetContentDetail = vi.mocked(getContentDetail);
const mockGetRelevant = vi.mocked(getRelevantPublishedContent);

// 実 tx は使わない。プロバイダは tx をクエリ層へ素通しするだけなので不透明スタブで良い。
const tx = { __brand: "fake-tx" } as unknown as TenantTx;

type Summary = {
  id: string;
  title: string;
  status: "draft" | "published" | "archived";
  publishScope: string;
  updatedAt: Date;
};

function summary(id: string, publishScope: string): Summary {
  return {
    id,
    title: `title-${id}`,
    status: "published",
    publishScope,
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

/** getContentDetail の戻り値。active=false で activePublish:null (未公開/下書き相当)。 */
function detail(id: string, opts: { active?: boolean; body?: string } = {}) {
  const active = opts.active ?? true;
  return {
    content: {
      id,
      title: `title-${id}`,
      body: opts.body ?? `body-${id}`,
      publishScope: "school",
      status: "published" as const,
      targets: null,
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    },
    versions: [],
    activePublish: active
      ? { id: `pub-${id}`, versionId: `ver-${id}`, publishedAt: new Date("2026-06-01T00:00:00Z") }
      : null,
  };
}

/** id 集合に対し detail を引けるよう getContentDetail mock を構成する。 */
function wireDetails(map: Record<string, ReturnType<typeof detail> | null>) {
  mockGetContentDetail.mockImplementation(async (_tx, id: string) => map[id] ?? null);
}

describe("createPublishedContentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("公開中 (status='published') で listContents を呼ぶ", async () => {
    mockListContents.mockResolvedValue([]);
    const provider = createPublishedContentProvider();
    await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    expect(mockListContents).toHaveBeenCalledTimes(1);
    expect(mockListContents).toHaveBeenCalledWith(tx, { status: "published" });
  });

  it("active publish のあるコンテンツを {id,title,body} に整形して返す", async () => {
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "class")]);
    wireDetails({ a: detail("a"), b: detail("b") });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    expect(out).toEqual([
      { id: "a", title: "title-a", body: "body-a" },
      { id: "b", title: "title-b", body: "body-b" },
    ]);
  });

  it("activePublish===null は権威ゲートで除外する (status drift / unpublish 済を載せない)", async () => {
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "school")]);
    wireDetails({ a: detail("a", { active: false }), b: detail("b", { active: true }) });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    expect(out).toEqual([{ id: "b", title: "title-b", body: "body-b" }]);
  });

  it("getContentDetail が null (RLS 不可視 / 不存在) のものは除外する", async () => {
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "school")]);
    wireDetails({ a: null, b: detail("b") });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    expect(out).toEqual([{ id: "b", title: "title-b", body: "body-b" }]);
  });

  it("publishScope='private' は生徒 grounding から除外する (安全側)", async () => {
    mockListContents.mockResolvedValue([
      summary("pub", "school"),
      summary("priv", "private"),
      summary("cls", "class"),
      summary("hr", "homeroom"),
    ]);
    wireDetails({
      pub: detail("pub"),
      priv: detail("priv"),
      cls: detail("cls"),
      hr: detail("hr"),
    });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    expect(out.map((c) => c.id)).toEqual(["pub", "cls", "hr"]);
    // private は detail 取得すらしない (limit を消費しない)。
    expect(mockGetContentDetail).not.toHaveBeenCalledWith(tx, "priv");
  });

  it("limit 件にクランプし、private を弾いてから limit を消費する", async () => {
    mockListContents.mockResolvedValue([
      summary("priv1", "private"),
      summary("a", "school"),
      summary("b", "school"),
      summary("c", "school"),
    ]);
    wireDetails({ a: detail("a"), b: detail("b"), c: detail("c") });
    const provider = createPublishedContentProvider({ limit: 2 });
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    // private を除いた [a,b,c] の先頭 2 件 = [a,b]。private は limit を食わない。
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(mockGetContentDetail).toHaveBeenCalledTimes(2);
  });

  it("listContents の決定的順序を保持する", async () => {
    mockListContents.mockResolvedValue([
      summary("z", "school"),
      summary("m", "school"),
      summary("a", "school"),
    ]);
    wireDetails({ z: detail("z"), m: detail("m"), a: detail("a") });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    expect(out.map((c) => c.id)).toEqual(["z", "m", "a"]);
  });

  it("公開中ゼロ件なら空配列 (getContentDetail を呼ばない)", async () => {
    mockListContents.mockResolvedValue([]);
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "" });
    expect(out).toEqual([]);
    expect(mockGetContentDetail).not.toHaveBeenCalled();
  });

  it("limit はクランプされる (0→1, 上限超→20)", async () => {
    // limit=0 → 1 件に切り詰め。
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "school")]);
    wireDetails({ a: detail("a"), b: detail("b") });
    const out0 = await createPublishedContentProvider({ limit: 0 })(tx, {
      classId: CLASS_ID,
      maskedQuestion: "",
    });
    expect(out0.map((c) => c.id)).toEqual(["a"]);

    // limit=999 → MAX_LIMIT(20) 件まで。22 件中 20 件取得を確認。
    vi.clearAllMocks();
    const many = Array.from({ length: 22 }, (_, i) => summary(`n${i}`, "school"));
    mockListContents.mockResolvedValue(many);
    wireDetails(Object.fromEntries(many.map((s) => [s.id, detail(s.id)])));
    const outMax = await createPublishedContentProvider({ limit: 999 })(tx, {
      classId: CLASS_ID,
      maskedQuestion: "",
    });
    expect(outMax).toHaveLength(20);
  });
});

/** マスク済み質問→ベクトルを返すフェイク EmbeddingClient（embed の呼び出しを覗ける）。 */
function makeEmbeddingClient(vec: number[] = [0.1, 0.2]): {
  client: EmbeddingClient;
  embed: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async (_texts: string[]) => [vec]);
  return { client: { embed } as unknown as EmbeddingClient, embed };
}

/** getRelevantPublishedContent の 1 ヒット (RagMatch)。 */
function ragMatch(contentId: string) {
  return { contentId, versionId: `ver-${contentId}`, title: `title-${contentId}`, similarity: 0.9 };
}

describe("createRagContentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ベクトル検索ヒット時は match 順に grounding し、embed にマスク済み質問を渡す", async () => {
    const { client, embed } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("m1"), ragMatch("m2")]);
    wireDetails({ m1: detail("m1"), m2: detail("m2") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "体育祭はいつ？" });
    expect(out).toEqual([
      { id: "m1", title: "title-m1", body: "body-m1" },
      { id: "m2", title: "title-m2", body: "body-m2" },
    ]);
    // 生 PII を embedding しないため、provider に来たマスク済み質問をそのまま渡す。
    expect(embed).toHaveBeenCalledWith(["体育祭はいつ？"]);
    // ベクトル検索を使ったので MVP listContents は呼ばない。
    expect(mockListContents).not.toHaveBeenCalled();
  });

  it("limit を getRelevantPublishedContent に渡す", async () => {
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("m1")]);
    wireDetails({ m1: detail("m1") });
    const provider = createRagContentProvider({ embeddingClient: client, limit: 3 });
    await provider(tx, { classId: CLASS_ID, maskedQuestion: "q" });
    expect(mockGetRelevant).toHaveBeenCalledWith(tx, expect.any(Array), { limit: 3 });
  });

  it("ベクトル検索 0 件 (embedding 未投入相当) は MVP 直接取得にフォールバックする", async () => {
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([]);
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ a: detail("a") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "体育祭は？" });
    expect(out).toEqual([{ id: "a", title: "title-a", body: "body-a" }]);
    expect(mockListContents).toHaveBeenCalledWith(tx, { status: "published" });
  });

  it("空 (マスク後) 質問は embedding せず MVP フォールバックする", async () => {
    const { client, embed } = makeEmbeddingClient();
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ a: detail("a") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "   " });
    expect(embed).not.toHaveBeenCalled();
    expect(mockGetRelevant).not.toHaveBeenCalled();
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("ヒットしたが全て activePublish=null (権威ゲート) なら MVP フォールバックする", async () => {
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("m1")]);
    // m1 は権威ゲートで落ち、フォールバック先の a を採用。
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ m1: detail("m1", { active: false }), a: detail("a") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { classId: CLASS_ID, maskedQuestion: "体育祭は？" });
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("embedding 生成エラーは握り潰さず伝播する (誠実な失敗、フォールバックに乗らない)", async () => {
    const embed = vi.fn(async () => {
      throw new Error("vertex down");
    });
    const provider = createRagContentProvider({
      embeddingClient: { embed } as unknown as EmbeddingClient,
    });
    await expect(provider(tx, { classId: CLASS_ID, maskedQuestion: "体育祭は？" })).rejects.toThrow(
      "vertex down",
    );
    expect(mockListContents).not.toHaveBeenCalled();
  });
});
