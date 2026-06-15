import type { EmbeddingClient, PiiEntry } from "@kimiterrace/ai";
import { describe, expect, it } from "vitest";
import {
  type EmbeddingBatchPort,
  type PendingVersion,
  embedPendingContent,
} from "../embed-content.js";
import { snapshotToEmbeddingText } from "../text.js";

const DIM = 768;

/** 入力テキストを記録し、各テキストに長さ DIM の決定的ベクトルを返すフェイク。 */
function fakeClient(): EmbeddingClient & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    seen,
    async embed(texts: string[]): Promise<number[][]> {
      seen.push(texts);
      return texts.map((_t, i) => new Array<number>(DIM).fill(i + 1));
    },
  };
}

/** listPending を固定し、saveEmbedding を記録するフェイクポート。 */
function fakePort(pending: PendingVersion[]): EmbeddingBatchPort & {
  saved: { versionId: string; embedding: number[] }[];
} {
  const saved: { versionId: string; embedding: number[] }[] = [];
  return {
    saved,
    async listPending() {
      return pending;
    },
    async saveEmbedding(versionId, embedding) {
      saved.push({ versionId, embedding });
    },
  };
}

describe("snapshotToEmbeddingText", () => {
  it("title + body を改行結合する", () => {
    expect(snapshotToEmbeddingText({ title: "体育祭", body: "9/1 開催" })).toBe("体育祭\n9/1 開催");
  });

  it("body が無ければ title のみ", () => {
    expect(snapshotToEmbeddingText({ title: "お知らせ" })).toBe("お知らせ");
  });

  it("前後空白を trim し、空フィールドは除外する", () => {
    expect(snapshotToEmbeddingText({ title: "  ", body: "  本文  " })).toBe("本文");
  });

  it("title/body が無い・非オブジェクト・null は空文字", () => {
    expect(snapshotToEmbeddingText({ publishScope: "school" })).toBe("");
    expect(snapshotToEmbeddingText(null)).toBe("");
    expect(snapshotToEmbeddingText("文字列")).toBe("");
    expect(snapshotToEmbeddingText({ title: 123, body: false })).toBe("");
  });
});

describe("embedPendingContent", () => {
  it("公開中・未生成 version をすべて埋め込み、versionId 対応で保存する", async () => {
    const port = fakePort([
      { versionId: "v1", snapshot: { title: "a", body: "aa" } },
      { versionId: "v2", snapshot: { title: "b", body: "bb" } },
    ]);
    const client = fakeClient();

    const res = await embedPendingContent(port, client);

    expect(res).toEqual({ scanned: 2, embedded: 2, skippedEmptyText: 0, blockedUnmaskedPii: 0 });
    expect(port.saved.map((s) => s.versionId)).toEqual(["v1", "v2"]);
    expect(port.saved.at(0)?.embedding).toHaveLength(DIM);
  });

  it("ルール4: 電話・メールは embedding 生成前にマスクされる（生 PII を Vertex へ送らない）", async () => {
    const port = fakePort([
      {
        versionId: "v1",
        snapshot: { title: "保護者連絡", body: "担当へ 090-1234-5678 か tanaka@example.com まで" },
      },
    ]);
    const client = fakeClient();

    await embedPendingContent(port, client);

    const sent = client.seen.at(0)?.at(0) ?? "";
    expect(sent).not.toContain("090-1234-5678");
    expect(sent).not.toContain("tanaka@example.com");
    // トークン化されている（{{PHONE_001}} / {{EMAIL_001}} 形）。
    expect(sent).toMatch(/\{\{[A-Z]+_\d{3}\}\}/);
  });

  it("ルール4: 名簿（roster）の氏名も embedding 生成前にマスクされる", async () => {
    const roster: PiiEntry[] = [{ value: "田中太郎", category: "STUDENT" }];
    const port = fakePort([
      { versionId: "v1", snapshot: { title: "欠席連絡", body: "田中太郎さんは本日欠席です" } },
    ]);
    const client = fakeClient();

    await embedPendingContent(port, client, { maskEntries: roster });

    const sent = client.seen.at(0)?.at(0) ?? "";
    expect(sent).not.toContain("田中太郎");
    expect(sent).toContain("{{STUDENT_001}}");
  });

  it("埋め込みテキストが空の version は skip（embedding 生成しない）", async () => {
    const port = fakePort([
      { versionId: "v1", snapshot: { title: "ある", body: "" } },
      { versionId: "empty", snapshot: { publishScope: "school" } },
    ]);
    const client = fakeClient();

    const res = await embedPendingContent(port, client);

    expect(res).toEqual({ scanned: 2, embedded: 1, skippedEmptyText: 1, blockedUnmaskedPii: 0 });
    expect(port.saved.map((s) => s.versionId)).toEqual(["v1"]);
    // skip した version のテキストは client へ渡らない。
    expect(client.seen.flat()).toHaveLength(1);
  });

  it("ルール4 fail-closed: マスク後も PII 形跡が残る version は Vertex へ送らず skip し件数を記録", async () => {
    // maskOptions で電話検出を無効化 → maskPII は電話を残すが、findUnmaskedPii は
    // (detectPhones に関係なく) 電話形式を検出する。embedding は永続するため、ここで止める。
    const port = fakePort([
      { versionId: "leak", snapshot: { title: "連絡", body: "至急 090-1234-5678 へ" } },
      { versionId: "ok", snapshot: { title: "お知らせ", body: "体育祭は 9/1" } },
    ]);
    const client = fakeClient();

    const res = await embedPendingContent(port, client, {
      maskOptions: { detectPhones: false },
    });

    expect(res).toEqual({ scanned: 2, embedded: 1, skippedEmptyText: 0, blockedUnmaskedPii: 1 });
    // PII 残存 version は save も client 送信もされない（生 PII を Vertex へ出さない）。
    expect(port.saved.map((s) => s.versionId)).toEqual(["ok"]);
    expect(client.seen.flat().join("")).not.toContain("090-1234-5678");
  });

  it("batchSize ごとに embed を分割呼び出しする", async () => {
    const pending: PendingVersion[] = Array.from({ length: 5 }, (_x, i) => ({
      versionId: `v${i}`,
      snapshot: { title: `t${i}`, body: `b${i}` },
    }));
    const port = fakePort(pending);
    const client = fakeClient();

    const res = await embedPendingContent(port, client, { batchSize: 2 });

    expect(res.embedded).toBe(5);
    // 5 件を batchSize=2 → 3 回（2,2,1）。
    expect(client.seen.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(port.saved).toHaveLength(5);
  });

  it("pending が空なら embed も save も呼ばない", async () => {
    const port = fakePort([]);
    const client = fakeClient();

    const res = await embedPendingContent(port, client);

    expect(res).toEqual({ scanned: 0, embedded: 0, skippedEmptyText: 0, blockedUnmaskedPii: 0 });
    expect(client.seen).toHaveLength(0);
    expect(port.saved).toHaveLength(0);
  });

  it("batchSize が非数値（NaN）でも既定 32 に倒して全件埋め込む（無言 0 件失敗の回帰）", async () => {
    // 非数値 env（EMBED_BATCH_SIZE="abc" 等）が `Number.parseInt` → NaN として伝播した場合、旧実装は
    // `Math.max(1, Math.trunc(NaN)) = NaN` で分割ループ（`i += NaN`）が 1 周も回らず embedded:0 になっていた。
    const pending: PendingVersion[] = Array.from({ length: 3 }, (_x, i) => ({
      versionId: `v${i}`,
      snapshot: { title: `t${i}`, body: `b${i}` },
    }));
    const port = fakePort(pending);
    const client = fakeClient();

    const res = await embedPendingContent(port, client, { batchSize: Number.NaN });

    expect(res.embedded).toBe(3);
    expect(port.saved).toHaveLength(3);
    // 既定 32 ＞ 件数なので 1 チャンクにまとまる。
    expect(client.seen.map((c) => c.length)).toEqual([3]);
  });

  it("client が返す embedding 数がチャンクと不一致なら throw", async () => {
    const port = fakePort([{ versionId: "v1", snapshot: { title: "a", body: "aa" } }]);
    const brokenClient: EmbeddingClient = {
      async embed() {
        return []; // 1 件要求に 0 件返す
      },
    };
    await expect(embedPendingContent(port, brokenClient)).rejects.toThrow(/数がチャンクと不一致/);
  });
});
