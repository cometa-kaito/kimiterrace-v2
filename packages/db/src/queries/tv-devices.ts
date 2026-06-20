import { type InferSelectModel, and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
 *  2. **管理一覧（認証セッション）**: `listTvDevices`。`/ops/tv-devices` の Server Component から
 *     `withSession` の RLS context 下で呼ぶ。可視範囲は RLS が決める（school_admin=自校 /
 *     system_admin=全校）。WHERE にテナント条件は書かない（schools.ts と同方針、ルール2）。
 *
 * 型は schema の `tvDevices` から `InferSelectModel` で派生する（ルール3、手書きドメイン型を作らない）。
 */

type TvDeviceRow = InferSelectModel<typeof tvDevices>;

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** UPDATE だけできれば良い（設定編集 Action は RLS context tx を渡す）。 */
type Updatable = Pick<PostgresJsDatabase, "update">;

/** INSERT だけできれば良い（新規登録 Action は RLS context tx を渡す）。 */
type Insertable = Pick<PostgresJsDatabase, "insert">;

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
  /**
   * 端末が報告する FCM 登録トークン（遠隔起動の宛先、F16 拡張）。lp-config ポーリングの `&fcmToken=`
   * クエリ由来。**指定（非 null）のときだけ** UPSERT し、`undefined`（未報告 = 旧 APK / クエリ無し）は
   * fcm_token を一切触らない（既存値を保持）。呼び出し側は空文字を正規化して `undefined` に倒すこと
   * （空トークンで既存を消さない・空送信無視の規律）。
   */
  fcmToken?: string | null;
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
 *  - `input.fcmToken` が指定（非 undefined）のときだけ `fcm_token` も同 UPDATE で UPSERT する（遠隔起動の
 *    宛先、F16 拡張）。`undefined`（lp-config に `&fcmToken=` が無い旧 APK 経路）は fcm_token を触らない。
 *    呼び出し側が空文字を `undefined` に正規化する前提で、空トークンによる既存値消去は起きない。
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
        .set({
          lastSeenAt: sql`now()`,
          lastKnownIp: input.lastKnownIp,
          // fcmToken は指定時のみ UPSERT。undefined は Drizzle が SET から除外する（既存値保持）。
          // 心拍 touch と同じく updated_at は進めない（last_seen_at が心拍の単一ソース、上記 doc 参照）。
          ...(input.fcmToken !== undefined ? { fcmToken: input.fcmToken } : {}),
        })
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
 * サイネージのモニタ起点表示（Phase5 v2-PR3）が読む、`device_id` → 表示文脈の **cross-tenant 解決**。
 *
 * `pollTvConfig`（ADR-022）と同じ二層 RLS パターン（`system_admin` role context・**BYPASSRLS 不使用**）で、
 * グローバル UNIQUE な `device_id` を 1 行に解決する。匿名のモニタ起点サイネージ（`classToken` を持たない
 * 廊下等の端末や、自端末への直指定広告を上乗せ表示する端末）が「自分が何校・どのクラス・どのモニタか」を
 * 引くための入口。**read 専用**で心拍（last_seen_at）は更新しない（pollTvConfig が心拍の単一ソース）。
 * ソフトデリート済（`deleted_at`）は解決しない（退役端末は表示も無効＝null）。
 *
 * 呼び出し側はこの戻り値の `schoolId` だけで改めて `withTenantContext({ schoolId })` を開き、表示データを
 * 自校 RLS 下で組む（本関数の system_admin 文脈を表示の読取まで持ち越さない）。
 *
 * @param db       非 BYPASSRLS の Drizzle クライアント（本番 `getDb()`）。
 * @param deviceId TV が報告する device_id（グローバル一意で 1 行に解決）。
 * @param options  `appRole`: テスト superuser 接続を `kimiterrace_app` へ降格させ RLS を効かせる用。
 * @returns        解決できた端末の `{ monitorId(=id), schoolId, classId(null 可), label }`。未登録/退役は null。
 */
export type SignageMonitorRef = {
  monitorId: string;
  schoolId: string;
  classId: string | null;
  label: string | null;
};

export async function resolveTvDeviceByDeviceId(
  db: KimiterraceDb,
  deviceId: string,
  options?: { appRole?: string },
): Promise<SignageMonitorRef | null> {
  return await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx): Promise<SignageMonitorRef | null> => {
      const rows = await tx
        .select({
          id: tvDevices.id,
          schoolId: tvDevices.schoolId,
          classId: tvDevices.classId,
          label: tvDevices.label,
        })
        .from(tvDevices)
        .where(and(eq(tvDevices.deviceId, deviceId), isNull(tvDevices.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        monitorId: row.id,
        schoolId: row.schoolId,
        classId: row.classId,
        label: row.label,
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

/**
 * 編集画面が読み込む単一デバイスの **編集対象設定 + 現在の version**（F15 §4.2）。設定変更ではなく
 * 表示用の読み取りなので監査列・心拍列（last_seen_at 等）・device_id（識別子は編集不可）は最小限に絞る。
 * `version` はフォームには出さないが、編集前後の差分表示や楽観表示に使えるよう返す。
 */
export type TvDeviceEditable = Pick<
  TvDeviceRow,
  | "id"
  | "deviceId"
  | "label"
  | "targetMac"
  | "signageUrl"
  | "webhookUrl"
  | "scheduleJson"
  | "monitoringEnabled"
  | "notes"
  | "version"
>;

/**
 * 編集画面の読み込み: 1 デバイスの編集可能な設定を `id` で取得する。可視範囲は RLS が決める
 * （他校 / ソフトデリート済は不可視 → undefined → 呼び出し側で `notFound()`）。
 *
 * `WHERE deleted_at IS NULL` は対象絞り込み（退役 TV は編集させない）であってテナント境界ではない。
 * 越境は RLS（tenant_isolation）が弾く（schools.ts と同方針、ルール2）。手書きの `WHERE school_id` は
 * 書かない。呼び出し側は非 BYPASSRLS 接続（kimiterrace_app）を使うこと。
 */
export async function getTvDeviceConfig(
  db: Selectable,
  id: string,
): Promise<TvDeviceEditable | undefined> {
  const rows = await db
    .select({
      id: tvDevices.id,
      deviceId: tvDevices.deviceId,
      label: tvDevices.label,
      targetMac: tvDevices.targetMac,
      signageUrl: tvDevices.signageUrl,
      webhookUrl: tvDevices.webhookUrl,
      scheduleJson: tvDevices.scheduleJson,
      monitoringEnabled: tvDevices.monitoringEnabled,
      notes: tvDevices.notes,
      version: tvDevices.version,
    })
    .from(tvDevices)
    .where(and(eq(tvDevices.id, id), isNull(tvDevices.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * クラスエディタの「このクラスのサイネージを開く」導線が読む、当該クラスに紐づく TV デバイスの
 * **公開サイネージ URL**（`tv_devices.signage_url` = `/signage/{token}` の絶対 URL）。教員が編集中の
 * クラスが実機 TV で実際にどう映るかを、公開ページ（旧「全画面プレビュー」の代替）で確認する read 専用導線。
 *
 * - **選定**: 1 クラスに複数 TV があっても表示内容は同一（同一クラスのサイネージ）なので、`signage_url` が
 *   設定済み（非 null）で未削除のデバイスのうち**最も新しく更新された 1 件**を決定的に返す。設置 TV が無い
 *   クラスは `undefined`（呼び出し側はリンク自体を出さない＝死リンク防止）。
 * - **RLS 委譲（ルール2）**: 手書きの `WHERE school_id` は書かない。可視範囲は `tenant_isolation`
 *   （teacher / school_admin = 自校）/ `system_admin_full_access` が決める。非 BYPASSRLS 接続で呼ぶこと。
 * - **token は read 専用の表示 URL**: `signage_url` は magic link の hash で保護される匿名 read トークンを
 *   含む（provisioning-actions の設計）。自校クラスの公開 URL を当該校の教員に見せるのは想定内。
 */
export async function getClassSignageUrl(
  db: Selectable,
  classId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ signageUrl: tvDevices.signageUrl })
    .from(tvDevices)
    .where(
      and(
        eq(tvDevices.classId, classId),
        isNull(tvDevices.deletedAt),
        isNotNull(tvDevices.signageUrl),
      ),
    )
    .orderBy(desc(tvDevices.updatedAt))
    .limit(1);
  return rows[0]?.signageUrl ?? undefined;
}

/**
 * エディタ着地「実画面モニタの壁」が **自校の全クラス分**まとめて読む、各クラスの代表 **公開サイネージ URL**。
 * `getClassSignageUrl` の単一クラス版を **N+1 を避けて 1 クエリにバッチ**したもので、壁の 2 つの判断を 1 ソースで
 * 駆動する: (1) **学科に実機モニタが紐づくか**（返却 Map にそのクラスが含まれるか＝`signage_url` を持つ未削除 TV
 * が当該クラスに在るか）／(2) **端末別デザインパターン**（URL の `?design=patternN` を `getDesignPatternFromUrl`
 * で抽出。未指定は学校レベル既定→`pattern1` に倒す。design-pattern.ts 参照）。
 *
 * - **選定**: `getClassSignageUrl` と同規約で、`signage_url` 非 null・未削除のうち**最も新しく更新された 1 件**を
 *   各クラスの代表とする（複数 TV があっても表示内容は同一なので決定的に 1 件）。`signage_url` が null の
 *   デバイス / ソフトデリート済デバイスは対象外（モニタ未紐づけ扱い）。
 * - **RLS 委譲（ルール2）**: 手書きの `WHERE school_id` は書かない。可視範囲は `tenant_isolation`
 *   （teacher / school_admin = 自校）が決める。非 BYPASSRLS 接続（kimiterrace_app）で RLS context 下で呼ぶこと。
 * - 返り値は `Map<classId, signageUrl>`。設置 TV が無いクラスは**キーに現れない**（呼び出し側は「モニタ無し」と
 *   判定できる）。
 */
export async function getClassSignageUrls(db: Selectable): Promise<Map<string, string>> {
  // updated_at 降順で全件読み、各 class の最初（=最新）の 1 件を代表に採る（getClassSignageUrl と同選定規約）。
  const rows = await db
    .select({ classId: tvDevices.classId, signageUrl: tvDevices.signageUrl })
    .from(tvDevices)
    .where(
      and(
        isNotNull(tvDevices.classId),
        isNull(tvDevices.deletedAt),
        isNotNull(tvDevices.signageUrl),
      ),
    )
    .orderBy(desc(tvDevices.updatedAt));
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.classId && r.signageUrl && !out.has(r.classId)) {
      out.set(r.classId, r.signageUrl);
    }
  }
  return out;
}

/**
 * 遠隔起動（「起こす」）が読む 1 デバイスの **送信宛先トークン**（F16 拡張）。`id`（行 PK）で取得する。
 * 可視範囲は RLS が決める（school_admin = 自校 / system_admin = 全校）。他校 / ソフトデリート済 / 不可視は
 * `undefined`（→ 呼び出し側 Action が not_found に写像）。手書きの `WHERE school_id` は書かない（ルール2、
 * getTvDeviceConfig と同方針）。呼び出し側は非 BYPASSRLS 接続（kimiterrace_app）を RLS context 下で使うこと。
 *
 * `fcm_token` は端末が報告した最新トークン。NULL = 未報告（旧 APK / 報告前）で送信対象外（呼び出し側で判定）。
 */
export type TvDeviceWakeTarget = Pick<TvDeviceRow, "id" | "fcmToken">;

export async function getTvDeviceFcmToken(
  db: Selectable,
  id: string,
): Promise<TvDeviceWakeTarget | undefined> {
  const rows = await db
    .select({ id: tvDevices.id, fcmToken: tvDevices.fcmToken })
    .from(tvDevices)
    .where(and(eq(tvDevices.id, id), isNull(tvDevices.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * 設定編集が書き込める **オペレーター編集可能フィールド**（F15 §4.2）の正規化済みパッチ。
 *
 * ここに無いフィールドは **システム管理列**で編集経路から書けない（型レベルで遮断）:
 *  - `device_id`（TV 生成の不変識別子、ポーリング解決キー） / `school_id`（テナント、移動不可）
 *  - `version`（本関数が +1 する。手で渡させない） / `last_seen_at` / `last_known_ip` /
 *    `last_boot_at` / `app_version`（TV 由来の心拍・起動報告） / `alert_state`（定期チェッカが遷移）
 *  - `deleted_at`（ソフトデリートは別 Action） / 監査列（created_by / updated_* は本関数が設定）
 *  - 教室コンテキスト FK（grade/department/class は signage_url から自動抽出する別経路）
 *
 * `null` を渡したフィールドはクリア（未設定化）を意味する。`undefined` は「変更しない」（部分更新）。
 */
export type TvDeviceConfigPatch = {
  label?: string | null;
  targetMac?: string | null;
  signageUrl?: string | null;
  webhookUrl?: string | null;
  scheduleJson?: TvSchedule | null;
  monitoringEnabled?: boolean;
  notes?: string | null;
};

/**
 * 設定編集: オペレーター編集可能フィールドを **`version` を +1 しつつ** 更新する（F15 §4.2 / ADR-022）。
 *
 * - **version バンプ（ADR-022 の中核）**: TV は 60 秒ごとにポーリングし、応答の `version` を local の
 *   `last_seen_version` と比較して **版が上がった時のみ** 設定を反映する。設定を書き換えても version を
 *   上げなければ TV は変更を検知できない。よって同一 UPDATE 内で `version = version + 1`（DB 側で原子的に
 *   monotonic 加算、並行更新でも飛ばない）を必ず行う。
 * - **監査（ルール1）**: `auditColumns.updatedAt` には `$onUpdate` もトリガも無いため、UPDATE で
 *   `updatedAt: new Date()` を**明示**しないと作成時刻のまま残り監査不整合になる
 *   ([[updatedat-explicit-on-update]] の既知トラップ)。`updatedBy` も actor を明示設定する。設定変更の
 *   `audit_log` 追記は呼び出し側 Action が同一 tx で行う（F15 §1、心拍 touch とは別経路）。
 * - **RLS 委譲（ルール2）**: 手書きの `WHERE school_id` は書かない。可視範囲は RLS が決める:
 *   `tenant_isolation`（school_admin = 自校のみ）/ `system_admin_full_access`（system_admin = 全校、
 *   cross-tenant 運用者）。他校 / 不可視デバイスへの UPDATE は **0 行**になる（→ undefined → 呼び出し側で
 *   not_found）。ソフトデリート済（`deleted_at IS NOT NULL`）も対象外（退役 TV は編集不可）。
 *
 * @param db        非 BYPASSRLS の Drizzle クライアント / tx（RLS context 下で呼ぶこと）。
 * @param params    対象 `id` / 編集パッチ / 監査 actor（`updatedBy`、**system_admin は null**＝users 行でない
 *                  ため FK 違反回避、createTvDevice と同パターン）。
 * @returns         更新後の `{ id, version, schoolId }`（version は +1 後、schoolId は監査の対象 school 記録
 *                  用に返す）。0 行（不可視 / 退役）なら `undefined`。
 */
export type UpdateTvDeviceConfigParams = {
  id: string;
  patch: TvDeviceConfigPatch;
  /** 監査 actor（`updated_by` = users.id FK）。system_admin は `users` 行でないため **null**。 */
  actorUserId: string | null;
};

type TvDeviceUpdatedRef = Pick<TvDeviceRow, "id" | "version" | "schoolId">;

export async function updateTvDeviceConfig(
  db: Updatable,
  params: UpdateTvDeviceConfigParams,
): Promise<TvDeviceUpdatedRef | undefined> {
  const { id, patch, actorUserId } = params;
  // 編集パッチ（undefined キーは Drizzle が SET から除外＝部分更新）に version バンプ + 監査列を重ねる。
  // version は DB 側で原子的に +1（並行編集でも monotonic、競合で飛ばない）。
  const rows = await db
    .update(tvDevices)
    .set({
      ...patch,
      version: sql`${tvDevices.version} + 1`,
      // 設定変更なので updated_at を明示的に進める（ルール1 / [[updatedat-explicit-on-update]]）。
      updatedAt: new Date(),
      updatedBy: actorUserId,
    })
    .where(and(eq(tvDevices.id, id), isNull(tvDevices.deletedAt)))
    .returning({ id: tvDevices.id, version: tvDevices.version, schoolId: tvDevices.schoolId });
  return rows[0];
}

/**
 * ソフトデリート（退役、F15 §4.2）: 指定 TV デバイスの `deleted_at` を now() に設定し、以後 read 経路
 * （`listTvDevices` / `getTvDeviceConfig` / `pollTvConfig` 等、いずれも `deleted_at IS NULL` で絞る）から
 * 不可視にする。物理行は残す（過去の死活/設定履歴・子参照 FK = tv_device_commands / tv_device_downtime の
 * 保全）。`device_id` はグローバル UNIQUE（`tv_device_commands` / `tv_device_downtime` の `device_id` FK の
 * 参照先・FK は非部分 UNIQUE を要求）のままなので、ソフト削除後も device_id は解放されず **同一 device_id での
 * 再登録は不可**（撤去端末は別 device_id で再プロビジョニングする運用で対応する）。
 *
 * - **冪等**: `WHERE deleted_at IS NULL` のため、既に削除済み / 不可視 / 他校 / 不在は 0 行 →
 *   `undefined`（呼び出し側で not_found 写像）。二重削除で `deleted_at` を上書きしない。
 * - **version は触らない**: 削除済みは `pollTvConfig` が解決せず unknown 応答を返すため、版差分での
 *   設定反映（ADR-022）は不要（端末は「未登録扱い」になり設定配信も死活計上もされない）。
 * - **RLS 委譲（ルール2）**: 手書きの `WHERE school_id` は書かない。可視範囲は RLS が決める
 *   （school_admin = 自校 `tenant_isolation` / system_admin = 全校 `system_admin_full_access`）。他校 /
 *   不可視への UPDATE は 0 行になる。非 BYPASSRLS 接続（kimiterrace_app）を RLS context 下で使うこと。
 * - **監査（ルール1）**: `updated_at` を明示的に進める（[[updatedat-explicit-on-update]]）。削除の
 *   `audit_log` 追記（operation=delete）は呼び出し側 Action が同一 tx で行う。
 *
 * @returns 削除した行の `{ id, schoolId, deviceId, label }`（schoolId は監査の対象 school 記録用、
 *          deviceId / label は監査 diff の before-snapshot 用）。0 行なら `undefined`。
 */
export type SoftDeleteTvDeviceParams = {
  id: string;
  /** 監査 actor（`updated_by` = users.id FK）。system_admin は `users` 行でないため **null**。 */
  actorUserId: string | null;
};

type TvDeviceDeletedRef = Pick<TvDeviceRow, "id" | "schoolId" | "deviceId" | "label">;

export async function softDeleteTvDevice(
  db: Updatable,
  params: SoftDeleteTvDeviceParams,
): Promise<TvDeviceDeletedRef | undefined> {
  const { id, actorUserId } = params;
  // deleted_at と updated_at に同一時刻を打つ（監査の整合）。updated_by に actor を明示。
  const now = new Date();
  const rows = await db
    .update(tvDevices)
    .set({ deletedAt: now, updatedAt: now, updatedBy: actorUserId })
    .where(and(eq(tvDevices.id, id), isNull(tvDevices.deletedAt)))
    .returning({
      id: tvDevices.id,
      schoolId: tvDevices.schoolId,
      deviceId: tvDevices.deviceId,
      label: tvDevices.label,
    });
  return rows[0];
}

/**
 * 新規登録（オンボーディング、F15 §4.3）が INSERT する 1 デバイス分の正規化済み入力。
 *
 * `deviceId` / `schoolId` は **必須**（システム管理列だが登録時のみオペレーターが決める）。`deviceId` は
 * TV が初回起動時に生成した値をオペレーターが転記する（未登録ポーリング検出からの登録）か、事前採番として
 * Action が UUIDv4 を生成して渡す（F15 §4.3「手動入力 or 自動生成」）。グローバル UNIQUE 制約
 * （ux_tv_devices_device_id）が二重登録を DB レベルで弾く（ポーリング解決の一意性、schema 参照）。
 *
 * `version` は schema 既定の 1 から始める（明示しない）。TV は初回ポーリングで version=1 の設定を取り込む。
 * `lastSeenAt` / `alertState` 等の TV 由来・チェッカ由来の列は登録時に触らない（schema 既定）。
 *
 * 監査 actor: `createdBy` / `updatedBy` は **users(id) FK**。新規登録は F15 §4.3 で **system_admin 限定**
 * だが、system_admin は `users` 行でなく `system_admins` 行（`uid = system_admins.id`）なので、ここに
 * system_admin の uid を入れると FK 違反になる。よって呼び出し側は **null**（システム作成、auditColumns の
 * 規約どおり）を渡し、「誰が」は同一 tx で `audit_log`（actorIdentityUid に system_admin uid）に残す
 * （setStaffActiveAction と同じ cross-tenant 監査パターン）。
 */
export type TvDeviceCreateInput = {
  deviceId: string;
  schoolId: string;
  label: string | null;
  targetMac: string | null;
  signageUrl: string | null;
  webhookUrl: string | null;
  scheduleJson: TvSchedule | null;
  monitoringEnabled: boolean;
  notes: string | null;
  /** 監査 actor（users.id）。system_admin 起点は null（上記参照）。 */
  createdBy: string | null;
};

type TvDeviceCreatedRef = Pick<TvDeviceRow, "id" | "deviceId">;

/**
 * 新規登録: TV デバイスを 1 行 INSERT する（F15 §4.3）。
 *
 * **RLS 委譲（ルール2）**: 手書きの `WHERE`/分岐で school を絞らない。INSERT の WITH CHECK を
 * `tv_devices` の RLS（tenant_isolation: school_id 一致 / system_admin_full_access: role=system_admin）が
 * 評価する。登録は system_admin 起点（role=system_admin context）なので **full_access policy** が任意校への
 * INSERT を許可する。万一テナント context（school_admin）で別校 school_id を渡すと WITH CHECK 違反（RLS
 * エラー）になり cross-tenant 登録は構造的に防がれる。
 *
 * **一意性**: `device_id` のグローバル UNIQUE 違反は SQLSTATE 23505、不在 school_id は FK 違反 23503 として
 * throw する（呼び出し側 Action が conflict / invalid に写像）。
 *
 * @param db     非 BYPASSRLS の Drizzle クライアント / tx（RLS context 下で呼ぶこと）。
 * @param input  正規化済みの登録入力。
 * @returns      作成行の `{ id, deviceId }`（id は行 PK、以降の編集・履歴リンクに使う）。
 */
export async function createTvDevice(
  db: Insertable,
  input: TvDeviceCreateInput,
): Promise<TvDeviceCreatedRef> {
  const rows = await db
    .insert(tvDevices)
    .values({
      deviceId: input.deviceId,
      schoolId: input.schoolId,
      label: input.label,
      targetMac: input.targetMac,
      signageUrl: input.signageUrl,
      webhookUrl: input.webhookUrl,
      scheduleJson: input.scheduleJson,
      monitoringEnabled: input.monitoringEnabled,
      notes: input.notes,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning({ id: tvDevices.id, deviceId: tvDevices.deviceId });
  // INSERT は成功なら必ず 1 行 RETURNING する（RLS WITH CHECK 違反・制約違反は throw）。0 行は到達しない
  // が、型安全のため防御的に扱う。
  const row = rows[0];
  if (!row) {
    throw new Error("createTvDevice: INSERT が行を返しませんでした");
  }
  return row;
}
