import { describe, expect, it } from "vitest";
import { getEffectCommentStats } from "../../lib/dashboard/effect-comment-stats";

/**
 * F08 (#44, slice 2): `getEffectCommentStats` の集計配線 + **JST 月境界**の単体検証。
 *
 * クエリは `apps/web` inline (packages/db chokepoint 回避)。`make_timestamptz` の実評価は実 PG が要るが、
 * **月境界の正しさ = 当月/前月/翌月の (year, month) ロールオーバーが JS 側で解かれること**は SQL 断片の
 * パラメータを捕捉して決定的に検証できる。実 PG での丸め挙動は packages/db の `monthly-report.test.ts`
 * (同じ make_timestamptz 方式) が担保する。本テストは:
 *  - 当月/前月/翌月境界の (year, month) が make_timestamptz に正しく渡る (3/5/7/10/12 + 年跨ぎ 1 月)
 *  - **`+ interval '1 month'` を使っていない** (#341 の既知罠回避)
 *  - metrics の current=当月 / previous=前月 マッピング (閲覧/タップ/Q&A)
 *  - topContent の並び (反応降順) と limit、当月のみ採用
 *  - 空月 → metrics 全 0 + topContent 空配列
 *  - month ラベル / 範囲外 month の RangeError
 * を突く。
 */

/** 1 回の `db.select(...)` 呼び出しが組み立てた SQL の断片文字列と返却行。 */
interface CapturedQuery {
  /** WHERE / ORDER BY 等に現れた SQL 断片を平坦化した文字列 (数値パラメータは `[v]` 形式)。 */
  fragments: string[];
  rows: unknown[];
}

/** drizzle の SQL ノード (queryChunks を持つ) か。 */
function isSqlNode(v: unknown): v is { queryChunks: unknown[] } {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { queryChunks?: unknown }).queryChunks)
  );
}

/**
 * drizzle の `SQL` を文字列へ潰す。StringChunk は素の文字列、`Number` パラメータ chunk は `valueOf()`
 * を `[v]` で表す (make_timestamptz の引数値を可視化する。実構造は probe で確認済み)。Column 等
 * その他 chunk は識別子文字列化を試み、無ければ無視する。ネストした SQL (and/gte/lt 由来) は再帰。
 */
function renderSql(value: unknown, out: string[]): void {
  if (!isSqlNode(value)) return;
  const parts: string[] = [];
  for (const chunk of value.queryChunks) {
    if (isSqlNode(chunk)) {
      const nested: string[] = [];
      renderSql(chunk, nested);
      parts.push(nested.join(""));
    } else if (chunk?.constructor?.name === "StringChunk") {
      const v = (chunk as { value: unknown }).value;
      parts.push(typeof v === "string" ? v : Array.isArray(v) ? v.join("") : "");
    } else if (chunk?.constructor?.name === "Number") {
      parts.push(`[${(chunk as { valueOf: () => unknown }).valueOf()}]`);
    } else if (typeof chunk === "object" && chunk !== null && "name" in chunk) {
      // Column: 識別子名を出す (ordering キーの可視化用)。
      parts.push(String((chunk as { name: unknown }).name));
    }
    // それ以外 (Param 等) は本テストの観点に不要なので無視。
  }
  out.push(parts.join(""));
}

/** 行を解決する Promise + drizzle 風のチェーンメソッド。 */
type ChainPromise = Promise<unknown[]> & {
  from: () => ChainPromise;
  innerJoin: () => ChainPromise;
  groupBy: () => ChainPromise;
  orderBy: (...args: unknown[]) => ChainPromise;
  where: (cond: unknown) => ChainPromise;
  limit: () => ChainPromise;
};

/**
 * drizzle の select チェーンを捕捉する fake。各 `select()` ごとに渡された SQL 断片を記録し、
 * テストが事前にセットした行を返す。`rowsQueue` は呼び出し順 (当月 totals → 当月 top → 前月 totals
 * → 前月 top) に対応する。
 */
function makeFakeDb(rowsQueue: unknown[][]) {
  const captured: CapturedQuery[] = [];
  let callIndex = 0;

  // チェーンは「行を解決する Promise」にメソッドを生やしたもの。await は Promise.prototype.then
  // 経由で解決するため、`then` を自前プロパティとして定義しない (biome noThenProperty 回避)。
  // 終端 (groupBy / limit) でも非終端 (from/where/...) でも同じ thenable を返すので、totals は
  // groupBy で、top は limit で await される。
  function makeChain(current: CapturedQuery): ChainPromise {
    const chain = Object.assign(Promise.resolve(current.rows), {
      from: () => chain,
      innerJoin: () => chain,
      groupBy: () => chain,
      orderBy: (...args: unknown[]) => {
        for (const a of args) renderSql(a, current.fragments);
        return chain;
      },
      where: (cond: unknown) => {
        // and(...) は SQL を内包。queryChunks を辿って make_timestamptz 引数まで描画する。
        renderSql(cond, current.fragments);
        return chain;
      },
      limit: () => chain,
    });
    return chain;
  }

  const db = {
    select: () => {
      const current: CapturedQuery = { fragments: [], rows: rowsQueue[callIndex] ?? [] };
      callIndex += 1;
      captured.push(current);
      return makeChain(current);
    },
  };
  // getEffectCommentStats は `Pick<TenantTx, "select">` を要求する。fake は drizzle の重い
  // PgSelectBuilder 型を満たさないため、テスト境界で 1 度だけ目的の引数型へ寄せる
  // (実体は本テストが使う select チェーンだけを実装した stub)。
  return { db: db as unknown as FakeSelectable, captured };
}

/** `getEffectCommentStats` が受ける db 引数型 (Pick<TenantTx, "select">)。 */
type FakeSelectable = Parameters<typeof getEffectCommentStats>[0];

/** make_timestamptz(...) 断片から (year, month) の組を全部抜き出す。 */
function timestamptzArgs(captured: CapturedQuery[]): Array<[number, number]> {
  const joined = captured.flatMap((c) => c.fragments).join(" | ");
  const out: Array<[number, number]> = [];
  const re = /make_timestamptz\(\[(\d+)\]::int,\s*\[(\d+)\]::int/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: 標準的な exec ループ
  while ((m = re.exec(joined)) !== null) {
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

/** 全断片を 1 本にした文字列 (interval 罠の不在検査用)。 */
function allFragments(captured: CapturedQuery[]): string {
  return captured.flatMap((c) => c.fragments).join(" ");
}

describe("getEffectCommentStats (集計配線 + JST 月境界)", () => {
  it("metrics: current=当月 / previous=前月 を 閲覧/タップ/Q&A にマッピング", async () => {
    // 呼び出し順: [当月 totals, 当月 top, 前月 totals, 前月 top]
    const { db } = makeFakeDb([
      [
        { type: "view", n: 100 },
        { type: "tap", n: 30 },
        { type: "ask", n: 7 },
      ],
      [{ contentId: "c1", title: "体育祭", reactions: 130 }],
      [
        { type: "view", n: 80 },
        { type: "tap", n: 20 },
        { type: "ask", n: 3 },
      ],
      [],
    ]);

    const stats = await getEffectCommentStats(db, { year: 2026, month: 6 });

    expect(stats.month).toBe("2026-06");
    expect(stats.metrics).toEqual([
      { label: "閲覧", current: 100, previous: 80 },
      { label: "タップ", current: 30, previous: 20 },
      { label: "Q&A", current: 7, previous: 3 },
    ]);
    // topContent は **当月** の上位のみ (前月 top は metrics の previous 件数取得にのみ使う)。
    expect(stats.topContent).toEqual([{ title: "体育祭", reactions: 130 }]);
  });

  it("空月: 当月に event 無し → metrics 全 0 + topContent 空配列", async () => {
    const { db } = makeFakeDb([[], [], [], []]);
    const stats = await getEffectCommentStats(db, { year: 2026, month: 6 });
    expect(stats.metrics).toEqual([
      { label: "閲覧", current: 0, previous: 0 },
      { label: "タップ", current: 0, previous: 0 },
      { label: "Q&A", current: 0, previous: 0 },
    ]);
    expect(stats.topContent).toEqual([]);
  });

  it("topContent: 渡された反応降順をそのまま採用し、limit を超えない", async () => {
    const top = [
      { contentId: "a", title: "A", reactions: 50 },
      { contentId: "b", title: "B", reactions: 40 },
      { contentId: "c", title: "C", reactions: 30 },
    ];
    const { db, captured } = makeFakeDb([[], top, [], []]);
    const stats = await getEffectCommentStats(db, { year: 2026, month: 6, topLimit: 3 });
    expect(stats.topContent).toEqual([
      { title: "A", reactions: 50 },
      { title: "B", reactions: 40 },
      { title: "C", reactions: 30 },
    ]);
    // ランキングは count(*) desc → title → contentId で決定的 (getEventStats と同方針)。
    expect(allFragments(captured)).toContain("count(*) desc");
  });

  // 各月の当月/前月/翌月の (year, month) が JS 側で正しくロールオーバーされていることを直接検証する。
  // 当月の集計は当月窓 [当月, 翌月) と前月窓 [前月, 当月) を使うため、make_timestamptz には
  // {前月, 当月, 翌月} の 3 つの (year, month) が現れる (当月境界は両窓で共有)。
  it.each([
    { year: 2026, month: 3, prev: [2026, 2], cur: [2026, 3], next: [2026, 4] },
    { year: 2026, month: 5, prev: [2026, 4], cur: [2026, 5], next: [2026, 6] },
    { year: 2026, month: 7, prev: [2026, 6], cur: [2026, 7], next: [2026, 8] },
    { year: 2026, month: 10, prev: [2026, 9], cur: [2026, 10], next: [2026, 11] },
    { year: 2026, month: 12, prev: [2026, 11], cur: [2026, 12], next: [2027, 1] }, // 翌月で年跨ぎ
    { year: 2026, month: 1, prev: [2025, 12], cur: [2026, 1], next: [2026, 2] }, // 前月で年跨ぎ
  ])("JST 月境界: $year-$month の前月/当月/翌月が make_timestamptz に正しく渡る (年跨ぎ含む)", async ({
    year,
    month,
    prev,
    cur,
    next,
  }) => {
    const { db, captured } = makeFakeDb([[], [], [], []]);
    await getEffectCommentStats(db, { year, month });

    const args = timestamptzArgs(captured);
    const has = (ym: number[]) => args.some(([y, m]) => y === ym[0] && m === ym[1]);
    expect(has(prev)).toBe(true);
    expect(has(cur)).toBe(true);
    expect(has(next)).toBe(true);
    // 既知罠 (#341): セッション TZ 依存の月加算を使わない。
    expect(allFragments(captured)).not.toContain("interval");
  });

  it("範囲外 month は RangeError、DB に触れない", async () => {
    const { db, captured } = makeFakeDb([[], [], [], []]);
    await expect(getEffectCommentStats(db, { year: 2026, month: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(getEffectCommentStats(db, { year: 2026, month: 13 })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(captured.length).toBe(0);
  });

  it("非整数 year は RangeError", async () => {
    const { db } = makeFakeDb([[], [], [], []]);
    await expect(getEffectCommentStats(db, { year: 2026.5, month: 6 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
