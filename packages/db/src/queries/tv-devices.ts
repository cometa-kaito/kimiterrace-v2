import { type InferSelectModel, and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { KimiterraceDb } from "../client.js";
import { withTenantContext } from "../client.js";
import { type TvSchedule, tvDevices } from "../schema/tv-devices.js";

/**
 * F15/F16 (ADR-022/ADR-023): TV デバイスの「ポーリング設定取得 + 死活心拍更新」と「管理一覧読み取り」の
 * クエリ層。
 *
 * 2 つの経路がある:
 *  1. **ポーリング（公開・セッション無し）**: `pollTvConfig`。`GET /api/tv/config` から呼ばれ、
 *     `device_id → school_id` を cross-tenant 解決して設定を返しつつ `last_seen_at` を更新する。
 *     `recordPresenceEvent`（F13, sensor-presence.ts）と同じ ADR-019 二層 RLS パターンを踏襲し、
 *     **BYPASSRLS は使わない**（ルール2）。`system_admin` role context（`system_admin_full_access`
 *     policy）で解決し、`device_id` は**グローバル UNIQUE**（schema 参照）なので必ず 1 行に解決して
 *     テナント越境配信を構造的に防ぐ。
 *  2. **管理一覧（認証セッション）**: `listTvDevices`。`/admin/tv-devices` の Server Component から
 *     `withSession` の RLS context 下で呼ぶ。可視範囲は RLS が決める（school_admin=自校 /
 *     system_admin=全校）。WHERE にテナント条件は書かない（schools.ts と同方針、ルール2）。
 *
 * 型は schema の `tvDevices` から `InferSelectModel` で派生する（ルール3、手書きドメイン型を作らない）。
 */

type TvDeviceRow = InferSelectModel<typeof tvDevices>;

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/**
 * TV デバイス一覧 1 行（管理 UI の一覧用射影）。設定の生値（webhook_url / notes）や監査列は含めず、
 * 一覧表示と稼働ステータス判定に要る最小限に絞る。`targetMac` は UI 側でマスク表示する（F15 §5）。
 */
export type TvDeviceSummary = Pick<
  TvDeviceRow,
  | "id"
  | "deviceId"
  | "label"
  | "schoolId"
  | "targetMac"
  | "version"
  | "lastSeenAt"
  | "lastBootAt"
  | "monitoringEnabled"
  | "alertState"
>;

/**
 * ポーリング応答（ADR-022 §レスポンス）。TV 側 ConfigPoller がこの形を解釈する。
 * `unknown=true` は device_id 未登録（F15 §2 受け入れ条件、UI 側で「未登録 TV のポーリング検出」通知用）。
 */
export type TvPollResult =
  | {
      unknown: false;
      version: number;
      config: {
        deviceLabel: string | null;
        targetMac: string | null;
        signageUrl: string | null;
        webhookUrl: string | null;
        schedule: TvSchedule | null;
      };
    }
  | { unknown: true; version: 0 };

export type TvPollInput = {
  /** TV が送る device_id（推測不能 UUIDv4、グローバル一意で 1 行に解決）。 */
  deviceId: string;
  /** x-forwarded-for 由来の最終ポーリング元 IP（運用診断用、null 可）。 */
  lastKnownIp: string | null;
};

/**
 * ポーリング: `device_id` で TV 設定を取得しつつ `last_seen_at`（+ `last_known_ip`）を更新する。
 *
 * ADR-022（pull 型）/ ADR-023（last_seen が死活信号）の中核。**ポーリングは高頻度（60 秒ごと）かつ
 * 設定変更ではない**ため、`audit_log` には記録しない（F15 §1 は「設定変更・コマンド発行・削除」を
 * 監査対象とする。心拍 touch は対象外。監査チェーンを毎分の心拍で膨らませない）。
 *
 * 解決と更新は単一トランザクション・単一 UPDATE ... RETURNING で原子的に行う:
 *  - `system_admin` role context（cross-tenant 可視）で device_id に一致しソフトデリートされていない
 *    行を `last_seen_at=now()` / `last_known_ip` に UPDATE し、設定列を RETURNING で受ける。
 *  - 0 行（未登録 / ソフトデリート済）なら `{ unknown: true, version: 0 }`。
 *
 * `updated_at` は心拍では**意図的に進めない**（last_seen_at が心拍の単一ソース。updated_at は設定変更の
 * 監査用に温存する）。これは「UPDATE では updated_at を明示設定する」規律の対象外＝心拍は設定更新では
 * ないため（last_seen_at/last_known_ip のみを進める専用 UPDATE）。
 *
 * @param db       非 BYPASSRLS の Drizzle クライアント（本番 `getDb()`）。
 * @param input    正規化済みのポーリング入力。
 * @param options  `appRole`: テスト superuser 接続を `kimiterrace_app` へ降格させ RLS を効かせる用
 *                 （本番接続は最初から kimiterrace_app のため未指定でよい）。
 */
export async function pollTvConfig(
  db: KimiterraceDb,
  input: TvPollInput,
  options?: { appRole?: string },
): Promise<TvPollResult> {
  return await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx): Promise<TvPollResult> => {
      // cross-tenant 解決 + 心拍更新を 1 文で原子的に。ソフトデリート済（deleted_at IS NOT NULL）は
      // 解決しない（撤去/退役 TV を「未登録」扱いにし、設定配信も死活計上もしない）。
      const updated = await tx
        .update(tvDevices)
        .set({ lastSeenAt: sql`now()`, lastKnownIp: input.lastKnownIp })
        .where(and(eq(tvDevices.deviceId, input.deviceId), isNull(tvDevices.deletedAt)))
        .returning({
          version: tvDevices.version,
          label: tvDevices.label,
          targetMac: tvDevices.targetMac,
          signageUrl: tvDevices.signageUrl,
          webhookUrl: tvDevices.webhookUrl,
          scheduleJson: tvDevices.scheduleJson,
        });

      const row = updated[0];
      if (!row) {
        return { unknown: true, version: 0 };
      }
      return {
        unknown: false,
        version: row.version,
        config: {
          deviceLabel: row.label,
          targetMac: row.targetMac,
          signageUrl: row.signageUrl,
          webhookUrl: row.webhookUrl,
          schedule: row.scheduleJson ?? null,
        },
      };
    },
    options,
  );
}

/**
 * 管理一覧: TV デバイスを取得する。可視範囲は RLS が決める（system_admin=全校 / テナント=自校のみ）。
 * ソフトデリート済（`deleted_at IS NOT NULL`）は一覧から除外する。ラベル → device_id の順で決定的に
 * 並べる（同一ラベルでも順序が安定）。
 *
 * `WHERE deleted_at IS NULL` は対象絞り込みであってテナント境界ではない（越境は RLS が弾く、schools.ts
 * の方針参照）。呼び出し側は RLS をバイパスしない接続ロール（kimiterrace_app）を使うこと。
 */
export async function listTvDevices(db: Selectable): Promise<TvDeviceSummary[]> {
  return db
    .select({
      id: tvDevices.id,
      deviceId: tvDevices.deviceId,
      label: tvDevices.label,
      schoolId: tvDevices.schoolId,
      targetMac: tvDevices.targetMac,
      version: tvDevices.version,
      lastSeenAt: tvDevices.lastSeenAt,
      lastBootAt: tvDevices.lastBootAt,
      monitoringEnabled: tvDevices.monitoringEnabled,
      alertState: tvDevices.alertState,
    })
    .from(tvDevices)
    .where(isNull(tvDevices.deletedAt))
    .orderBy(asc(tvDevices.label), asc(tvDevices.deviceId));
}
