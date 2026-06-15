import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAST_CLASS_COOKIE,
  RememberLastClass,
} from "../../app/app/editor/[classId]/_components/RememberLastClass";

/**
 * 「前回のクラスを再開」cookie の **path 属性** を pin する回帰テスト。
 *
 * 背景 (#894 ルーティング改称の取りこぼし): エディタは `/admin/editor` から `/app/editor` へ移ったが、
 * 本 cookie は `path=/admin` のまま書かれていた。`/admin` は `/app` へ 308 リダイレクトされ実際には
 * 訪問されないため、reader (Server Component `/app/editor`、`page.tsx` の `cookies().get`) のリクエストに
 * この cookie が一切送られず、「前回のクラスを再開」リンクが永遠に出なかった。
 *
 * 既存 `editor-index-page.test.tsx` は `next/headers` の `cookies()` を mock するためブラウザの path
 * 適用をバイパスし、この path 不整合を捕捉できない。本テストは `document.cookie` の **setter** をフックして
 * 書き込み生文字列を捕捉し、reader へ届く最小スコープ `path=/app` を直接検証する。
 */

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

describe("RememberLastClass の cookie path", () => {
  let writes: string[];
  // `document.cookie` はプロトタイプ上の accessor。インスタンスに own プロパティで一時上書きして
  // 書き込みを捕捉し、テスト後に own プロパティを消してプロトタイプ挙動へ戻す。
  let hadOwn: boolean;

  beforeEach(() => {
    writes = [];
    hadOwn = Object.hasOwn(document, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => writes.join("; "),
      set: (value: string) => {
        writes.push(value);
      },
    });
  });

  afterEach(() => {
    if (!hadOwn) {
      delete (document as { cookie?: unknown }).cookie;
    }
  });

  it("reader (/app/editor) に届く最小スコープ path=/app で書く（改称前の /admin ではない）", () => {
    render(<RememberLastClass classId={CLASS_ID} />);

    // useEffect は @testing-library/react の render (act 内) で同期 flush される。
    expect(writes).toHaveLength(1);
    const written = writes[0];

    // 値は classId のみ（UUID は encodeURIComponent で不変）。
    expect(written).toContain(`${LAST_CLASS_COOKIE}=${CLASS_ID}`);
    // reader へ確実に届く最小スコープ = /app。/admin だと 308 先 /app に届かず再開リンクが出ない。
    expect(written).toMatch(/;\s*path=\/app(?=\s*;|\s*$)/);
    expect(written).not.toContain("path=/admin");
    // 既存の他属性も維持されていること（誤って属性を落としていない回帰防止）。
    expect(written).toContain("samesite=lax");
    expect(written).toMatch(/max-age=\d+/);
  });
});
