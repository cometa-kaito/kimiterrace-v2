import { and, eq, exists, isNull, sql } from "drizzle-orm";
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
 *    挿入前に **親 `tv_devices` 行を `FOR UPDATE` でロック**して device 単位の直列化点を作り、別チェッカ
 *    実行と競合しても二重 INSERT しない。初回 down（未解決行がまだ 0 件）でも親行は FK で常に存在するため
 *    ロック対象が空にならず、2 本目は 1 本目の commit 後に未解決行を再走査して INSERT を見送る
 *    （READ COMMITTED で先行 tx の挿入を確定後に見る）。未解決行側だけを `FOR UPDATE` しても空集合は
 *    ロックできず phantom INSERT を止められないため、常に存在する親行に直列化点を置く。
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
 * 計上しない、tv-devices.ts の pollTvConfig と一貫）。各 TV の未解決ダウンタイム行有無を相関 EXISTS
 * サブクエリ（device 単位で相関）で同時に取る。
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
      // この TV に未解決（recovered_at IS NULL）ダウンタイム行が 1 件でもあれば true。
      // Drizzle の exists() を使い、相関サブクエリの両辺を **テーブル修飾付き**で描画させる
      // （tv_device_downtime.device_id = tv_devices.device_id）。手書き sql`` で
      // `${tvDevices.deviceId}` を埋めると、トップレベル SELECT の単一 FROM では列参照が
      // 非修飾の "device_id" に描画され、サブクエリ内で自テーブル(tv_device_downtime)の device_id に
      // 束縛されて相関が外れる（= 全デバイスで「未解決行が存在すれば true」になる）バグがあった。
      hasOpenDowntime: sql<boolean>`${exists(
        tx
          .select({ one: sql`1` })
          .from(tvDeviceDowntime)
          .where(
            and(
              eq(tvDeviceDowntime.deviceId, tvDevices.deviceId),
              isNull(tvDeviceDowntime.recoveredAt),
            ),
          ),
      )}`,
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
    // 直列化点（device 単位）: 親 tv_devices 行を FOR UPDATE でロックする。FK で必ず 1 行存在するため、
    // 「初回 down（未解決行がまだ 0 件）」でも空集合にならず、同時実行の 2 本目はこのロック解放まで
    // ブロックされる。FOR UPDATE は既存行しかロックできないので、未解決行が 0 件の段階で downtime 側を
    // ロックしても phantom INSERT を止められない（[[realpg_concurrency_test_deterministic]]）。常に存在する
    // 親行に直列化点を置くことで、2 本目は 1 本目の commit 後に再走査し未解決行を見て二重 INSERT しない。
    await tx
      .select({ deviceId: tvDevices.deviceId })
      .from(tvDevices)
      .where(eq(tvDevices.deviceId, down.deviceId))
      .for("update");

    // 親ロック獲得後に未解決行を再確認する（先行 tx が INSERT 済みなら READ COMMITTED でここで見える）。
    const open = await tx
      .select({ id: tvDeviceDowntime.id })
      .from(tvDeviceDowntime)
      .where(
        and(eq(tvDeviceDowntime.deviceId, down.deviceId), isNull(tvDeviceDowntime.recoveredAt)),
      );
    if (open.length > 0) {
      // 別チェッカ実行が先に INSERT 済み → 状態フラグだけ揃えて二重計上しない。
      await tx
        .update(tvDevices)
        .set({ alertState: "down", updatedAt: new Date() })
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
      .set({ alertState: "down", updatedAt: new Date() })
      .where(eq(tvDevices.deviceId, down.deviceId));
  }

  for (const rec of classification.recovered) {
    // 未解決行のみ締める（再走査で締め済み行を二度触らない）。recovered_at / duration_sec は **DB 側で
    // now() から算出**して格納する。JS Date を raw sql`` フラグメントに `::timestamptz` で bind すると
    // postgres@3.4.9 が直列化できず実 PG でクラッシュするため（[[pg-date-bind-enum-insert]]）、Date を
    // 一切 bind せず DB now() に倒す。recovered_at = 復帰観測時刻 = チェッカ実行時刻 ≈ now() で意味も一致。
    // duration_sec は (now() - went_down_at) の秒を四捨五入し非負に丸める。
    await tx
      .update(tvDeviceDowntime)
      .set({
        recoveredAt: sql`now()`,
        durationSec: sql`GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - ${tvDeviceDowntime.wentDownAt})))::int)`,
        causeHint: rec.causeHint,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(tvDeviceDowntime.deviceId, rec.deviceId), isNull(tvDeviceDowntime.recoveredAt)),
      );
    await tx
      .update(tvDevices)
      .set({ alertState: "ok", updatedAt: new Date() })
      .where(eq(tvDevices.deviceId, rec.deviceId));
  }
}
