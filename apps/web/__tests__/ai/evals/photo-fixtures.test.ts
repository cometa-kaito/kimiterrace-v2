import { CHAT_MESSAGE_MAX } from "@/lib/editor/assistant-chat-core";
import { jstUpcomingDateTable } from "@/lib/editor/assistant-core";
import { buildPhotoImportChatMessage } from "@/lib/editor/photo-import-core";
import { findSuspectedPersonalNames, findUnmaskedPii } from "@kimiterrace/ai";
import { describe, expect, it } from "vitest";
import { FIXED_NOW_MS } from "./cases-assistant";
import { PHOTO_EVAL_CASES } from "./cases-photo-extraction";
import { PHOTO_FIXTURES, type PhotoFixtureId, photoFixtureText } from "./photo-fixtures";

/**
 * P1 写真取込 eval の**常時（CI）回帰検査**。実 Vertex / ブラウザは使わず、フィクスチャと注入
 * メッセージの不変条件だけを守る:
 * - ルール4: フィクスチャは PII ゼロ（実 Vertex に送る評価素材）。本番と同じ検出器
 *   （findSuspectedPersonalNames / findUnmaskedPii）で機械検査し、ケース追加時の混入を防ぐ。
 * - 日付整合: 期待 `days` の日付が system プロンプトの 14 日対応表（jstUpcomingDateTable）内に
 *   実在し、かつフィクスチャ紙面に同じ月日が書かれている（期待値と画像の食い違いを防ぐ）。
 * - 注入メッセージ: parseChatTurns の契約（CHAT_MESSAGE_MAX）に必ず収まる。
 */

const fixtureIds = Object.keys(PHOTO_FIXTURES) as PhotoFixtureId[];

describe("photo fixtures (PII ゼロ・ルール4)", () => {
  it.each(fixtureIds)("%s: 氏名らしき語・書式 PII を含まない", (id) => {
    const text = photoFixtureText(id);
    expect(text.length).toBeGreaterThan(0);
    expect(findSuspectedPersonalNames(text)).toHaveLength(0);
    expect(findUnmaskedPii(text, [])).toHaveLength(0);
  });

  it("注入メッセージ（指示部込み）も PII ゼロ", () => {
    for (const id of fixtureIds) {
      const message = buildPhotoImportChatMessage(photoFixtureText(id));
      expect(findSuspectedPersonalNames(message)).toHaveLength(0);
      expect(findUnmaskedPii(message, [])).toHaveLength(0);
    }
  });
});

describe("photo eval cases (日付整合)", () => {
  const dateTable = jstUpcomingDateTable(FIXED_NOW_MS);

  it("各ケースの fixtureId が存在する", () => {
    for (const c of PHOTO_EVAL_CASES) {
      expect(PHOTO_FIXTURES[c.fixtureId]).toBeDefined();
    }
  });

  it("期待 days の日付は 14 日対応表の範囲内 + フィクスチャ紙面に同じ月日が書かれている", () => {
    for (const c of PHOTO_EVAL_CASES) {
      const text = photoFixtureText(c.fixtureId);
      for (const day of c.expected.days ?? []) {
        // system プロンプトは表より先の日付を聞き返させるため、期待日付は必ず表内であること。
        expect(dateTable).toContain(day.date);
        // 2026-07-13 → 紙面表記「7月13日」。ゼロ埋めなしの和暦月日で紙面に実在すること。
        const [, month, dayOfMonth] = day.date.split("-").map((s) => Number.parseInt(s, 10));
        expect(text).toContain(`${month}月${dayOfMonth}日`);
      }
    }
  });
});

describe("buildPhotoImportChatMessage", () => {
  it("指示部 + 本文で組み、前後空白を落とす", () => {
    const message = buildPhotoImportChatMessage("  時間割変更のお知らせ\n1限 体育  ");
    expect(message).toContain("【プリント本文】");
    expect(message).toContain("時間割変更のお知らせ\n1限 体育");
    expect(message.endsWith(" ")).toBe(false);
  });

  it("過大な OCR テキストでも全体が CHAT_MESSAGE_MAX に収まる", () => {
    const message = buildPhotoImportChatMessage("あ".repeat(CHAT_MESSAGE_MAX * 3));
    expect(message.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX);
    expect(message).toContain("【プリント本文】");
  });

  it("切り詰め境界でサロゲートペアを割らない（lone surrogate を残さない）", () => {
    // 絵文字（astral・2 code units）だけの長文で、あらゆる切り詰め位置がペア境界に当たるようにする。
    const message = buildPhotoImportChatMessage("😀".repeat(CHAT_MESSAGE_MAX));
    expect(message.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX);
    // 正しく文字境界で切れていれば UTF-8 round-trip が同一（lone surrogate は U+FFFD に化ける）。
    expect(new TextDecoder().decode(new TextEncoder().encode(message))).toBe(message);
  });
});
