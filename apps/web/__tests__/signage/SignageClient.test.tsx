import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
import { SIGNAGE_DESIGN_PATTERNS } from "../../lib/signage/design-pattern";
import { PATTERN_BLOCKS, SIGNAGE_BLOCK_META } from "../../lib/signage/pattern-blocks";
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
    news: null,
    weatherWarnings: null,
    heatAlerts: null,
    blackout: false,
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

  it("ヘッダーに識別ラベルを表示する (#243・学科制は 学科 学年 で組は出さない BUG-3)", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([])} />);
    expect(screen.getByText("電子工学科 1年")).toBeInTheDocument();
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

  it("pattern2 は3段盤面（予定/呼び出し/来校者/鉄道/センサ/工学ニュース）を描画する（天気は予定に内包・準備中枠なし）", () => {
    render(<SignageClient classToken={TOKEN} initial={p2([])} />);
    expect(screen.getByRole("region", { name: "予定" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "来校者一覧" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "生徒呼び出し" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "人感センサカウンタ" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "鉄道" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "工学ニュース" })).toBeInTheDocument();
    // 天気は独立ウィジェットを廃し予定列ヘッダーに内包したので「天気予報」領域は持たない。
    expect(screen.queryByRole("region", { name: "天気予報" })).toBeNull();
    // 全ウィジェット実装済 → 「準備中」枠は残っていない。
    expect(screen.queryByText("準備中")).toBeNull();
  });

  it("pattern2 工学ニュース: 見出し + 発表元 + 公開日 + 出典ドメインを表示、無し/null は取得不可表示（本文は転載しない）", () => {
    const news: SignagePayload["news"] = {
      isStale: false,
      items: [
        {
          id: "n1",
          title: "新型固体電池の量産技術を確立",
          sourceLabel: "JST サイエンスポータル",
          url: "https://scienceportal.jst.go.jp/articles/12345",
          publishedAt: new Date("2026-06-17T09:00:00+09:00"),
        },
      ],
    };
    const { unmount } = render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", news }}
      />,
    );
    const region = screen.getByRole("region", { name: "工学ニュース" });
    expect(region).toHaveTextContent("新型固体電池の量産技術を確立");
    // 出典明記（発表元ラベル）は ADR-043 で必須。
    expect(region).toHaveTextContent("JST サイエンスポータル");
    expect(region).toHaveTextContent("6/17");
    // 出典 URL はホスト名（QR 生成元の原文ドメイン）で表示する。
    expect(region).toHaveTextContent("scienceportal.jst.go.jp");
    unmount();

    // items 空（取得済みだが記事なし）も fail-soft。
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{
          ...payload([]),
          designPattern: "pattern2",
          news: { items: [], isStale: false },
        }}
      />,
    );
    expect(screen.getByRole("region", { name: "工学ニュース" })).toHaveTextContent(
      "ニュースを取得できていません",
    );

    // null（このパターンで取得していない / 取得失敗）も fail-soft で同じ不在表示。
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", news: null }}
      />,
    );
    expect(screen.getAllByRole("region", { name: "工学ニュース" })[1]).toHaveTextContent(
      "ニュースを取得できていません",
    );
  });

  it("pattern2 工学ニュース: キャッシュが古い時は注記、公開日が無い記事はメタを出さない", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{
          ...payload([]),
          designPattern: "pattern2",
          news: {
            isStale: true,
            items: [
              {
                id: "n1",
                title: "公開日不明の記事",
                sourceLabel: "経済産業省",
                url: "https://www.meti.go.jp/press/abc",
                publishedAt: null,
              },
            ],
          },
        }}
      />,
    );
    const region = screen.getByRole("region", { name: "工学ニュース" });
    expect(region).toHaveTextContent("情報が古い可能性");
    expect(region).toHaveTextContent("公開日不明の記事");
    // www. は除去してドメイン表示。
    expect(region).toHaveTextContent("meti.go.jp");
  });

  it("pattern2 予定: 当日の天気を列ヘッダーにアイコンで内包する（可視テキストは出さず aria-label で担保）", () => {
    const scheduleDays: SignagePayload["scheduleDays"] = [
      { date: "2026-05-31", schedule: { source: null, items: [{ period: 1, subject: "数学" }] } },
    ];
    const weather: SignagePayload["weather"] = {
      areaCode: "210000",
      areaName: "岐阜県",
      fetchedAt: null,
      isStale: false,
      days: [
        {
          forecastDate: "2026-05-31",
          weatherCode: "100",
          weatherText: "晴れ",
          icon: "sunny",
          iconLabel: "晴れ",
          tempMin: null,
          tempMax: null,
          pop: null,
        },
      ],
    };
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", scheduleDays, weather }}
      />,
    );
    const schedule = screen.getByRole("region", { name: "予定" });
    expect(schedule).toHaveTextContent("数学");
    // 天気は列ヘッダーにアイコンのみ（#847 と同作法）。意味は aria-label が担保し、可視テキストは出さない。
    expect(within(schedule).getByLabelText("晴れ")).toBeInTheDocument();
    expect(schedule).not.toHaveTextContent("晴れ");
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
    // 工学ニュースは pattern2/3 専用（ADR-043）。pattern1 は描画しない。
    expect(screen.queryByRole("region", { name: "工学ニュース" })).toBeNull();
    expect(screen.queryByText("準備中")).toBeNull();
  });

  // 盤面が実際に出す region 集合が PATTERN_BLOCKS（単一ソース）の hasRegion ブロックと一致することを全
  // パターンで固定する。盤面に region を足したり PATTERN_BLOCKS から外したりするとここで落ち、盤面と単一
  // ソースのドリフト（finding①の再発）を機械的に検知する。広告は <aside>（complementary）・天気は予定内包
  // で region landmark を持たないため hasRegion=false で対象外。
  it.each([
    ...SIGNAGE_DESIGN_PATTERNS,
  ])("%s の盤面 region は PATTERN_BLOCKS の hasRegion ブロックと一致する（盤面↔単一ソース）", (pattern) => {
    render(
      <SignageClient classToken={TOKEN} initial={{ ...payload([]), designPattern: pattern }} />,
    );
    const expectedRegions = PATTERN_BLOCKS[pattern]
      .filter((kind) => SIGNAGE_BLOCK_META[kind].hasRegion)
      .map((kind) => SIGNAGE_BLOCK_META[kind].label)
      .sort();
    const actualRegions = screen
      .getAllByRole("region")
      .map((el) => el.getAttribute("aria-label") ?? "")
      .sort();
    expect(actualRegions).toEqual(expectedRegions);
  });

  // pattern3（廊下版）専用の週間天気帯。本日以降の予報を 1 行で出し、最高/最低気温・降水確率を数値で示す
  // （折れ線グラフは面積過多のため不採用・2026-06-18 ユーザー確定）。広告 9:16 列は不変・pattern2 無改修。
  const weeklyWeather: SignagePayload["weather"] = {
    areaCode: "210000",
    areaName: "岐阜県",
    fetchedAt: null,
    isStale: false,
    days: [
      // payload.date = 2026-05-31 → 先頭が「今日」。
      {
        forecastDate: "2026-05-31",
        weatherCode: "100",
        weatherText: "晴れ",
        icon: "sunny",
        iconLabel: "晴れ",
        tempMin: 18,
        tempMax: 28,
        pop: 10,
      },
      {
        forecastDate: "2026-06-01",
        weatherCode: "200",
        weatherText: "くもり",
        icon: "cloudy",
        iconLabel: "くもり",
        tempMin: 19,
        tempMax: 27,
        pop: 20,
      },
      {
        forecastDate: "2026-06-02",
        weatherCode: "300",
        weatherText: "雨",
        icon: "rainy",
        iconLabel: "雨",
        tempMin: 20,
        tempMax: 24,
        pop: 70,
      },
      {
        forecastDate: "2026-06-03",
        weatherCode: "200",
        weatherText: "くもり",
        icon: "cloudy",
        iconLabel: "くもり",
        tempMin: 19,
        tempMax: 25,
        pop: 40,
      },
      {
        forecastDate: "2026-06-04",
        weatherCode: "100",
        weatherText: "晴れ",
        icon: "sunny",
        iconLabel: "晴れ",
        tempMin: 18,
        tempMax: 29,
        pop: 10,
      },
      {
        forecastDate: "2026-06-05",
        weatherCode: "100",
        weatherText: "晴れ",
        icon: "sunny",
        iconLabel: "晴れ",
        tempMin: 20,
        tempMax: 30,
        pop: 0,
      },
      {
        forecastDate: "2026-06-06",
        weatherCode: "200",
        weatherText: "くもり",
        icon: "cloudy",
        iconLabel: "くもり",
        tempMin: 21,
        tempMax: 26,
        pop: 30,
      },
      // 8 日目: slice(0,7) で出ない想定の番兵（一意の気温 40° で検出）。
      {
        forecastDate: "2026-06-07",
        weatherCode: "100",
        weatherText: "晴れ",
        icon: "sunny",
        iconLabel: "晴れ",
        tempMin: 22,
        tempMax: 40,
        pop: 0,
      },
    ],
  };

  it("pattern3 週間天気帯: 本日以降 7 日を出し、今日マーク・最高/最低気温・降水確率を数値で示す", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern3", weather: weeklyWeather }}
      />,
    );
    // region landmark は作らない（weather は hasRegion=false／ドリフトガード不変）→ group でまとめる。
    expect(screen.queryByRole("region", { name: "週間天気" })).toBeNull();
    const strip = screen.getByRole("group", { name: "週間天気" });
    // 今日マーク + 最高(28°)/最低(18°) + 降水確率(10%)。
    expect(strip).toHaveTextContent("今日");
    expect(strip).toHaveTextContent("28°");
    expect(strip).toHaveTextContent("18°");
    expect(strip).toHaveTextContent("10%");
    // 雨の日は降水確率 70%、天気グリフは aria-label で意味を担保（色非依存・NFR05）。
    expect(strip).toHaveTextContent("70%");
    expect(within(strip).getAllByLabelText("雨").length).toBeGreaterThan(0);
    // 8 日目（40°）は slice(0,7) で出さない。
    expect(strip).not.toHaveTextContent("40°");
  });

  it("pattern3 週間天気帯: weather=null では帯ごと出さない（fail-soft）", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern3", weather: null }}
      />,
    );
    expect(screen.queryByRole("group", { name: "週間天気" })).toBeNull();
  });

  it.each([
    "pattern1",
    "pattern2",
  ] as const)("%s は週間天気帯を描画しない（pattern3 専用・既存端末は不変）", (pattern) => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: pattern, weather: weeklyWeather }}
      />,
    );
    expect(screen.queryByRole("group", { name: "週間天気" })).toBeNull();
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

describe("SignageClient 防災・安全帯（pattern1・条件付き・ADR-044）", () => {
  function activeWarning(
    over: Partial<SignagePayload["weatherWarnings"] & object> = {},
  ): SignagePayload["weatherWarnings"] {
    return {
      areaCode: "210000",
      areaName: "岐阜県",
      maxLevel: "warning",
      headline: "大雨に警戒",
      warnings: [{ code: "03", name: "大雨警報", level: "warning", status: "発表" }],
      fetchedAt: new Date("2026-07-01T09:00:00+09:00"),
      isStale: false,
      ...over,
    };
  }
  function activeHeat(
    over: Partial<SignagePayload["heatAlerts"] & object> = {},
  ): SignagePayload["heatAlerts"] {
    return {
      areaCode: "210000",
      areaName: "岐阜県",
      alertLevel: "warning",
      wbgtMax: 31,
      wbgtBand: "danger",
      forecastDate: "2026-07-15",
      fetchedAt: new Date("2026-07-15T06:00:00+09:00"),
      isStale: false,
      ...over,
    };
  }

  it("警報・熱中症ともに無い（両 null）と帯ごと出さない（既定 seed で描画不変）", () => {
    render(<SignageClient classToken={TOKEN} initial={payload([])} />);
    expect(screen.queryByRole("group", { name: "防災・安全" })).toBeNull();
  });

  it("非アクティブ（maxLevel/alertLevel='none'）でも帯ごと出さない（アクティブ時のみ目立たせる）", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{
          ...payload([]),
          weatherWarnings: activeWarning({ maxLevel: "none", warnings: [] }),
          heatAlerts: activeHeat({ alertLevel: "none" }),
        }}
      />,
    );
    expect(screen.queryByRole("group", { name: "防災・安全" })).toBeNull();
  });

  it("気象警報がアクティブな時だけ段階ラベル + 警報名を出す（色非依存・NFR05）", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), weatherWarnings: activeWarning({ maxLevel: "emergency" }) }}
      />,
    );
    const band = screen.getByRole("group", { name: "防災・安全" });
    // 段階ラベル（色だけに依存しないテキスト）。
    expect(band).toHaveTextContent("気象特別警報");
    expect(band).toHaveTextContent("大雨警報");
  });

  it("熱中症がアクティブな時だけ段階ラベル + WBGT 数値を出す（色非依存・NFR05）", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{
          ...payload([]),
          heatAlerts: activeHeat({ alertLevel: "emergency", wbgtMax: 33 }),
        }}
      />,
    );
    const band = screen.getByRole("group", { name: "防災・安全" });
    expect(band).toHaveTextContent("熱中症特別警戒アラート");
    expect(band).toHaveTextContent("WBGT 33");
  });

  it("警報・熱中症が両方アクティブなら 1 帯に両方出す", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), weatherWarnings: activeWarning(), heatAlerts: activeHeat() }}
      />,
    );
    const band = screen.getByRole("group", { name: "防災・安全" });
    expect(band).toHaveTextContent("気象警報");
    expect(band).toHaveTextContent("熱中症警戒アラート");
  });

  it("キャッシュが古い時は「○時時点」注記を出す（last-known-good・鮮度）", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{
          ...payload([]),
          weatherWarnings: activeWarning({
            isStale: true,
            fetchedAt: new Date("2026-07-01T03:00:00+09:00"),
          }),
        }}
      />,
    );
    expect(screen.getByRole("group", { name: "防災・安全" })).toHaveTextContent("時点");
  });

  it("WBGT 欠落（null）でも熱中症帯は段階ラベルで出る（fail-soft・色非依存）", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), heatAlerts: activeHeat({ wbgtMax: null, wbgtBand: null }) }}
      />,
    );
    const band = screen.getByRole("group", { name: "防災・安全" });
    expect(band).toHaveTextContent("熱中症警戒アラート");
    expect(band).not.toHaveTextContent("WBGT");
  });

  it.each([
    "pattern2",
    "pattern3",
  ] as const)("%s は防災・安全帯を描画しない（pattern1 専用・既存端末は無改修）", (pattern) => {
    // pattern2/3 はデータ層が weatherWarnings/heatAlerts を取得しない（null）。万一値が来ても盤面側が
    // pattern1 の Pattern1Board でしか SafetyAlertBand を呼ばないため出ないことを二重に固定する。
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{
          ...payload([]),
          designPattern: pattern,
          weatherWarnings: activeWarning(),
          heatAlerts: activeHeat(),
        }}
      />,
    );
    expect(screen.queryByRole("group", { name: "防災・安全" })).toBeNull();
  });
});

describe("SignageClient 黒画面トグル（per-class・パターン非依存）", () => {
  it("blackout=true は盤面の代わりに黒画面を出す（盤面 region は描かない）", () => {
    render(<SignageClient classToken={TOKEN} initial={{ ...payload([]), blackout: true }} />);
    // 黒画面は識別用 aria-label を持つ。盤面（予定 region・広告）は描かれない。
    expect(screen.getByLabelText("サイネージ休止中（黒画面）")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "予定" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "広告" })).toBeNull();
  });

  it("blackout=true でも広告 view テレメトリは送らない（盤面ごと出さないため）", () => {
    render(
      <SignageClient classToken={TOKEN} initial={{ ...payload([ad(AD_A)]), blackout: true }} />,
    );
    expect(sendSignageEvent).not.toHaveBeenCalled();
  });

  it("blackout=false / 未指定は通常どおり盤面を描く（既存挙動を壊さない）", () => {
    render(<SignageClient classToken={TOKEN} initial={{ ...payload([]), blackout: false }} />);
    expect(screen.queryByLabelText("サイネージ休止中（黒画面）")).toBeNull();
    expect(screen.getByRole("region", { name: "予定" })).toBeInTheDocument();
  });

  it("pattern2 でも blackout=true は黒画面を優先する", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={{ ...payload([]), designPattern: "pattern2", blackout: true }}
      />,
    );
    expect(screen.getByLabelText("サイネージ休止中（黒画面）")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "来校者一覧" })).toBeNull();
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
