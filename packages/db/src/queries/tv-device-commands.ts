import { type InferSelectModel, and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type TvCommandType, tvCommandType } from "../_shared/enums.js";
import type { KimiterraceDb, TenantTx } from "../client.js";
import { withTenantContext } from "../client.js";
import { auditLog } from "../schema/audit-log.js";
import { tvDeviceCommands } from "../schema/tv-device-commands.js";
import { tvDevices } from "../schema/tv-devices.js";

/**
 * F15 (ADR-022): TV リモートコマンドキューのクエリ層。3 経路:
 *
 *  1. **発行（管理セッション）**: `enqueueTvCommand`。`/admin/tv-devices/:id` の Server Action から
 *     `withSession` の RLS tx 内で呼ぶ。device 行 PK から device_id + school_id を RLS スコープで解決し、
 *     `tv_device_commands` に pending を 1 件 INSERT + `audit_log` 追記（同 tx・原子的）。手書き WHERE
 *     school_id は書かず RLS に委譲（ルール2）: school_admin は `tenant_isolation` で自校のみ、system_admin は
 *     `system_admin_full_access` で全校（cross-tenant 運用者）。
 *  2. **配信（ポーリング・セッション無し）**: `pollPendingTvCommands`。`GET /api/tv/config` から呼ばれ、
 *     `device_id` で cross-tenant 解決して自分宛の pending コマンドを返す。`pollTvConfig` と同じ
 *     `system_admin` role context（`system_admin_full_access` policy、BYPASSRLS 不使用、ルール2）。
 *  3. **ack（ポーリング・セッション無し）**: `ackTvCommand`。TV が実行後に叩く。pending → delivered の
 *     1 方向遷移を **冪等** に行う（既に delivered なら何もしない）。同じく system_admin context で解決。
 *
 * 型は schema の `tvDeviceCommands` から `InferSelectModel` で派生する（ルール3、手書きドメイン型を作らない）。
 */

type TvCommandRow = InferSelectModel<typeof tvDeviceCommands>;

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** コマンド種別の型を再エクスポート（呼び出し側が enums サブパスを知らずに使える）。単一ソースは enums.ts。 */
export type { TvCommandType };

/** 発行可能なコマンド種別の配列（順序つき、UI のボタン並びにも使う）。enum とズレないことを保証。 */
export const TV_COMMAND_TYPES: readonly TvCommandType[] = tvCommandType.enumValues;

/**
 * ポーリング応答に載せる pending コマンド 1 件（最小・PII 非格納）。TV 側 ConfigPoller がこの形を解釈する。
 * `id` は ack で返す識別子、`command` は実行種別、`params` は引数メタ（無ければ null）。
 */
export type PendingTvCommand = {
  id: string;
  command: TvCommandType;
  params: Record<string, unknown> | null;
};

export type EnqueueTvCommandParams = {
  /** 対象 `tv_devices.id`（行 PK。device_id ではない）。RLS スコープで device_id / school_id を解決する。 */
  deviceRowId: string;
  command: TvCommandType;
  /** コマンド引数（任意・機械メタのみ、PII 非格納）。 */
  params?: Record<string, unknown> | null;
  /**
   * 発行者 `users.id`（監査 actor、`issued_by` / `created_by` / `updated_by` = users(id) FK、migration 0019）。
   * **system_admin は `users` 行でないため null**（FK 違反回避、createTvDevice と同パターン）。
   */
  actorUserId: string | null;
  /** 発行者の Identity Platform UID（FK なし `audit_log.actor_identity_uid`、system_admin 操作の追跡用）。 */
  actorIdentityUid: string;
  /** 失効期限（任意）。null/未指定は無期限。 */
  expiresAt?: Date | null;
};

export type EnqueueTvCommandResult =
  | { status: "enqueued"; id: string; deviceId: string }
  | { status: "device_not_found" };

/**
 * 発行: 指定 TV デバイスへ pending コマンドを 1 件キューイングする（RLS スコープ + 監査）。
 *
 * - **device 解決（RLS 委譲、ルール2）**: 行 PK から device_id / school_id を引く。手書き WHERE school_id は
 *   書かず、可視範囲は RLS が決める: `tenant_isolation`（school_admin = 自校）/ `system_admin_full_access`
 *   （system_admin = 全校、cross-tenant 運用者）。他校 / 不可視 / ソフトデリート済（退役 TV）は 0 行 →
 *   `device_not_found`（呼び出し側で not_found に写像）。
 * - **INSERT**: 解決した device_id / school_id を明示して pending を作る。`issued_by`=actor（system_admin は
 *   null＝users 行でないため）、`issued_at`は DB 既定 now()。
 * - **監査（ルール1 / NFR04）**: コマンド発行は `audit_log` に 1 件残す（誰がいつどの TV に何を、F15 §1）。
 *   school_id は対象デバイスの school、actor は `actor_user_id`（users）+ `actor_identity_uid`（IdP uid）。
 *   row_hash は BEFORE INSERT トリガが計算（"" を上書き）。
 *
 * @param tx RLS context 下のトランザクション（Server Action の `withSession`）。school_admin は自校に、
 *           system_admin は全校に発行できる（後者は新規登録 = onboarding と同じ cross-tenant 経路）。
 */
export async function enqueueTvCommand(
  tx: TenantTx,
  params: EnqueueTvCommandParams,
): Promise<EnqueueTvCommandResult> {
  const { deviceRowId, command, actorUserId, actorIdentityUid } = params;

  // 1. device 解決（RLS スコープ）。ソフトデリート済（退役 TV）はコマンド発行不可。
  const devRows = await tx
    .select({ deviceId: tvDevices.deviceId, schoolId: tvDevices.schoolId })
    .from(tvDevices)
    .where(and(eq(tvDevices.id, deviceRowId), isNull(tvDevices.deletedAt)))
    .limit(1);
  const dev = devRows[0];
  if (!dev) {
    return { status: "device_not_found" };
  }

  // 2. pending を 1 件 INSERT（解決した device_id / school_id を明示）。issued_by / created_by / updated_by は
  //    users(id) FK のため system_admin（actorUserId=null）はシステム発行扱いで null（FK 違反回避）。
  const inserted = await tx
    .insert(tvDeviceCommands)
    .values({
      deviceId: dev.deviceId,
      schoolId: dev.schoolId,
      command,
      paramsJson: params.params ?? null,
      issuedBy: actorUserId,
      expiresAt: params.expiresAt ?? null,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    })
    .returning({ id: tvDeviceCommands.id });
  const id = inserted[0]?.id;
  if (id === undefined) {
    // INSERT ... RETURNING は必ず 1 行返すため通常起きない。防御的に loud fail させる。
    throw new Error("enqueueTvCommand: tv_device_commands INSERT が行を返しませんでした");
  }

  // 3. 監査（ルール1）: 発行を 1 件残す。school_id は解決した対象デバイスの school（cross-tenant な
  //    system_admin 発行でも対象校が正しく残る）。actor_user_id（users FK）は system_admin だと null、
  //    「誰が」は FK 無しの actor_identity_uid に IdP uid を残す（audit_log_insert policy: role=system_admin は
  //    actor=null / 任意 school を許可、migration 0005）。
  await tx.insert(auditLog).values({
    actorUserId,
    actorIdentityUid,
    schoolId: dev.schoolId,
    tableName: "tv_device_commands",
    recordId: id,
    operation: "insert",
    diff: { after: { device_id: dev.deviceId, command, params: params.params ?? null } },
    rowHash: "",
    createdBy: actorUserId,
    updatedBy: actorUserId,
  });

  return { status: "enqueued", id, deviceId: dev.deviceId };
}

/**
 * 配信（ポーリング）: device_id 宛の **配信可能な pending コマンド**を取得する。
 *
 * `pollTvConfig` と同じく `system_admin` role context（cross-tenant 可視）で解決する。`device_id` は
 * グローバル UNIQUE のため、コマンド行は当該 device の school にしか存在せず、テナント越境配信は構造的に
 * 防がれる（BYPASSRLS 不使用、ルール2）。配信対象は:
 *   - `status='pending'`（未配信）
 *   - 失効していない（`expires_at IS NULL` または `expires_at > now()`）
 * 古い順（issued_at 昇順）に最大 `limit` 件返す（発行順に実行させる）。**読み取りのみ**で副作用なし
 * （配信済への遷移は TV の ack 経由。ポーリング read で勝手に delivered にしない = 取りこぼし防止）。
 *
 * @param db       非 BYPASSRLS の Drizzle クライアント（本番 `getDb()`）。
 * @param deviceId 解決キー（グローバル一意）。
 * @param options  `appRole`: テスト superuser を `kimiterrace_app` へ降格させ RLS を効かせる用。
 *                 `limit`: 1 ポーリングで返す最大件数（既定 10）。
 */
export async function pollPendingTvCommands(
  db: KimiterraceDb,
  deviceId: string,
  options?: { appRole?: string; limit?: number },
): Promise<PendingTvCommand[]> {
  const limit = options?.limit ?? 10;
  return await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx): Promise<PendingTvCommand[]> => {
      const rows = await tx
        .select({
          id: tvDeviceCommands.id,
          command: tvDeviceCommands.command,
          paramsJson: tvDeviceCommands.paramsJson,
        })
        .from(tvDeviceCommands)
        .where(
          and(
            eq(tvDeviceCommands.deviceId, deviceId),
            eq(tvDeviceCommands.status, "pending"),
            or(isNull(tvDeviceCommands.expiresAt), sql`${tvDeviceCommands.expiresAt} > now()`),
          ),
        )
        .orderBy(asc(tvDeviceCommands.issuedAt), asc(tvDeviceCommands.id))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        command: r.command,
        params: (r.paramsJson as Record<string, unknown> | null) ?? null,
      }));
    },
    { appRole: options?.appRole },
  );
}

export type AckTvCommandResult =
  | { status: "acked" }
  | { status: "already_acked" }
  | { status: "not_found" };

/**
 * ack（ポーリング）: TV が実行したコマンドを **冪等** に `delivered` へ落とす。
 *
 * `pollTvConfig` と同じ `system_admin` role context で `(id, device_id)` を突き合わせて 1 行を解決する
 * （device_id 一致を必須にし、他デバイスの id を ack できないようにする多層防御）。遷移は
 * `pending → delivered` の 1 方向のみ:
 *   - 0 行更新 + 行は存在 → 既に delivered/expired 済（再送・タイミング競合）→ `already_acked`（冪等）。
 *   - 0 行 + 行も無い → `not_found`（不正な id / device 不一致）。
 *   - 1 行更新 → `acked`、`status='delivered'` + `acknowledged_at=now()`。
 *
 * **冪等性の核心**: WHERE に `status='pending'` を入れるため、同じ ack を 2 回送っても 2 回目は 0 行更新で
 * `already_acked` を返す。`acknowledged_at` も 1 回目だけセットされ二度と書き換わらない。
 *
 * @param db       非 BYPASSRLS の Drizzle クライアント（本番 `getDb()`）。
 * @param input    `commandId`（ack 対象）+ `deviceId`（一致必須）。
 * @param options  `appRole`: テスト superuser を `kimiterrace_app` へ降格させ RLS を効かせる用。
 */
export async function ackTvCommand(
  db: KimiterraceDb,
  input: { commandId: string; deviceId: string },
  options?: { appRole?: string },
): Promise<AckTvCommandResult> {
  return await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx): Promise<AckTvCommandResult> => {
      // pending のみ delivered へ（冪等の 1 方向遷移）。acknowledged_at / updated_at を明示
      // （[[updatedat-explicit-on-update]]: auditColumns.updated_at は $onUpdate もトリガも無い）。
      const updated = await tx
        .update(tvDeviceCommands)
        .set({
          status: "delivered",
          acknowledgedAt: sql`now()`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tvDeviceCommands.id, input.commandId),
            eq(tvDeviceCommands.deviceId, input.deviceId),
            eq(tvDeviceCommands.status, "pending"),
          ),
        )
        .returning({ id: tvDeviceCommands.id });
      if (updated.length > 0) {
        return { status: "acked" };
      }
      // 0 行: 既に delivered/expired か、id/device 不一致。行の存在で区別する（冪等 vs 不正）。
      const existing = await tx
        .select({ id: tvDeviceCommands.id })
        .from(tvDeviceCommands)
        .where(
          and(
            eq(tvDeviceCommands.id, input.commandId),
            eq(tvDeviceCommands.deviceId, input.deviceId),
          ),
        )
        .limit(1);
      return existing.length > 0 ? { status: "already_acked" } : { status: "not_found" };
    },
    { appRole: options?.appRole },
  );
}

/** 管理 UI の最近コマンド 1 行（発行履歴 + 状態表示用）。 */
export type TvCommandSummary = Pick<
  TvCommandRow,
  "id" | "command" | "status" | "issuedAt" | "acknowledgedAt"
>;

/**
 * 管理一覧: 指定デバイス（行 PK）の **最近のコマンド履歴**を新しい順に取得する（RLS で school スコープ）。
 * `/admin/tv-devices/:id` の状態表示用。可視範囲は RLS が決める（自校のみ / system_admin は全校）。
 * device_id で突き合わせるため、行 PK → device_id を同 RLS context で解決してから引く。
 *
 * 手書き WHERE school_id は書かず RLS に委譲（ルール2）。呼び出し側は非 BYPASSRLS 接続を使うこと。
 */
export async function listRecentTvCommands(
  db: Selectable,
  deviceRowId: string,
  limit = 20,
): Promise<TvCommandSummary[]> {
  // 行 PK → device_id（RLS スコープ。他校なら 0 行 → 空配列）。tv_devices.id は PK だが device_id 軸で
  // コマンドを引くため一度解決する。
  const devRows = await db
    .select({ deviceId: tvDevices.deviceId })
    .from(tvDevices)
    .where(eq(tvDevices.id, deviceRowId))
    .limit(1);
  const deviceId = devRows[0]?.deviceId;
  if (deviceId === undefined) {
    return [];
  }
  return db
    .select({
      id: tvDeviceCommands.id,
      command: tvDeviceCommands.command,
      status: tvDeviceCommands.status,
      issuedAt: tvDeviceCommands.issuedAt,
      acknowledgedAt: tvDeviceCommands.acknowledgedAt,
    })
    .from(tvDeviceCommands)
    .where(eq(tvDeviceCommands.deviceId, deviceId))
    .orderBy(desc(tvDeviceCommands.issuedAt), desc(tvDeviceCommands.id))
    .limit(limit);
}
