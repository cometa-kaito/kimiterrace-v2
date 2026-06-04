import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// #289 AI kill-switch のテストベースライン: web テストスイートは AI 有効を既定とする。
// 実 Vertex 入口 (F03 抽出 route / F06 chat seam / F08 効果コメント action) は AI_ENABLED !== "true" の時
// 503 / disabled に倒れるため、各機能の正常系テストが意味を持つよう既定で "true" を立てる。無効時
// (503 / disabled) を検証するテストは個別に vi.stubEnv("AI_ENABLED", ...) で上書きする (ai-enabled.test.ts 他)。
process.env.AI_ENABLED = "true";

// 各テスト後に DOM をクリーンアップ (jsdom 環境のコンポーネントテスト用)。
// node 環境のテストでもマウント済みコンテナが無ければ no-op なので安全。
afterEach(() => {
  cleanup();
});
