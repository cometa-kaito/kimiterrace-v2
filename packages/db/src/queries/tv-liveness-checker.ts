import { and, eq, exists, isNotNull, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { tvDeviceDowntime } from "../schema/tv-device-downtime.js";
import { tvDevices } from "../schema/tv-devices.js";
import {
  DEFAULT_TV_LIVENESS_THRESHOLDS,
  DEFAULT_TV_LONG_SILENCE_SEC,
  type TvLivenessClassification,
  type TvLivenessInput,
  type TvLivenessThresholds,
  type TvLongSilenceClassification,
  classifyLongSilence,
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

/**
 * チェッカ 1 回分の集計（Cloud Logging に構造化ログとして残す。`label` は PII 非含み = 教室名のみ、
 * F16 §5）。`downDevices` / `recoveredDevices` は **state 反転エッジ**でのみ要素を持ち、それぞれ
 * `newlyDown` / `recovered` の件数と厳密に一致する（実書込みが起きた TV だけを積む。下記
 * `applyTransitions` 参照）。エントリ（`apps/jobs`）はこれを使って **エッジ 1 回だけ** Slack へ通知し、
 * 既に down 中の TV を再通知しない（状態機械が send-once を保証する）。
 */
export interface TvLivenessCheckSummary {
  /** 走査した TV 台数。 */
  scanned: number;
  /** 新たに down 計上した台数（ダウンタイム行を INSERT）。 */
  newlyDown: number;
  /** 復帰として締めた台数（ダウンタイム行を UPDATE）。 */
  recovered: number;
  /**
   * 今回 up→down に反転した TV（ダウンタイム行を実際に INSERT した分のみ）。`newlyDown` と件数一致。
   * Slack 🔴 アラートの素材（device ラベル・学校・最終観測時刻）。型は inline（新規 export 型を増やさない）。
   */
  downDevices: {
    deviceId: string;
    schoolId: string;
    label: string | null;
    lastSeenAt: Date | null;
    wentDownAt: Date;
    /**
     * 端末が報告した FCM 登録トークン（遠隔起動の宛先、F16 拡張）。NULL = 未報告（旧 APK / 報告前）で
     * 送信対象外。entrypoint（apps/jobs）が down エッジごとにこれを使って wake 送信する（`@kimiterrace/fcm`）。
     */
    fcmToken: string | null;
  }[];
  /**
   * 今回 down→up に反転した TV（未解決行を実際に締めた分のみ）。`recovered` と件数一致。
   * Slack 🟢 復帰通知の素材。型は inline（新規 export 型を増やさない）。
   */
  recoveredDevices: {
    deviceId: string;
    schoolId: string;
    label: string | null;
    lastSeenAt: Date | null;
  }[];
  /** 今回 NULL → now() に立てた「新規 長時間サイレンス」台数（dedup 列 UPDATE）。`longSilentDevices` と件数一致。 */
  newlyLongSilent: number;
  /** 今回 now() → NULL に戻した「長時間サイレンス クリア」台数。`longSilenceClearedDevices` と件数一致。 */
  longSilenceCleared: number;
  /**
   * 今回 新たに長時間サイレンスへ突入した TV（dedup 列を実際に NULL → now() に立てた分のみ）。
   * `newlyLongSilent` と件数一致。Slack ⚠️ 長時間サイレンス通知の素材。down/recover とは独立した別シグナルで、
   * schedule-agnostic（OFF 中でも 6h 無音は実障害）。型は inline（新規 export 型を増やさない）。
   */
  longSilentDevices: {
    deviceId: string;
    schoolId: string;
    label: string | null;
    /** 無音の起点（最後に観測した last_seen_at）。通知文の経過時間算出に使う。 */
    lastSeenAt: Date;
  }[];
  /**
   * 今回 長時間サイレンスから復帰した TV（dedup 列を実際に now() → NULL に戻した分のみ）。
   * `longSilenceCleared` と件数一致。任意の 🟢 サイレンス復帰通知の素材（recovery opt-in で gate）。
   */
  longSilenceClearedDevices: {
    deviceId: string;
    schoolId: string;
    label: string | null;
    lastSeenAt: Date | null;
  }[];
}

/** 走査対象 1 行の内部表現（schema 由来 + 未解決行有無 + 表示ラベル + FCM トークン）。 */
type DeviceStateRow = TvLivenessInput & {
  /** 表示用ラベル（教室名等、PII 非含み）。Slack 通知文に使う。 */
  label: string | null;
  /** FCM 登録トークン（遠隔起動の宛先、F16 拡張）。NULL = 未報告で送信対象外。 */
  fcmToken: string | null;
};

/**
 * 死活チェックを 1 回実行する（RLS context 内トランザクションで呼ぶ）。
 *
 * @param tx              `system_admin` context を張ったトランザクション（cross-tenant 走査・書込み）。
 * @param now             判定基準時刻（チェッカ実行時刻）。テストで固定値を渡せるよう注入する。
 * @param thresholds      down 閾値（環境変数由来、F16 §6）。省略時は既定（3 分 / OFF 時 30 分）。
 * @param longSilenceSec  長時間サイレンス閾値（秒、環境変数由来）。省略時は既定（6h = 21600）。
 * @returns               遷移件数のサマリ（down/recover + 長時間サイレンス）。
 */
export async function runTvLivenessCheck(
  tx: TenantTx,
  now: Date,
  thresholds: TvLivenessThresholds = DEFAULT_TV_LIVENESS_THRESHOLDS,
  longSilenceSec: number = DEFAULT_TV_LONG_SILENCE_SEC,
): Promise<TvLivenessCheckSummary> {
  const states = await loadDeviceStates(tx);
  const classification: TvLivenessClassification = classifyTvLiveness(states, now, thresholds);
  // 長時間サイレンス（schedule-agnostic）は down/recover と独立した別シグナル。同じ事前読取（states）を
  // 入力に、isSignageOffHours を見ずに「6h 超 無音」を判定する（OFF/休日でも 24/7 ポーリング前提ゆえ実障害）。
  const longSilence: TvLongSilenceClassification = classifyLongSilence(states, now, longSilenceSec);

  // サマリは「分類した件数（意図）」ではなく applyTransitions が**実際に書き込んだ件数**を返す。
  // 分類は loadDeviceStates の事前読取に基づくため、別チェッカ実行と同時発火すると 2 本とも
  // 同一 TV を newlyDown と分類しうる（双方が INSERT 前に hasOpenDowntime=false を見るタイミング）。
  // 直列化点（親行 FOR UPDATE）で DB の未解決行は 1 行に保たれるが、サマリを classification 長で
  // 数えると「スキップした 2 本目」も計上され newlyDown 合計が 2 になる非決定（#517）。実書込件数を
  // 返せば、勝者が 1・敗者が 0 で timing 非依存に合計 1 となる。downDevices / recoveredDevices も
  // applyTransitions 内で「実際に書き込んだ TV」だけを積むため、件数と配列長は常に一致する。
  // 通知文に要る label / lastSeenAt は事前読取（states）から device 単位で引く（同一 tx 内の値）。
  const stateByDevice = new Map(states.map((s) => [s.deviceId, s] as const));
  return {
    scanned: states.length,
    ...(await applyTransitions(tx, classification, stateByDevice)),
    ...(await applyLongSilenceTransitions(tx, longSilence, stateByDevice)),
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
      // 表示用ラベル（教室名等、PII 非含み）。Slack 通知文に載せる（F16 §4）。
      label: tvDevices.label,
      // FCM 登録トークン（遠隔起動の宛先、F16 拡張）。down エッジで wake 送信に使う。
      fcmToken: tvDevices.fcmToken,
      lastSeenAt: tvDevices.lastSeenAt,
      lastBootAt: tvDevices.lastBootAt,
      alertState: tvDevices.alertState,
      monitoringEnabled: tvDevices.monitoringEnabled,
      schedule: tvDevices.scheduleJson,
      // 長時間サイレンス通知の send-once dedup 状態（schedule-agnostic 検出器が読む）。NULL = 未アラート。
      longSilenceNotifiedAt: tvDevices.longSilenceNotifiedAt,
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
    label: r.label,
    fcmToken: r.fcmToken,
    lastSeenAt: r.lastSeenAt,
    lastBootAt: r.lastBootAt,
    alertState: r.alertState,
    monitoringEnabled: r.monitoringEnabled,
    schedule: r.schedule ?? null,
    hasOpenDowntime: r.hasOpenDowntime,
    longSilenceNotifiedAt: r.longSilenceNotifiedAt,
  }));
}

/**
 * 純関数の遷移結果を DB に反映し、**実際に書き込んだ件数**を返す。down は新規行 INSERT（再カウントで
 * 二重防止）+ alert_state='down'、recover は未解決行クローズ + alert_state='ok'。
 *
 * 返す件数は classification の長さではなく実書込数: down は FOR UPDATE 再確認で既存未解決行を見て
 * INSERT を見送った場合は計上しない（同時発火の敗者を二重計上しない、#517）。recover は `.returning()`
 * で実際に締めた行があった場合のみ計上する（別チェッカが先に締めた行は 0 行更新 → 非計上、対称な堅牢化）。
 */
async function applyTransitions(
  tx: TenantTx,
  classification: TvLivenessClassification,
  stateByDevice: ReadonlyMap<string, DeviceStateRow>,
): Promise<
  Pick<TvLivenessCheckSummary, "newlyDown" | "recovered" | "downDevices" | "recoveredDevices">
> {
  let newlyDown = 0;
  let recovered = 0;
  const downDevices: TvLivenessCheckSummary["downDevices"] = [];
  const recoveredDevices: TvLivenessCheckSummary["recoveredDevices"] = [];
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
    newlyDown += 1; // 実際に INSERT した時のみ計上（スキップ経路は continue 済みで非計上）。
    // 実 INSERT したエッジだけ通知素材を積む（newlyDown と配列長を一致させる。同時発火の敗者は
    // 上の continue 経路で非計上 = 非 push なので二重通知しない）。label / lastSeenAt は事前読取から引く。
    const st = stateByDevice.get(down.deviceId);
    downDevices.push({
      deviceId: down.deviceId,
      schoolId: down.schoolId,
      label: st?.label ?? null,
      lastSeenAt: st?.lastSeenAt ?? null,
      wentDownAt: down.wentDownAt,
      fcmToken: st?.fcmToken ?? null,
    });
  }

  for (const rec of classification.recovered) {
    // 未解決行のみ締める（再走査で締め済み行を二度触らない）。recovered_at / duration_sec は **DB 側で
    // now() から算出**して格納する。JS Date を raw sql`` フラグメントに `::timestamptz` で bind すると
    // postgres@3.4.9 が直列化できず実 PG でクラッシュするため（[[pg-date-bind-enum-insert]]）、Date を
    // 一切 bind せず DB now() に倒す。recovered_at = 復帰観測時刻 = チェッカ実行時刻 ≈ now() で意味も一致。
    // duration_sec は (now() - went_down_at) の秒を四捨五入し非負に丸める。
    const closed = await tx
      .update(tvDeviceDowntime)
      .set({
        recoveredAt: sql`now()`,
        durationSec: sql`GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - ${tvDeviceDowntime.wentDownAt})))::int)`,
        causeHint: rec.causeHint,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tvDeviceDowntime.deviceId, rec.deviceId), isNull(tvDeviceDowntime.recoveredAt)))
      .returning({ id: tvDeviceDowntime.id });
    await tx
      .update(tvDevices)
      .set({ alertState: "ok", updatedAt: new Date() })
      .where(eq(tvDevices.deviceId, rec.deviceId));
    if (closed.length > 0) {
      recovered += 1; // 実際に未解決行を締めた時のみ計上（別チェッカが先に締めていれば 0 行更新で非計上）。
      // 実際に締めたエッジだけ通知素材を積む（recovered と配列長を一致させる）。lastSeenAt は復帰後の
      // 鮮度 OK な値（事前読取）。
      const st = stateByDevice.get(rec.deviceId);
      recoveredDevices.push({
        deviceId: rec.deviceId,
        schoolId: rec.schoolId,
        label: st?.label ?? null,
        lastSeenAt: st?.lastSeenAt ?? null,
      });
    }
  }

  return { newlyDown, recovered, downDevices, recoveredDevices };
}

/**
 * 長時間サイレンス（schedule-agnostic）の純判定結果を DB に反映し、**実際に書き込んだ件数**を返す。
 * down/recover とは独立した別経路で、`tv_device_downtime` 行は一切作らない（運用ダウンタイム表を汚さない）。
 * 反映する状態は `tv_devices.long_silence_notified_at` の send-once dedup 列のみ:
 *  - newlyLongSilent: 列が NULL のまま → `now()` を立てる（1 回だけアラート）。
 *  - cleared: 列が non-NULL → `NULL` に戻す（次の途絶で再アラート可能に）。
 *
 * 返す件数は classification の長さではなく実書込数: 同時発火・別チェッカが先に書いた場合に二重計上しない。
 *  - newlyLongSilent は親 tv_devices 行を `FOR UPDATE` でロック（device 単位の直列化点、down INSERT と同じ
 *    思想 [[realpg_concurrency_test_deterministic]]）→ ロック下で `long_silence_notified_at IS NULL` を
 *    条件に UPDATE し `.returning()`。2 本目はロック解放後に列が立っているのを見て 0 行更新 = 非計上。
 *  - cleared は `IS NOT NULL` 条件で UPDATE し `.returning()`。別チェッカが先に NULL に戻していれば 0 行更新。
 *
 * 時刻は JS Date を bind せず DB 側 `now()` に倒す（postgres@3.x が Date を raw `sql` で直列化できずクラッシュ
 * する [[pg-date-bind-enum-insert]]。「アラート開始時刻 ≈ チェッカ実行時刻 = now()」で意味も一致）。
 * updated_at もルール1（監査整合）で `now()` に前進させる。
 */
async function applyLongSilenceTransitions(
  tx: TenantTx,
  classification: TvLongSilenceClassification,
  stateByDevice: ReadonlyMap<string, DeviceStateRow>,
): Promise<
  Pick<
    TvLivenessCheckSummary,
    "newlyLongSilent" | "longSilenceCleared" | "longSilentDevices" | "longSilenceClearedDevices"
  >
> {
  let newlyLongSilent = 0;
  let longSilenceCleared = 0;
  const longSilentDevices: TvLivenessCheckSummary["longSilentDevices"] = [];
  const longSilenceClearedDevices: TvLivenessCheckSummary["longSilenceClearedDevices"] = [];

  for (const ls of classification.newlyLongSilent) {
    // 直列化点（device 単位）: 親 tv_devices 行を FOR UPDATE。同時発火の 2 本目はロック解放までブロックされ、
    // 解放後に列が立っているのを見て 0 行更新になる（二重通知しない）。
    await tx
      .select({ deviceId: tvDevices.deviceId })
      .from(tvDevices)
      .where(eq(tvDevices.deviceId, ls.deviceId))
      .for("update");

    // ロック下で「まだ NULL のとき**だけ**」now() を立てる。先行 tx が既に立てていれば 0 行更新 = 非計上。
    const set = await tx
      .update(tvDevices)
      .set({ longSilenceNotifiedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(tvDevices.deviceId, ls.deviceId), isNull(tvDevices.longSilenceNotifiedAt)))
      .returning({ id: tvDevices.id });
    if (set.length > 0) {
      newlyLongSilent += 1;
      const st = stateByDevice.get(ls.deviceId);
      longSilentDevices.push({
        deviceId: ls.deviceId,
        schoolId: ls.schoolId,
        label: st?.label ?? null,
        lastSeenAt: ls.lastSeenAt,
      });
    }
  }

  for (const cl of classification.cleared) {
    // non-NULL のとき**だけ** NULL に戻す（別チェッカが先に戻していれば 0 行更新 = 非計上、対称な堅牢化）。
    const set = await tx
      .update(tvDevices)
      .set({ longSilenceNotifiedAt: null, updatedAt: sql`now()` })
      .where(and(eq(tvDevices.deviceId, cl.deviceId), isNotNull(tvDevices.longSilenceNotifiedAt)))
      .returning({ id: tvDevices.id });
    if (set.length > 0) {
      longSilenceCleared += 1;
      const st = stateByDevice.get(cl.deviceId);
      longSilenceClearedDevices.push({
        deviceId: cl.deviceId,
        schoolId: cl.schoolId,
        label: st?.label ?? null,
        lastSeenAt: st?.lastSeenAt ?? null,
      });
    }
  }

  return { newlyLongSilent, longSilenceCleared, longSilentDevices, longSilenceClearedDevices };
}
