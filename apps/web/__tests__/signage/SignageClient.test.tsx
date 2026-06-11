import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F07 (#43): SignageClient が広告 impression の view / click-through の tap を送る追加配線のテスト。
 * event-beacon と media-cache を mock し、tuned な rotation/polling を起動させずに「マウント時の現在広告で
 * view を 1 件送る / 広告ゼロでは送らない / clientId 空は載せない」+「linkUrl 付き広告はタップで tap を
 * 送る / linkUrl 無しや危険スキームはリンク化しない」を検証する。
 *
 * #322 (ADR-025): 分粒度ハートビート view の検証を追加 — fake timers で `VIEW_HEARTBEAT_MS` ごとの再送、
 * 単一広告クラスでの取りこぼし解消、tab 非表示中のスキップと再表示での再開を確かめる。
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
import { VIEW_HEARTBEAT_MS } from "../../lib/signage/rotation";
import type { SignagePayload } from "../../lib/signage/signage-display";

const TOKEN = "TOK";
const AD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// 文字列リテラルで javascript: を書くと lint が反応するため分割して組み立てる (検証用の危険スキーム)。
const DANGEROUS_URL = `${"java"}script:alert(1)`;

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

function adWithLink(adId: string, linkUrl: string | null, caption: string | null = null) {
  return { ...ad(adId), linkUrl, caption };
}

function payload(ads: SignagePayload["ads"]): SignagePayload {
  return {
    date: "2026-05-31",
    designPattern: "pattern1",
    daily,
    scheduleDays: [],
    ads,
    weather: null,
    classContext: { departmentName: "電子工学科", gradeName: "1年", className: "A組" },
    presenceCount: null,
    visitors: null,
    callouts: null,
    trainStatus: null,
  };
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

  it("ヘッダーに学科・学年・クラスの識別ラベルを表示する (#243)", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([])} />);
    expect(screen.getByText("電子工学科 1年 A組")).toBeInTheDocument();
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

describe("SignageClient デザインパターン dispatch（端末別デザイン）", () => {
  function p2(ads: SignagePayload["ads"], presenceCount: number | null = null): SignagePayload {
    return { ...payload(ads), designPattern: "pattern2", presenceCount };
  }

  it("pattern2 はパターン2盤面（予定/天気/来校者/呼び出し/センサ/鉄道）を描画する（準備中枠なし）", () => {
    render(<SignageClient classToken={TOKEN} initial={p2([])} />);
    expect(screen.getByRole("region", { name: "予定" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "天気予報" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "来校者一覧" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "生徒呼び出し" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "人感センサカウンタ" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "鉄道" })).toBeInTheDocument();
    // 全ウィジェット実装済 → 「準備中」枠は残っていない。
    expect(screen.queryByText("準備中")).toBeNull();
  });

  it("pattern2 鉄道: 事業者名 + 運行情報を表示、乱れ/古い時は注記、null は取得不可表示", () => {
    const { unmount } = render(
      <SignageClient
        classToken={TOKEN}
        initial={{
          ...payload([]),
          designPattern: "pattern2",
          trainStatus: {
            operatorName: "名鉄",
            statusText: "名古屋本線で遅延が発生しています。",
            hasDisruption: true,
            isStale: true,
          },
        }}
      />,
    );
    const region = screen.getByRole("region", { name: "鉄道" });
    expect(region).toHaveTextContent("名鉄");
    expect(region).toHaveTextContent("名古屋本線で遅延が発生しています。");
    expect(region).toHaveTextContent("情報が古い可能性");
    unmount();

    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", trainStatus: null }}
      />,
    );
    expect(screen.getByRole("region", { name: "鉄道" })).toHaveTextContent(
      "運行情報は取得できていません",
    );
  });

  it("pattern2 生徒呼び出し: 時刻 + 氏名 + 呼び出し先 + 用件を表示、無し/null は不在表示", () => {
    const callouts = [
      {
        id: "c1",
        studentName: "佐藤太郎",
        location: "職員室",
        reason: "忘れ物",
        scheduledTime: "10:15",
      },
    ];
    const { unmount } = render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", callouts }}
      />,
    );
    const region = screen.getByRole("region", { name: "生徒呼び出し" });
    expect(region).toHaveTextContent("10:15");
    expect(region).toHaveTextContent("佐藤太郎");
    expect(region).toHaveTextContent("職員室");
    expect(region).toHaveTextContent("忘れ物");
    unmount();

    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", callouts: null }}
      />,
    );
    expect(screen.getByRole("region", { name: "生徒呼び出し" })).toHaveTextContent(
      "呼び出しはありません",
    );
  });

  it("pattern2 来校者一覧: 来校者を時刻/氏名/所属 + 用件/対応で表示、無し/null は不在表示", () => {
    const visitors = [
      {
        id: "v1",
        visitorName: "佐藤一郎",
        affiliation: "ABC商事",
        scheduledTime: "10:30",
        purpose: "面談",
        host: "田中先生",
        note: null,
      },
    ];
    const { unmount } = render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", visitors }}
      />,
    );
    const region = screen.getByRole("region", { name: "来校者一覧" });
    expect(region).toHaveTextContent("10:30");
    expect(region).toHaveTextContent("佐藤一郎");
    expect(region).toHaveTextContent("ABC商事");
    expect(region).toHaveTextContent("面談");
    expect(region).toHaveTextContent("対応: 田中先生");
    unmount();

    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", visitors: null }}
      />,
    );
    expect(screen.getByRole("region", { name: "来校者一覧" })).toHaveTextContent(
      "本日の来校者はありません",
    );
  });

  it("pattern2 人感センサカウンタ: 件数があれば本日の検知回数を出し、null は計測なし、0 も出す", () => {
    const { unmount } = render(<SignageClient classToken={TOKEN} initial={p2([], 12)} />);
    const sensor = screen.getByRole("region", { name: "人感センサカウンタ" });
    expect(sensor).toHaveTextContent("12");
    expect(sensor).toHaveTextContent("本日の検知");
    unmount();

    const { unmount: u2 } = render(<SignageClient classToken={TOKEN} initial={p2([], 0)} />);
    expect(screen.getByRole("region", { name: "人感センサカウンタ" })).toHaveTextContent("0");
    u2();

    render(<SignageClient classToken={TOKEN} initial={p2([], null)} />);
    expect(screen.getByRole("region", { name: "人感センサカウンタ" })).toHaveTextContent(
      "計測なし",
    );
  });

  it("pattern2 予定: 場所 / 対象者を各コマに表示する（あるものだけ）", () => {
    const scheduleDays: SignagePayload["scheduleDays"] = [
      {
        date: "2026-05-31",
        schedule: {
          source: null,
          items: [{ period: 1, subject: "体育", location: "体育館", targetAudience: "3年生" }],
        },
      },
    ];
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", scheduleDays }}
      />,
    );
    const schedule = screen.getByRole("region", { name: "予定" });
    expect(schedule).toHaveTextContent("体育");
    expect(schedule).toHaveTextContent("場所: 体育館");
    expect(schedule).toHaveTextContent("対象: 3年生");
  });

  it("pattern1（既定）はパターン2専用の枠を描画しない", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([])} />);
    expect(screen.queryByRole("region", { name: "来校者一覧" })).toBeNull();
    expect(screen.queryByText("準備中")).toBeNull();
  });

  it("pattern2 でも広告（右）はパターン1と同一でリンク化・タップ送信する", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={p2([adWithLink(AD_A, "https://sponsor.example/lp", "スポンサー")])}
      />,
    );
    const link = screen.getByRole("link", { name: "広告: スポンサー" });
    expect(link).toHaveAttribute("href", "https://sponsor.example/lp");
    sendSignageEvent.mockClear();
    fireEvent.click(link);
    expect(sendSignageEvent).toHaveBeenCalledWith(TOKEN, {
      type: "tap",
      adId: AD_A,
      slotIndex: 0,
      clientId: "cid-123",
    });
  });
});

describe("SignageClient ad click-through tap (#43 / F07)", () => {
  it("linkUrl 付き広告はリンク化され、タップで tap を送る (adId/slotIndex/clientId 付き)", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload([adWithLink(AD_A, "https://sponsor.example/lp", "スポンサー")])}
      />,
    );
    const link = screen.getByRole("link", { name: "広告: スポンサー" });
    expect(link).toHaveAttribute("href", "https://sponsor.example/lp");
    // 新規タブ + reverse tabnabbing 防止。
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    // マウント時の view 送信を除外してタップ分だけを見る。
    sendSignageEvent.mockClear();
    fireEvent.click(link);
    expect(sendSignageEvent).toHaveBeenCalledTimes(1);
    expect(sendSignageEvent).toHaveBeenCalledWith(TOKEN, {
      type: "tap",
      adId: AD_A,
      slotIndex: 0,
      clientId: "cid-123",
    });
  });

  it("caption 無し linkUrl 付き広告は汎用 aria-label でリンク化する", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload([adWithLink(AD_A, "https://sponsor.example/lp", null)])}
      />,
    );
    expect(screen.getByRole("link", { name: "広告を開く" })).toBeInTheDocument();
  });

  it("linkUrl 無しの広告はリンク化しない (タップ送信もしない)", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([adWithLink(AD_A, null)])} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("危険スキーム (javascript:) はリンク化しない (XSS 防止 = 安全側)", () => {
    render(
      <SignageClient classToken={TOKEN} initial={payload([adWithLink(AD_A, DANGEROUS_URL)])} />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("相対 URL もリンク化しない (絶対 http(s) のみ許可)", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([adWithLink(AD_A, "/relative")])} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("SignageClient view 分粒度ハートビート (#322 / ADR-025)", () => {
  // ハートビートの setInterval だけを観測するため、poll の fetch は未解決 promise にして再スケジュール
  // 連鎖を止める (poll 自体の検証は対象外)。document.hidden はテストごとに切り替えられるよう getter 化する。
  let hidden = false;
  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("単一広告クラスでも VIEW_HEARTBEAT_MS ごとに view を再送する (到達 minute の取りこぼし防止)", async () => {
    // 単一広告 (adCount=1) はローテーション early-return のため、ハートビートが無いとマウント中 1 回しか
    // view を送らず到達数が過少になる (ADR-025)。ハートビートで各分に view が立つことを確かめる。
    render(<SignageClient classToken={TOKEN} initial={payload([ad(AD_A)])} />);
    expect(sendSignageEvent).toHaveBeenCalledTimes(1); // 表示開始時の即送信。

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIEW_HEARTBEAT_MS);
    });
    // 1 分後にハートビート再送 (同一 adId/slotIndex/clientId)。集計時 minute-dedup で水増しはしない。
    expect(sendSignageEvent).toHaveBeenCalledTimes(2);
    expect(sendSignageEvent).toHaveBeenLastCalledWith(TOKEN, {
      type: "view",
      adId: AD_A,
      slotIndex: 0,
      clientId: "cid-123",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIEW_HEARTBEAT_MS * 2);
    });
    // さらに 2 分で 2 回再送 (合計 4)。表示し続けた各分に最低 1 件立つ。
    expect(sendSignageEvent).toHaveBeenCalledTimes(4);
  });

  it("tab 非表示中はハートビートを送らず、再表示で再開する (表示していない時間を到達に数えない)", async () => {
    render(<SignageClient classToken={TOKEN} initial={payload([ad(AD_A)])} />);
    expect(sendSignageEvent).toHaveBeenCalledTimes(1); // 表示開始時の即送信。

    hidden = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIEW_HEARTBEAT_MS * 3);
    });
    expect(sendSignageEvent).toHaveBeenCalledTimes(1); // 非表示中は再送しない。

    hidden = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIEW_HEARTBEAT_MS);
    });
    expect(sendSignageEvent).toHaveBeenCalledTimes(2); // 再表示後の次周期で再開。
  });
});
