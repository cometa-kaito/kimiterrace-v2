import { and, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { tvDeviceDowntime } from "../schema/tv-device-downtime.js";
import { tvDevices } from "../schema/tv-devices.js";
import {
  DEFAULT_TV_LIVENESS_THRESHOLDS,
  type TvLivenessClassification,
  type TvLivenessInput,
  type TvLivenessThresholds,
  classifyTvLiveness,
} from "./tv-liveness.js";

/**
 * F16 (ADR-023): TV 死活ギャップチェッカの **DB 反映層**（RLS 委譲）。
 *
 * `classifyTvLiveness`（純関数）が出した down/recover 遷移を、1 トランザクション内で `tv_devices` の
 * `alert_state` 反転 + `tv_device_downtime` 行の INSERT / クローズに落とす。チェッカは全校横断で走るため
 * `system_admin` role context（`system_admin_full_access` policy、BYPASSRLS 不使用、ルール2）で呼ぶ。
 *
 * ## 冪等性（idempotent / send-once、F16 §2）
 *  - 走査対象は「`monitoring_enabled` の TV」 + 「未解決ダウンタイム行を持つ TV」（監視を切られたまま
 *    取り残された行も締められるように）。各 TV の `hasOpenDowntime` は同一トランザクションで `recovered_at
 *    IS NULL` の行数から導く。
 *  - down 遷移の INSERT は `hasOpenDowntime===false` の TV にのみ起きる（純関数側で保証）。さらに DB 側でも
 *    挿入前に未解決行を `FOR UPDATE` で再カウントし、別チェッカ実行と競合しても二重 INSERT しない
 *    （直列化点。READ COMMITTED で先行 tx の挿入を確定後に見る）。
 *  - recover の UPDATE は未解決行のみを対象にするため、再走査で既に締めた行を二度 UPDATE しない。
 *
 * ## なぜ純関数 + 反映層に分けるか
 * 判定（閾値・遷移・原因推定）はネットワーク/DB 非依存の純関数で単体テストし、本層は「読取 → 純関数 →
 * 書込」の結線と直列化・RLS のみを担う（`weather/run.ts` の DI 分離と同じ思想）。
 */

/** チェッカ 1 回分の集計（Cloud Logging に構造化ログとして残す。PII を含めない）。 */
export interface TvLivenessCheckSummary {
  /** 走査した TV 台数。 */
  scanned: number;
  /** 新たに down 計上した台数（ダウンタイム行を INSERT）。 */
  newlyDown: number;
  /** 復帰として締めた台数（ダウンタイム行を UPDATE）。 */
  recovered: number;
}

/** 走査対象 1 行の内部表現（schema 由来 + 未解決行有無）。 */
type DeviceStateRow = TvLivenessInput;

/**
 * 死活チェックを 1 回実行する（RLS context 内トランザクションで呼ぶ）。
 *
 * @param tx          `system_admin` context を張ったトランザクション（cross-tenant 走査・書込み）。
 * @param now         判定基準時刻（チェッカ実行時刻）。テストで固定値を渡せるよう注入する。
 * @param thresholds  down 閾値（環境変数由来、F16 §6）。省略時は既定（3 分 / OFF 時 30 分）。
 * @returns           遷移件数のサマリ。
 */
export async function runTvLivenessCheck(
  tx: TenantTx,
  now: Date,
  thresholds: TvLivenessThresholds = DEFAULT_TV_LIVENESS_THRESHOLDS,
): Promise<TvLivenessCheckSummary> {
  const states = await loadDeviceStates(tx);
  const classification: TvLivenessClassification = classifyTvLiveness(states, now, thresholds);

  await applyTransitions(tx, classification);

  return {
    scanned: states.length,
    newlyDown: classification.newlyDown.length,
    recovered: classification.recovered.length,
  };
}

/**
 * 走査対象の TV 状態を読み取る。ソフトデリート済（`deleted_at IS NOT NULL`）は除外する（退役 TV は死活
 * 計上しない、tv-devices.ts の pollTvConfig と一貫）。各 TV の未解決ダウンタイム行有無を LEFT JOIN の
 * 存在判定で同時に取る。
 */
async function loadDeviceStates(tx: TenantTx): Promise<DeviceStateRow[]> {
  const rows = await tx
    .select({
      deviceId: tvDevices.deviceId,
      schoolId: tvDevices.schoolId,
      lastSeenAt: tvDevices.lastSeenAt,
      lastBootAt: tvDevices.lastBootAt,
      alertState: tvDevices.alertState,
      monitoringEnabled: tvDevices.monitoringEnabled,
      schedule: tvDevices.scheduleJson,
      // 未解決（recovered_at IS NULL）ダウンタイム行が 1 件でもあれば true。
      hasOpenDowntime: sql<boolean>`EXISTS (
        SELECT 1 FROM ${tvDeviceDowntime} d
        WHERE d.device_id = ${tvDevices.deviceId} AND d.recovered_at IS NULL
      )`,
    })
    .from(tvDevices)
    .where(isNull(tvDevices.deletedAt));

  return rows.map((r) => ({
    deviceId: r.deviceId,
    schoolId: r.schoolId,
    lastSeenAt: r.lastSeenAt,
    lastBootAt: r.lastBootAt,
    alertState: r.alertState,
    monitoringEnabled: r.monitoringEnabled,
    schedule: r.schedule ?? null,
    hasOpenDowntime: r.hasOpenDowntime,
  }));
}

/**
 * 純関数の遷移結果を DB に反映する。down は新規行 INSERT（再カウントで二重防止）+ alert_state='down'、
 * recover は未解決行クローズ + alert_state='ok'。
 */
async function applyTransitions(
  tx: TenantTx,
  classification: TvLivenessClassification,
): Promise<void> {
  for (const down of classification.newlyDown) {
    // 直列化 + 二重 INSERT 防止: 未解決行を FOR UPDATE で再確認し、無い場合のみ INSERT。
    const open = await tx
      .select({ id: tvDeviceDowntime.id })
      .from(tvDeviceDowntime)
      .where(
        and(eq(tvDeviceDowntime.deviceId, down.deviceId), isNull(tvDeviceDowntime.recoveredAt)),
      )
      .for("update");
    if (open.length > 0) {
      // 別チェッカ実行が先に INSERT 済み → 状態フラグだけ揃えて二重計上しない。
      await tx
        .update(tvDevices)
        .set({ alertState: "down" })
        .where(eq(tvDevices.deviceId, down.deviceId));
      continue;
    }

    await tx.insert(tvDeviceDowntime).values({
      deviceId: down.deviceId,
      schoolId: down.schoolId,
      wentDownAt: down.wentDownAt,
    });
    await tx
      .update(tvDevices)
      .set({ alertState: "down" })
      .where(eq(tvDevices.deviceId, down.deviceId));
  }

  for (const rec of classification.recovered) {
    // 未解決行のみ締める（再走査で締め済み行を二度触らない）。duration_sec は DB 側で算出して格納
    // （recovered_at - went_down_at の秒。EXTRACT(EPOCH ...) を四捨五入し非負に丸める）。
    await tx
      .update(tvDeviceDowntime)
      .set({
        recoveredAt: rec.recoveredAt,
        durationSec: sql`GREATEST(0, ROUND(EXTRACT(EPOCH FROM (${rec.recoveredAt}::timestamptz - ${tvDeviceDowntime.wentDownAt})))::int)`,
        causeHint: rec.causeHint,
        updatedAt: rec.recoveredAt,
      })
      .where(
        and(eq(tvDeviceDowntime.deviceId, rec.deviceId), isNull(tvDeviceDowntime.recoveredAt)),
      );
    await tx
      .update(tvDevices)
      .set({ alertState: "ok" })
      .where(eq(tvDevices.deviceId, rec.deviceId));
  }
}
