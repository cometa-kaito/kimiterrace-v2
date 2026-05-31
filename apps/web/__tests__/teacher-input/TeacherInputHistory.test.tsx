import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  TeacherInputHistory,
  type TeacherInputHistoryRow,
} from "../../app/admin/teacher-input/history/_components/TeacherInputHistory";

/**
 * F02 (#38, FR-08): TeacherInputHistory (presentational) のテスト。
 * 状態 / 種別ラベルの写像、本文抜粋・空表示、空一覧のプレースホルダを検証する。
 */

const row = (over: Partial<TeacherInputHistoryRow>): TeacherInputHistoryRow => ({
  id: "r1",
  inputType: "chat",
  status: "draft",
  transcriptPreview: "本文",
  submitted: false,
  createdAt: "2026-05-31T01:00:00.000Z",
  ...over,
});

describe("TeacherInputHistory", () => {
  it("空一覧はプレースホルダを表示", () => {
    render(<TeacherInputHistory rows={[]} />);
    expect(screen.getByText("まだ入力履歴はありません。")).toBeInTheDocument();
  });

  it("status / inputType を日本語ラベルに写像する", () => {
    render(
      <TeacherInputHistory
        rows={[
          row({ id: "a", status: "ready", inputType: "voice", transcriptPreview: "音声本文" }),
          row({ id: "b", status: "submitted", inputType: "chat", transcriptPreview: "送信本文" }),
        ]}
      />,
    );
    expect(screen.getByText("準備完了")).toBeInTheDocument();
    expect(screen.getByText("送信済み")).toBeInTheDocument();
    expect(screen.getByText("音声")).toBeInTheDocument();
    expect(screen.getByText("音声本文")).toBeInTheDocument();
    expect(screen.getByText("送信本文")).toBeInTheDocument();
  });

  it("本文が空なら（本文なし）を表示", () => {
    render(<TeacherInputHistory rows={[row({ transcriptPreview: "" })]} />);
    expect(screen.getByText("（本文なし）")).toBeInTheDocument();
  });

  it("全 4 状態のラベルを表示できる", () => {
    render(
      <TeacherInputHistory
        rows={[
          row({ id: "1", status: "draft" }),
          row({ id: "2", status: "transcribing" }),
          row({ id: "3", status: "ready" }),
          row({ id: "4", status: "submitted" }),
        ]}
      />,
    );
    expect(screen.getByText("下書き")).toBeInTheDocument();
    expect(screen.getByText("文字起こし中")).toBeInTheDocument();
    expect(screen.getByText("準備完了")).toBeInTheDocument();
    expect(screen.getByText("送信済み")).toBeInTheDocument();
  });
});
