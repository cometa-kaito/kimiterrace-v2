import { describe, expect, it } from "vitest";
import { parseMeitetsuStatus } from "../meitetsu.js";

/**
 * 名鉄運行情報パーサ（ADR-035）の単体テスト。タグ除去後のテキストから運行情報文を拾い、正常マーカー優先・
 * 乱れキーワード（証明書等は除外）・fail-soft（認識不能は null）を確認する。
 */
describe("parseMeitetsuStatus", () => {
  it("平常時: 正常マーカーを含む文を平常運転として抽出する", () => {
    const html =
      "<html><body><h1>列車運行情報</h1><p>15分以上の列車の遅れはございません。</p></body></html>";
    expect(parseMeitetsuStatus(html)).toEqual({
      hasDisruption: false,
      statusText: "15分以上の列車の遅れはございません。",
    });
  });

  it("乱れ時: 乱れキーワードを含む文を乱れとして抽出する", () => {
    const html = "<html><body><div>名古屋本線で遅延が発生しています。</div></body></html>";
    expect(parseMeitetsuStatus(html)).toEqual({
      hasDisruption: true,
      statusText: "名古屋本線で遅延が発生しています。",
    });
  });

  it("「遅延証明書」だけのリンクは運行情報文でない → null（誤検出除外）", () => {
    const html = "<html><body><a>遅延証明書はこちら</a><p>ようこそ</p></body></html>";
    expect(parseMeitetsuStatus(html)).toBeNull();
  });

  it("script / style 内のキーワードはタグ除去で無視される", () => {
    const html =
      '<html><head><script>var x="遅延が発生";</script><style>.a{color:red}</style></head><body><p>平常運転しています。</p></body></html>';
    expect(parseMeitetsuStatus(html)).toEqual({
      hasDisruption: false,
      statusText: "平常運転しています。",
    });
  });

  it("正常マーカーが乱れキーワード（証明書）より優先される", () => {
    const html = "<body><a>遅延証明書</a><p>15分以上の列車の遅れはございません。</p></body>";
    expect(parseMeitetsuStatus(html)?.hasDisruption).toBe(false);
  });

  it("認識できる運行情報文が無ければ null（空・無関係テキスト）", () => {
    expect(parseMeitetsuStatus("<html><body><p>ようこそ名鉄へ</p></body></html>")).toBeNull();
    expect(parseMeitetsuStatus("")).toBeNull();
  });
});
