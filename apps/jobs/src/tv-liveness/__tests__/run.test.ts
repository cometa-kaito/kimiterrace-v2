import { describe, expect, it } from "vitest";
import { resolveThresholds } from "../run.js";

/**
 * F16 (ADR-023): TV 死活ジョブの env→閾値解決 seam（`resolveThresholds`）の単体検証（DB 非依存）。
 * 実 PG / RLS / 遷移ロジックは packages/db の tv-liveness.test.ts（純関数）と tv-device-downtime.test.ts
 * （実 PG）でカバーする。本ファイルは「片方だけ指定 / 未指定は既定」の I/O 結線だけを固定する。
 */
describe("resolveThresholds", () => {
  it("未指定は既定（3 分 / OFF 時 30 分）", () => {
    expect(resolveThresholds()).toEqual({ downThresholdSec: 180, offHoursThresholdSec: 1800 });
    expect(resolveThresholds({})).toEqual({ downThresholdSec: 180, offHoursThresholdSec: 1800 });
  });

  it("down 閾値だけ上書きすると OFF 閾値は既定のまま", () => {
    expect(resolveThresholds({ downThresholdSec: 120 })).toEqual({
      downThresholdSec: 120,
      offHoursThresholdSec: 1800,
    });
  });

  it("OFF 閾値だけ上書きすると down 閾値は既定のまま", () => {
    expect(resolveThresholds({ offHoursThresholdSec: 3600 })).toEqual({
      downThresholdSec: 180,
      offHoursThresholdSec: 3600,
    });
  });

  it("undefined を渡しても既定にフォールバックする（optionalIntEnv の未設定経路）", () => {
    expect(
      resolveThresholds({ downThresholdSec: undefined, offHoursThresholdSec: undefined }),
    ).toEqual({ downThresholdSec: 180, offHoursThresholdSec: 1800 });
  });

  it("両方上書き", () => {
    expect(resolveThresholds({ downThresholdSec: 90, offHoursThresholdSec: 600 })).toEqual({
      downThresholdSec: 90,
      offHoursThresholdSec: 600,
    });
  });
});
