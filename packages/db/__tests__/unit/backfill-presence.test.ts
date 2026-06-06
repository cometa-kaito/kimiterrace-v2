import { describe, expect, it } from "vitest";
import { parseBackfillLine, parseBackfillNdjson } from "../../src/backfill-presence.js";

/**
 * F13 (#391, ADR-020): LP Turso `motion_events` → v2 `events` backfill のパース/正規化単体検証。I/O 非依存。
 * MAC が webhook ingest と同じ正規形（大文字・区切り無し）に畳まれること・不正行が安全に除外されることを固定。
 */

describe("parseBackfillLine", () => {
  it("正常行をパースし MAC を正規化する", () => {
    const r = parseBackfillLine(
      '{"mac":"DC:A5:B3:C2:98:D7","state":"DETECTED","ms":1748000000000}',
    );
    expect(r).toEqual({
      deviceMac: "DCA5B3C298D7",
      detectionState: "DETECTED",
      occurredAtMs: 1748000000000,
    });
  });

  it("state を大文字化する", () => {
    const r = parseBackfillLine(
      '{"mac":"e2:e2:e8:85:3a:32","state":"not_detected","ms":1748000000001}',
    );
    expect(r?.deviceMac).toBe("E2E2E8853A32");
    expect(r?.detectionState).toBe("NOT_DETECTED");
  });

  it("空行・空白行は null", () => {
    expect(parseBackfillLine("")).toBeNull();
    expect(parseBackfillLine("   ")).toBeNull();
  });

  it("不正 JSON は null（throw しない）", () => {
    expect(parseBackfillLine("{not json")).toBeNull();
  });

  it("型不正（ms が文字列 / mac 欠落 / 非オブジェクト）は null", () => {
    expect(parseBackfillLine('{"mac":"DC:A5:B3:C2:98:D7","state":"DETECTED","ms":"x"}')).toBeNull();
    expect(parseBackfillLine('{"state":"DETECTED","ms":1748000000000}')).toBeNull();
    expect(parseBackfillLine("[1,2,3]")).toBeNull();
    expect(parseBackfillLine("123")).toBeNull();
  });

  it("ms が非正・非有限は null", () => {
    expect(parseBackfillLine('{"mac":"DC:A5:B3:C2:98:D7","state":"DETECTED","ms":0}')).toBeNull();
    expect(parseBackfillLine('{"mac":"DC:A5:B3:C2:98:D7","state":"DETECTED","ms":-5}')).toBeNull();
  });
});

describe("parseBackfillNdjson", () => {
  it("有効行のみを抽出し、空行・不正行を捨てる", () => {
    const text = [
      '{"mac":"DC:A5:B3:C2:98:D7","state":"DETECTED","ms":1748000000000}',
      "",
      "{garbage",
      '{"mac":"EF:64:49:02:A1:0D","state":"NOT_DETECTED","ms":1748000000002}',
    ].join("\n");
    const rows = parseBackfillNdjson(text);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.deviceMac)).toEqual(["DCA5B3C298D7", "EF644902A10D"]);
  });

  it("CRLF 改行も扱える", () => {
    const text = '{"mac":"DC:A5:B3:C2:98:D7","state":"DETECTED","ms":1748000000000}\r\n';
    expect(parseBackfillNdjson(text)).toHaveLength(1);
  });
});
