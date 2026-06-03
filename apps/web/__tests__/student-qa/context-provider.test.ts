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
import type { RagAudience, TenantTx } from "@kimiterrace/db";
import type { GroundingResult } from "../../lib/student-qa/chat-service";
import {
  GROUNDING_SIMILARITY_THRESHOLD,
  createPublishedContentProvider,
  createRagContentProvider,
  selectGroundedMatches,
} from "../../lib/student-qa/context-provider";

const CLASS_ID = "00000000-0000-0000-0000-0000000000bb";
/** 生徒の classId と一致しない別クラス。#481-2 の class 境界除外を検証する。 */
const OTHER_CLASS_ID = "00000000-0000-0000-0000-0000000000cc";
/** 生徒 audience（自クラス境界、#481-2）。既存テストは生徒経路を前提に provider を呼ぶ。 */
const STUDENT_AUDIENCE: RagAudience = { kind: "student", classId: CLASS_ID };

/** provider は GroundingResult を返す。contexts だけ見たい既存アサート用の薄い抽出。 */
function contextsOf(r: GroundingResult): readonly { id: string; title: string; body: string }[] {
  return r.contexts;
}

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
function detail(
  id: string,
  opts: { active?: boolean; body?: string; publishScope?: string; targets?: unknown } = {},
) {
  const active = opts.active ?? true;
  return {
    content: {
      id,
      title: `title-${id}`,
      body: opts.body ?? `body-${id}`,
      publishScope: opts.publishScope ?? "school",
      status: "published" as const,
      targets: opts.targets ?? null,
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
    await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    expect(mockListContents).toHaveBeenCalledTimes(1);
    expect(mockListContents).toHaveBeenCalledWith(tx, { status: "published" });
  });

  it("active publish のあるコンテンツを {id,title,body} に整形して返す", async () => {
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "class")]);
    wireDetails({ a: detail("a"), b: detail("b") });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    expect(contextsOf(out)).toEqual([
      { id: "a", title: "title-a", body: "body-a" },
      { id: "b", title: "title-b", body: "body-b" },
    ]);
  });

  it("直接取得は意味的根拠を保証しないため常に general_supplement モード (ADR-028 §3)", async () => {
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ a: detail("a") });
    const out = await createPublishedContentProvider()(tx, {
      audience: STUDENT_AUDIENCE,
      maskedQuestion: "",
    });
    // 非空でも grounded と断定しない（更新新しい順は意味的近さでない）。
    expect(out.mode).toBe("general_supplement");
    expect(out.contexts.map((c) => c.id)).toEqual(["a"]);
  });

  it("activePublish===null は権威ゲートで除外する (status drift / unpublish 済を載せない)", async () => {
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "school")]);
    wireDetails({ a: detail("a", { active: false }), b: detail("b", { active: true }) });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    expect(contextsOf(out)).toEqual([{ id: "b", title: "title-b", body: "body-b" }]);
  });

  it("getContentDetail が null (RLS 不可視 / 不存在) のものは除外する", async () => {
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "school")]);
    wireDetails({ a: null, b: detail("b") });
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    expect(contextsOf(out)).toEqual([{ id: "b", title: "title-b", body: "body-b" }]);
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
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    expect(out.contexts.map((c) => c.id)).toEqual(["pub", "cls", "hr"]);
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
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    // private を除いた [a,b,c] の先頭 2 件 = [a,b]。private は limit を食わない。
    expect(out.contexts.map((c) => c.id)).toEqual(["a", "b"]);
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
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    expect(out.contexts.map((c) => c.id)).toEqual(["z", "m", "a"]);
  });

  it("公開中ゼロ件なら空配列 (getContentDetail を呼ばない)", async () => {
    mockListContents.mockResolvedValue([]);
    const provider = createPublishedContentProvider();
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "" });
    expect(contextsOf(out)).toEqual([]);
    expect(mockGetContentDetail).not.toHaveBeenCalled();
  });

  it("limit はクランプされる (0→1, 上限超→20)", async () => {
    // limit=0 → 1 件に切り詰め。
    mockListContents.mockResolvedValue([summary("a", "school"), summary("b", "school")]);
    wireDetails({ a: detail("a"), b: detail("b") });
    const out0 = await createPublishedContentProvider({ limit: 0 })(tx, {
      audience: STUDENT_AUDIENCE,
      maskedQuestion: "",
    });
    expect(out0.contexts.map((c) => c.id)).toEqual(["a"]);

    // limit=999 → MAX_LIMIT(20) 件まで。22 件中 20 件取得を確認。
    vi.clearAllMocks();
    const many = Array.from({ length: 22 }, (_, i) => summary(`n${i}`, "school"));
    mockListContents.mockResolvedValue(many);
    wireDetails(Object.fromEntries(many.map((s) => [s.id, detail(s.id)])));
    const outMax = await createPublishedContentProvider({ limit: 999 })(tx, {
      audience: STUDENT_AUDIENCE,
      maskedQuestion: "",
    });
    expect(outMax.contexts).toHaveLength(20);
  });

  it("生徒 audience: class/homeroom は自クラス(targets)のみ採用し他クラスを除外する (#481-2)", async () => {
    mockListContents.mockResolvedValue([
      summary("school", "school"),
      summary("mine", "class"),
      summary("other", "class"),
      summary("hr", "homeroom"),
    ]);
    wireDetails({
      school: detail("school", { publishScope: "school" }),
      mine: detail("mine", { publishScope: "class", targets: [CLASS_ID] }),
      other: detail("other", { publishScope: "class", targets: [OTHER_CLASS_ID] }),
      hr: detail("hr", { publishScope: "homeroom", targets: [CLASS_ID] }),
    });
    const out = await createPublishedContentProvider()(tx, {
      audience: STUDENT_AUDIENCE,
      maskedQuestion: "",
    });
    // school + 自クラスの class/homeroom のみ。別クラス向け(other)は混入しない（核心リスク）。
    expect(out.contexts.map((c) => c.id)).toEqual(["school", "mine", "hr"]);
  });

  it("生徒 audience で classId 無しは class/homeroom を突合不能で除外し school のみ (#481-2)", async () => {
    mockListContents.mockResolvedValue([summary("school", "school"), summary("cls", "class")]);
    wireDetails({
      school: detail("school", { publishScope: "school" }),
      cls: detail("cls", { publishScope: "class", targets: [CLASS_ID] }),
    });
    const out = await createPublishedContentProvider()(tx, {
      audience: { kind: "student", classId: null },
      maskedQuestion: "",
    });
    expect(out.contexts.map((c) => c.id)).toEqual(["school"]);
  });

  it("教員 audience (staff): class/homeroom も classId 非依存で全件採用する (#481-2)", async () => {
    mockListContents.mockResolvedValue([
      summary("school", "school"),
      summary("a", "class"),
      summary("b", "class"),
    ]);
    wireDetails({
      school: detail("school", { publishScope: "school" }),
      a: detail("a", { publishScope: "class", targets: [CLASS_ID] }),
      b: detail("b", { publishScope: "class", targets: [OTHER_CLASS_ID] }),
    });
    const out = await createPublishedContentProvider()(tx, {
      audience: { kind: "staff" },
      maskedQuestion: "",
    });
    // 教員はクラス非バインド: 他クラス向け(b)も含め全件。
    expect(out.contexts.map((c) => c.id)).toEqual(["school", "a", "b"]);
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

/** getRelevantPublishedContent の 1 ヒット (RagMatch)。similarity 既定 0.9 (閾値 0.70 以上=grounded)。 */
function ragMatch(contentId: string, similarity = 0.9) {
  return { contentId, versionId: `ver-${contentId}`, title: `title-${contentId}`, similarity };
}

describe("createRagContentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ベクトル検索ヒット時は match 順に grounded で grounding し、embed にマスク済み質問を渡す", async () => {
    const { client, embed } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("m1"), ragMatch("m2")]);
    wireDetails({ m1: detail("m1"), m2: detail("m2") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, {
      audience: STUDENT_AUDIENCE,
      maskedQuestion: "体育祭はいつ？",
    });
    // 閾値以上のヒットがあるので grounded (掲示準拠)。
    expect(out.mode).toBe("grounded");
    expect(out.contexts).toEqual([
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
    await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "q" });
    expect(mockGetRelevant).toHaveBeenCalledWith(tx, expect.any(Array), {
      limit: 3,
      audience: STUDENT_AUDIENCE,
    });
  });

  it("ベクトル検索 0 件 (embedding 未投入相当) は MVP 直接取得に general_supplement でフォールバックする", async () => {
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([]);
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ a: detail("a") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "体育祭は？" });
    // フォールバック文脈は意味的根拠未検証ゆえ general_supplement (ADR-028 §3)。
    expect(out.mode).toBe("general_supplement");
    expect(out.contexts).toEqual([{ id: "a", title: "title-a", body: "body-a" }]);
    expect(mockListContents).toHaveBeenCalledWith(tx, { status: "published" });
  });

  it("閾値 (cosine 類似度 0.70) 未満のヒットだけなら grounded にせず general_supplement でフォールバック", async () => {
    // 近傍は返るが全て弱い類似 (0.69 < 0.70) → 掲示準拠の根拠と見なさず捏造抑止側へ倒す。
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("weak", 0.69), ragMatch("weaker", 0.5)]);
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ weak: detail("weak"), weaker: detail("weaker"), a: detail("a") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "体育祭は？" });
    expect(out.mode).toBe("general_supplement");
    // 閾値未満のヒットは本文取得すらしない (grounding に採用しない)。
    expect(mockGetContentDetail).not.toHaveBeenCalledWith(tx, "weak");
    // フォールバック先 (最近の公開掲示物) が文脈になる。
    expect(out.contexts.map((c) => c.id)).toEqual(["a"]);
  });

  it("閾値ちょうど (0.70) のヒットは採用し grounded にする (境界 / 距離方向の取り違え pin)", async () => {
    // similarity 0.70 = cosine 距離 0.30。閾値は >= なので採用 (距離で <= 0.30 と等価)。
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("edge", GROUNDING_SIMILARITY_THRESHOLD)]);
    wireDetails({ edge: detail("edge") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "体育祭は？" });
    expect(out.mode).toBe("grounded");
    expect(out.contexts.map((c) => c.id)).toEqual(["edge"]);
    // フォールバックには乗らない (閾値を満たした)。
    expect(mockListContents).not.toHaveBeenCalled();
  });

  it("閾値以上と未満が混在: 以上のものだけ grounding に採用する", async () => {
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([
      ragMatch("ok1", 0.95),
      ragMatch("weak", 0.69),
      ragMatch("ok2", 0.71),
    ]);
    wireDetails({ ok1: detail("ok1"), weak: detail("weak"), ok2: detail("ok2") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "体育祭は？" });
    expect(out.mode).toBe("grounded");
    expect(out.contexts.map((c) => c.id)).toEqual(["ok1", "ok2"]);
    // 閾値未満 (weak) は本文取得しない。
    expect(mockGetContentDetail).not.toHaveBeenCalledWith(tx, "weak");
  });

  it("空 (マスク後) 質問は embedding せず general_supplement でフォールバックする", async () => {
    const { client, embed } = makeEmbeddingClient();
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ a: detail("a") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "   " });
    expect(embed).not.toHaveBeenCalled();
    expect(mockGetRelevant).not.toHaveBeenCalled();
    expect(out.mode).toBe("general_supplement");
    expect(out.contexts.map((c) => c.id)).toEqual(["a"]);
  });

  it("閾値以上だが全て activePublish=null (権威ゲート) なら general_supplement でフォールバックする", async () => {
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("m1")]);
    // m1 は権威ゲートで落ち、フォールバック先の a を採用。
    mockListContents.mockResolvedValue([summary("a", "school")]);
    wireDetails({ m1: detail("m1", { active: false }), a: detail("a") });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "体育祭は？" });
    expect(out.mode).toBe("general_supplement");
    expect(out.contexts.map((c) => c.id)).toEqual(["a"]);
  });

  it("embedding 生成エラーは握り潰さず伝播する (誠実な失敗、フォールバックに乗らない)", async () => {
    const embed = vi.fn(async () => {
      throw new Error("vertex down");
    });
    const provider = createRagContentProvider({
      embeddingClient: { embed } as unknown as EmbeddingClient,
    });
    await expect(
      provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "体育祭は？" }),
    ).rejects.toThrow("vertex down");
    expect(mockListContents).not.toHaveBeenCalled();
  });

  it("RAG grounded でも他クラス向け掲示は collectActiveContexts で除外する (多層防御 #481-2)", async () => {
    const { client } = makeEmbeddingClient();
    // rag-search は SQL で絞る想定だが mock は両方返す。アプリ層の collectActiveContexts が
    // 他クラス(other)を最終防御で落とすことを pin する（rag-search が将来退行しても漏れない）。
    mockGetRelevant.mockResolvedValue([ragMatch("mine"), ragMatch("other")]);
    wireDetails({
      mine: detail("mine", { publishScope: "class", targets: [CLASS_ID] }),
      other: detail("other", { publishScope: "class", targets: [OTHER_CLASS_ID] }),
    });
    const provider = createRagContentProvider({ embeddingClient: client });
    const out = await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "体育祭は？" });
    expect(out.contexts.map((c) => c.id)).toEqual(["mine"]);
  });

  it("RAG provider は audience を getRelevantPublishedContent に渡す (#481-2)", async () => {
    const { client } = makeEmbeddingClient();
    mockGetRelevant.mockResolvedValue([ragMatch("m1")]);
    wireDetails({ m1: detail("m1") });
    const provider = createRagContentProvider({ embeddingClient: client });
    await provider(tx, { audience: STUDENT_AUDIENCE, maskedQuestion: "q" });
    expect(mockGetRelevant).toHaveBeenCalledWith(tx, expect.any(Array), {
      limit: 6,
      audience: STUDENT_AUDIENCE,
    });
  });
});

describe("selectGroundedMatches (閾値フィルタ / 距離→類似度の方向性 pin)", () => {
  const m = (id: string, similarity: number) => ragMatch(id, similarity);

  it("similarity >= 0.70 のヒットだけ残す (0.70 ちょうどは採用)", () => {
    const out = selectGroundedMatches([m("a", 0.95), m("b", 0.7), m("c", 0.6999), m("d", 0.3)]);
    expect(out.map((x) => x.contentId)).toEqual(["a", "b"]);
  });

  it("全て閾値未満なら空 (掲示準拠の根拠なし)", () => {
    expect(selectGroundedMatches([m("x", 0.5), m("y", 0.69)])).toEqual([]);
  });

  it("入力の similarity 降順を保つ (上位 k の順序を壊さない)", () => {
    const out = selectGroundedMatches([m("hi", 0.99), m("mid", 0.8), m("lo", 0.7)]);
    expect(out.map((x) => x.contentId)).toEqual(["hi", "mid", "lo"]);
  });

  it("閾値定数は 0.70 (ADR-028 §結果 追補)", () => {
    expect(GROUNDING_SIMILARITY_THRESHOLD).toBe(0.7);
  });
});
