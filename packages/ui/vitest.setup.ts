// `@testing-library/jest-dom` のマッチャ（toBeInTheDocument 等）を vitest の expect に登録する。
// この import は vitest の `Assertion` 型も拡張するため、tsc がマッチャを認識するよう本ファイルを
// tsconfig の include に入れている（さもないと typecheck だけ TS2339 で赤くなる）。
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// 各テスト後に jsdom の DOM をクリーンアップ（マウント残りによるテスト間汚染を防ぐ）。
afterEach(() => {
  cleanup();
});
