import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * 回帰テスト（本番障害: 進路指導室前 サイネージ pattern3 が起動後に「問題が発生しました」へ倒れた件）。
 *
 * 原因: 自動更新ポーリング応答は JSON で、`fetchedAt` / `publishedAt` 等の **Date 型フィールドが文字列化**
 * する。これを Date に復元せず再描画すると、盤面の Date 利用（ニュース日付 `formatNewsDate` の
 * `publishedAt.getTime()`）が**文字列に対して実行され `TypeError: ...getTime is not a function`** を投げ、
 * error boundary が盤面ごとエラー画面に倒す（ニュースを描く pattern2 のみ実害、pattern1 は無傷。pattern3 は
 * 2026-06-20 にニュース枠を撤去したので、現在は pattern2 がニュース描画の代表。reviver 修正は pattern 非依存）。
 *
 * 修正: poll 応答を `rotation.reviveSignageDate` reviver でパースし、初期描画（SSR→hydration、RSC が Date
 * 復元）と同じ「Date は Date」の不変条件をクライアント側でも保つ。
 */

import { reviveSignageDate } from "../../lib/signage/rotation";
import {
  type SignageBoardProps,
  SignageBoardView,
} from "../../app/(signage)/signage/[classToken]/_components/SignageBoardView";
import type { SignagePayload } from "../../lib/signage/signage-display";

const emptySection = { items: [] as unknown[], source: null };

/**
 * ニュースを 1 件持つ「ニュース描画パターン」（pattern2）payload。`publishedAt` は本来 Date（サーバ/初期描画の
 * 形）。回帰の原典は pattern3 だが 2026-06-20 にニュース枠を撤去したため、ニュースを描く pattern2 で同じ Date
 * 復元経路を固定する（reviver 修正は pattern 非依存）。
 */
function newsBearingPayload(): SignagePayload {
  return {
    date: "2026-06-20",
    designPattern: "pattern2",
    assignmentDeadlineFormat: "daysLeft",
    daily: {
      date: "2026-06-20",
      schedules: emptySection,
      notices: emptySection,
      assignments: emptySection,
      quietHours: emptySection,
    },
    scheduleDays: [],
    ads: [],
    weather: {
      areaCode: "210000",
      areaName: "美濃地方",
      fetchedAt: new Date("2026-06-20T04:00:14.980Z"),
      isStale: false,
      days: [
        {
          forecastDate: "2026-06-20",
          weatherCode: "300",
          weatherText: "雨",
          icon: "rainy",
          iconLabel: "雨",
          tempMin: 25,
          tempMax: 26,
          pop: 90,
        },
      ],
    },
    classContext: { departmentName: null, gradeName: null, className: "進路指導室前" },
    presenceCount: 0,
    visitors: [],
    callouts: [],
    trainStatus: {
      operatorName: "名鉄",
      statusText: "15分以上の列車の遅れはございません。",
      hasDisruption: false,
      isStale: false,
    },
    news: {
      items: [
        {
          id: "53a32856-d942-4747-9675-4c1083dcc7ff",
          title: "松本洋平文部科学大臣記者会見録",
          sourceLabel: "文部科学省",
          url: "https://www.mext.go.jp/b_menu/daijin/detail/mext_00705.html",
          summary: null,
          publishedAt: new Date("2026-06-19T10:57:00.000Z"),
        },
      ],
      isStale: false,
    },
    weatherWarnings: null,
    heatAlerts: null,
    blackout: false,
  };
}

function boardProps(payload: SignagePayload): SignageBoardProps {
  const firstAd = payload.ads[0] ?? null;
  return {
    data: payload,
    ad: firstAd,
    adLink: null,
    adCount: payload.ads.length,
    safeIndex: 0,
    now: null,
    onAdTap: () => {},
  };
}

/** ポーリング応答（JSON）を模す: Date が ISO 文字列化した payload。 */
function pollResponseJson(payload: SignagePayload): string {
  return JSON.stringify(payload);
}

describe("サイネージ poll 応答の日付復元（本番障害回帰）", () => {
  it("reviveSignageDate は日時文字列(T 付き)を Date に復元し、日付のみ(YYYY-MM-DD)は文字列のまま残す", () => {
    expect(reviveSignageDate("publishedAt", "2026-06-19T10:57:00.000Z")).toBeInstanceOf(Date);
    expect(reviveSignageDate("fetchedAt", "2026-06-20T04:00:14.980Z")).toBeInstanceOf(Date);
    // 日付のみ（型上 string のフィールド）は変換しない。
    expect(reviveSignageDate("forecastDate", "2026-06-20")).toBe("2026-06-20");
    expect(reviveSignageDate("date", "2026-06-20")).toBe("2026-06-20");
    // 数値・null はそのまま。
    expect(reviveSignageDate("tempMax", 26)).toBe(26);
    expect(reviveSignageDate("heatAlerts", null)).toBe(null);
  });

  it("【バグ再現】reviver 無しの素 JSON.parse 由来 payload はニュース描画で TypeError を投げる", () => {
    const raw = JSON.parse(pollResponseJson(newsBearingPayload())) as SignagePayload;
    // publishedAt が文字列のまま → formatNewsDate の getTime() が文字列に対して走り throw（= 本番の症状）。
    expect(() => render(<SignageBoardView {...boardProps(raw)} />)).toThrow();
  });

  it("【修正】reviveSignageDate で復元した payload はニュースを正常描画し落ちない", () => {
    const revived = JSON.parse(
      pollResponseJson(newsBearingPayload()),
      reviveSignageDate,
    ) as SignagePayload;
    render(<SignageBoardView {...boardProps(revived)} />);
    // ニュース帯が描かれ、公開日が JST M/D（6/19）で整形される。
    const news = screen.getByRole("region", { name: "時事ニュース" });
    expect(news).toHaveTextContent("松本洋平文部科学大臣記者会見録");
    expect(news).toHaveTextContent("6/19");
  });
});
