import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F07 (#43): SignageClient が広告 impression の view を送る追加配線のテスト。event-beacon と
 * media-cache を mock し、tuned な rotation/polling を起動させずに「マウント時の現在広告で view を
 * 1 件送る / 広告ゼロでは送らない / clientId 空は載せない」を検証する。
 */

const { sendSignageEvent, getClientId } = vi.hoisted(() => ({
  sendSignageEvent: vi.fn(),
  getClientId: vi.fn(() => "cid-123"),
}));
vi.mock("@/lib/signage/event-beacon", () => ({ sendSignageEvent, getClientId }));
// SW 登録・media prefetch はマウント時に走るので no-op 化して副作用を断つ。
vi.mock("@/lib/signage/media-cache", () => ({
  registerSignageServiceWorker: vi.fn(() => Promise.resolve()),
  prefetchMedia: vi.fn(() => Promise.resolve()),
  cleanupStaleMedia: vi.fn(() => Promise.resolve()),
  selectPrefetchUrls: vi.fn(() => []),
}));

import { SignageClient } from "../../app/(signage)/signage/[classToken]/_components/SignageClient";
import type { SignagePayload } from "../../lib/signage/signage-display";

const TOKEN = "TOK";
const AD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const emptySection = { items: [] as unknown[], source: null };
const daily = {
  date: "2026-05-31",
  schedules: emptySection,
  notices: emptySection,
  assignments: emptySection,
  quietHours: emptySection,
};

function ad(adId: string): SignagePayload["ads"][number] {
  return {
    classId: "11111111-1111-4111-8111-111111111111",
    adId,
    schoolId: "22222222-2222-4222-8222-222222222222",
    sourceScope: "class",
    scopeRank: 3,
    isInherited: false,
    mediaUrl: "https://cdn.example/a.png",
    mediaType: "image",
    durationSec: 10,
    linkUrl: null,
    caption: null,
    captionFontScale: 1,
    displayOrder: 0,
  };
}

function payload(ads: SignagePayload["ads"]): SignagePayload {
  return { date: "2026-05-31", daily, ads };
}

beforeEach(() => {
  vi.clearAllMocks();
  getClientId.mockReturnValue("cid-123");
});

describe("SignageClient view impression (#43 / F07)", () => {
  it("広告ありでマウント時に現在広告の view を送る (adId/slotIndex/clientId 付き)", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([ad(AD_A)])} />);
    expect(sendSignageEvent).toHaveBeenCalledTimes(1);
    expect(sendSignageEvent).toHaveBeenCalledWith(TOKEN, {
      type: "view",
      adId: AD_A,
      slotIndex: 0,
      clientId: "cid-123",
    });
  });

  it("広告ゼロでは view を送らない", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([])} />);
    expect(sendSignageEvent).not.toHaveBeenCalled();
  });

  it("clientId が空なら clientId キーを載せない (無効値を送らない)", () => {
    getClientId.mockReturnValue("");
    render(<SignageClient classToken={TOKEN} initial={payload([ad(AD_A)])} />);
    expect(sendSignageEvent).toHaveBeenCalledWith(TOKEN, {
      type: "view",
      adId: AD_A,
      slotIndex: 0,
    });
  });
});
