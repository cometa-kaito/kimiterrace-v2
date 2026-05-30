import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// 各テスト後に DOM をクリーンアップ (jsdom 環境のコンポーネントテスト用)。
// node 環境のテストでもマウント済みコンテナが無ければ no-op なので安全。
afterEach(() => {
  cleanup();
});
