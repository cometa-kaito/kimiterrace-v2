import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MagicLinkManager } from "../../app/admin/editor/[classId]/magic-link/_components/MagicLinkManager";

/**
 * F05 (#41): MagicLinkManager のテスト。fetch / clipboard を mock。
 * 発行が確定 URL を 1 回だけ表示し一覧を再取得すること、有効期限のクライアント検証、
 * 失効の 2 段階確認、コピーを検証する。token は API レスポンスでしか得られないため、
 * 一覧表示には token を含めない設計を前提とする。
 */

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("MagicLinkManager", () => {
  it("既定発行: classId のみ POST し、1 回限りの URL を表示して一覧を再取得", async () => {
    const fetchFn = stubFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (url === "/api/magic-links" && method === "POST") {
        return Promise.resolve(
          jsonRes({ id: "ml-1", path: "/s/TOKEN123", expiresAt: "2026-09-01T00:00:00.000Z" }, 201),
        );
      }
      if (url.startsWith("/api/magic-links?classId=") && method === "GET") {
        return Promise.resolve(
          jsonRes({
            links: [
              {
                id: "ml-1",
                expiresAt: "2026-09-01T00:00:00.000Z",
                createdAt: "2026-05-31T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonRes({ error: "unexpected" }, 500));
    });

    render(<MagicLinkManager classId={CLASS_ID} initialLinks={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "新しいリンクを発行" }));

    const issued = await screen.findByTestId("issued-url");
    expect(issued).toHaveTextContent(`${window.location.origin}/s/TOKEN123`);

    const postCall = fetchFn.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ classId: CLASS_ID });
    // 発行後に GET で一覧を再取得して反映する。
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some((c) => String(c[0]).startsWith("/api/magic-links?classId=")),
      ).toBe(true),
    );
  });

  it("有効期限を指定すると expiresInDays を付けて送る", async () => {
    const fetchFn = stubFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (url === "/api/magic-links" && method === "POST") {
        return Promise.resolve(jsonRes({ id: "ml-2", path: "/s/T", expiresAt: "x" }, 201));
      }
      return Promise.resolve(jsonRes({ links: [] }));
    });
    render(<MagicLinkManager classId={CLASS_ID} initialLinks={[]} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "新しいリンクを発行" }));
    await screen.findByTestId("issued-url");
    const postCall = fetchFn.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      classId: CLASS_ID,
      expiresInDays: 30,
    });
  });

  it("範囲外の有効期限はクライアントで弾き、fetch しない", () => {
    const fetchFn = stubFetch(() => Promise.resolve(jsonRes({})));
    render(<MagicLinkManager classId={CLASS_ID} initialLinks={[]} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "新しいリンクを発行" }));
    expect(screen.getByRole("alert")).toHaveTextContent("有効期限は");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("発行 API がエラーなら error を表示し URL を出さない", async () => {
    stubFetch(() => Promise.resolve(jsonRes({ error: "forbidden" }, 403)));
    render(<MagicLinkManager classId={CLASS_ID} initialLinks={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "新しいリンクを発行" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("発行に失敗しました (403)");
    expect(screen.queryByTestId("issued-url")).not.toBeInTheDocument();
  });

  it("URL コピーで clipboard.writeText を呼ぶ", async () => {
    stubFetch((_url, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(jsonRes({ id: "ml-1", path: "/s/COPY", expiresAt: "x" }, 201));
      }
      return Promise.resolve(jsonRes({ links: [] }));
    });
    render(<MagicLinkManager classId={CLASS_ID} initialLinks={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "新しいリンクを発行" }));
    await screen.findByTestId("issued-url");
    fireEvent.click(screen.getByRole("button", { name: "URL をコピー" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/s/COPY`));
    expect(await screen.findByRole("button", { name: "コピーしました" })).toBeInTheDocument();
  });

  it("失効は 2 段階確認: 確定で revoke API を呼び一覧から消す", async () => {
    const fetchFn = stubFetch((url, init) => {
      if (url === `/api/magic-links/ml-9/revoke` && init?.method === "POST") {
        return Promise.resolve(jsonRes({ id: "ml-9", revokedAt: "2026-05-31T01:00:00.000Z" }));
      }
      return Promise.resolve(jsonRes({ error: "unexpected" }, 500));
    });
    render(
      <MagicLinkManager
        classId={CLASS_ID}
        initialLinks={[
          {
            id: "ml-9",
            expiresAt: "2026-09-01T00:00:00.000Z",
            createdAt: "2026-05-31T00:00:00.000Z",
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "失効" }));
    // 確認ボタンが出るまでは API を呼ばない。
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "失効する" }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith("/api/magic-links/ml-9/revoke", { method: "POST" }),
    );
    await waitFor(() => expect(screen.getByText("有効なリンクはありません。")).toBeInTheDocument());
  });

  it("失効の『やめる』で確認を閉じ API を呼ばない", () => {
    const fetchFn = stubFetch(() => Promise.resolve(jsonRes({})));
    render(
      <MagicLinkManager
        classId={CLASS_ID}
        initialLinks={[
          {
            id: "ml-9",
            expiresAt: "2026-09-01T00:00:00.000Z",
            createdAt: "2026-05-31T00:00:00.000Z",
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "失効" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.getByRole("button", { name: "失効" })).toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
