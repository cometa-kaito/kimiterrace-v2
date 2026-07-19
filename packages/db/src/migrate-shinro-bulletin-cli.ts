import { writeFileSync } from "node:fs";
import postgres from "postgres";
import {
  SHINRO_EXPECTED_CLASS_ID,
  calloutHint,
  effectiveDesignPattern,
  extractSignageToken,
  mergePinnedNotices,
  planBulletinMigration,
} from "./migrate-shinro-bulletin.js";
import { hashToken } from "./seed-ginan-signage.js";

/**
 * PR-E（設計書 `docs/design/editor-restructure-bulletin-2026-07.md` §8）: 岐阜工業「進路指導室前」モニタを
 * 掲示板型 pattern5 へ移行する **一括データ変換の実行 CLI**。純ロジック（分類・変換・計画）は
 * {@link ./migrate-shinro-bulletin.ts}。本 CLI は DB 接続・RLS context・dry-run/apply・バックアップ出力のみ担う
 * （他 seed-ginan-*-cli と同じ生 SQL 方式・schema barrel 非 import・JSONB は `${JSON.stringify}::jsonb`）。
 *
 * ## プリフライト＝dry-run 自体（設計 §8.2 手順1・shipping 設計書 §3.3 の不整合解消）
 * 設計書は対象を class `7a18ca87…`・pattern3 とするが、tv-ble-bridge の APK-MANIFEST.md:107 は「進路指導室前」
 * 物理端末の signage_url トークンが **テスト校 1年1組・pattern2** を解決すると注記し**食い違う**。どちらが stale か
 * コードから決められないため、本 CLI は **端末を起点に**（signage_url トークン→magic_link→クラス）実機が今
 * 実際に表示しているクラスを解決し、それを変換対象にする。dry-run 出力の解決チェーンがプリフライトの答え。
 * `--expect-class`（既定=設計書の 7a18ca87）と食い違えば apply は fail-closed で拒否（`--allow-class-mismatch` で上書き）。
 *
 * ## 実行方法（prod は Cloud Run Job の command 上書きで migrate と同一イメージから。他 seed-ginan-*-cli と同型）
 * - dry-run（既定・書込なし・プリフライト）:
 *     `DATABASE_URL=postgres://... node dist/migrate-shinro-bulletin-cli.js --device-label 進路指導室前`
 * - apply（**本番適用は人間専任＝設計書 §4-G2 / CLAUDE.md migration 規律**。Claude は実行しない）:
 *     `... node dist/migrate-shinro-bulletin-cli.js --device-label 進路指導室前 \
 *        --pin-callout-ids <uuid,uuid> --backup-file ./shinro-backup.json --apply`
 *
 * ## 秘匿（ルール5）/ PII（ルール4）
 * signage_url・トークン・DATABASE_URL・callout の生テキストは **stdout に出さない**。stdout は識別子・件数・
 * 分類ヒント（長さのみ）だけ。削除する callout の全文は **バックアップファイル**（運用者ディスク）にのみ書く
 * （実名を含みうる＝保持ポリシーに従い取り扱う）。書込の created_by/updated_by は null（システム作成規約・ルール1）。
 * エラーは `err.message` のみ出す（porsager の `.query`/`.parameters`（校訓本文・UUID を含みうる）はダンプしない）。
 *
 * ## 監査（ルール1）— 一回性 CLI のため app 層 audit_log は書かない
 * seed-ginan-*-cli と同じくシステム bootstrap 扱いで `audit_log` 行は挿入しない（`audit_log` は hash-chain +
 * append-only トリガ保護で、一回性 CLI からの部分書込は連鎖を壊すリスクがある）。**この migration の監査証跡は
 * (1) `--backup-file`（削除した callout の全文＋アンカー日の変更前 notices）と (2) stdout の
 * `migrate.shinro.bulletin.applied` 決定論レコード（対象 class・件数・削除 callout ID・backupFile パス）**で構成する。
 * 人間ゲート（§4-G2）で実行者が確定するため、正式な `audit_log` 行が必要なら follow-up で足す。
 */

type Args = {
  apply: boolean;
  deviceId?: string;
  deviceLabel?: string;
  signageToken?: string;
  classId?: string;
  expectClass: string;
  allowClassMismatch: boolean;
  pinCalloutIds: string[];
  anchorDate?: string;
  backupFile: string;
};

/** JST の今日（YYYY-MM-DD）。アンカー日 fallback / バックアップ命名に使う。 */
function jstToday(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const pinRaw = get("--pin-callout-ids") ?? "";
  return {
    apply: has("--apply"),
    deviceId: get("--device-id"),
    deviceLabel: get("--device-label"),
    signageToken: get("--signage-token"),
    classId: get("--class-id"),
    expectClass: get("--expect-class") ?? SHINRO_EXPECTED_CLASS_ID,
    allowClassMismatch: has("--allow-class-mismatch"),
    pinCalloutIds: pinRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    anchorDate: get("--anchor-date"),
    backupFile: get("--backup-file") ?? `./shinro-bulletin-backup-${jstToday()}.json`,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let exitCode = 0;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で全テーブルの system_admin_full_access を通す（tenant_isolation と OR 合成）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // ---- 対象解決（端末起点＝プリフライト）----
      let schoolId: string | undefined;
      let resolvedClassId: string | null = null;
      let device:
        | {
            deviceId: string;
            label: string | null;
            currentPattern: string;
            tokenClassId: string | null;
            columnClassId: string | null;
          }
        | undefined;

      if (args.classId) {
        // クラス直接指定（端末解決を飛ばす）。学校は classes から解決。
        const rows = await tx<{ schoolId: string }[]>`
          SELECT school_id AS "schoolId" FROM classes WHERE id = ${args.classId} LIMIT 1`;
        if (!rows[0]) {
          throw new Error(`class not found: ${args.classId}`);
        }
        schoolId = rows[0].schoolId;
        resolvedClassId = args.classId;
      } else if (args.signageToken) {
        // トークン直指定 → magic_link から school/class を解決。
        const ml = await tx<{ schoolId: string; classId: string | null }[]>`
          SELECT school_id AS "schoolId", class_id AS "classId" FROM magic_links
          WHERE token_hash = ${hashToken(args.signageToken)}
            AND class_id IS NOT NULL AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at DESC LIMIT 1`;
        if (!ml[0]?.classId) {
          throw new Error("トークンが有効な class magic_link を解決しません（失効/取消/不正）");
        }
        schoolId = ml[0].schoolId;
        resolvedClassId = ml[0].classId;
      } else if (args.deviceId || args.deviceLabel) {
        // 端末を device_id / label で一意解決（class_id 列も取得＝トークン解決不能時の fallback）。
        type DevRow = {
          id: string;
          deviceId: string;
          schoolId: string;
          label: string | null;
          signageUrl: string | null;
          columnClassId: string | null;
        };
        const devRows = args.deviceId
          ? await tx<DevRow[]>`
              SELECT id, device_id AS "deviceId", school_id AS "schoolId", label,
                     signage_url AS "signageUrl", class_id AS "columnClassId"
              FROM tv_devices WHERE device_id = ${args.deviceId} AND deleted_at IS NULL`
          : await tx<DevRow[]>`
              SELECT id, device_id AS "deviceId", school_id AS "schoolId", label,
                     signage_url AS "signageUrl", class_id AS "columnClassId"
              FROM tv_devices WHERE label LIKE ${`%${args.deviceLabel}%`} AND deleted_at IS NULL`;
        if (devRows.length === 0) {
          throw new Error("該当する live な tv_devices が見つかりません（label/id を確認）");
        }
        if (devRows.length > 1) {
          throw new Error(
            `端末が一意に定まりません（${devRows.length} 件）。--device-id で特定してください`,
          );
        }
        const dev = devRows[0];
        if (!dev) {
          throw new Error("端末解決に失敗しました");
        }
        schoolId = dev.schoolId;
        // signage_url トークン → magic_link → 表示クラス（権威。tv_devices.class_id 列は手貼り端末で NULL）。
        const token = extractSignageToken(dev.signageUrl);
        let tokenClassId: string | null = null;
        if (token) {
          const ml = await tx<{ classId: string | null }[]>`
            SELECT class_id AS "classId" FROM magic_links
            WHERE token_hash = ${hashToken(token)}
              AND class_id IS NOT NULL AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > now())
            ORDER BY created_at DESC LIMIT 1`;
          tokenClassId = ml[0]?.classId ?? null;
        }
        const columnClassId = dev.columnClassId ?? null;
        resolvedClassId = tokenClassId ?? columnClassId;
        device = {
          deviceId: dev.deviceId,
          label: dev.label,
          currentPattern: effectiveDesignPattern(dev.signageUrl),
          tokenClassId,
          columnClassId,
        };
      } else {
        throw new Error(
          "対象未指定: --device-label / --device-id / --signage-token / --class-id のいずれかを渡してください",
        );
      }

      if (!schoolId) {
        throw new Error("学校を解決できません");
      }
      await tx`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      if (!resolvedClassId) {
        throw new Error(
          "表示クラスを解決できません（端末に有効な class トークンも class_id 列も無い）。--class-id で明示を",
        );
      }

      const nameRows = await tx<{ id: string; name: string }[]>`
        SELECT id, name FROM classes WHERE id IN ${tx([resolvedClassId, args.expectClass])}`;
      const resolvedName = nameRows.find((r) => r.id === resolvedClassId)?.name ?? null;
      const expectName = nameRows.find((r) => r.id === args.expectClass)?.name ?? null;
      const classMatchesExpect = resolvedClassId === args.expectClass;

      // ---- 対象クラスの scan ----
      const dailyRows = await tx<{ rowId: string; date: string; schedules: unknown }[]>`
        SELECT id AS "rowId", date::text AS "date", schedules
        FROM daily_data
        WHERE scope = 'class' AND class_id = ${resolvedClassId}
        ORDER BY date ASC`;
      const callouts = await tx<
        { id: string; calloutDate: string; studentName: string; sortOrder: number }[]
      >`
        SELECT id, callout_date::text AS "calloutDate", student_name AS "studentName", sort_order AS "sortOrder"
        FROM student_callouts
        WHERE class_id = ${resolvedClassId}
        ORDER BY sort_order ASC, callout_date ASC`;

      const plan = planBulletinMigration({
        dailyRows,
        callouts,
        selectedBodyIds: args.pinCalloutIds,
        anchorDateOverride: args.anchorDate,
        anchorDateFallback: jstToday(),
      });

      // ---- 解決チェーン + 計画（PII/トークン非出力）----
      const warnings: string[] = [];
      if (!classMatchesExpect) {
        warnings.push(
          `DISCREPANCY: 実機が解決するクラス(${resolvedClassId}) != --expect-class(${args.expectClass})。` +
            "設計書 §8 の 7a18ca87 と APK-MANIFEST の 1年1組 のどちらが正かを、この解決結果で確定すること。",
        );
      }
      if (device?.currentPattern === "pattern5") {
        warnings.push("端末は既に pattern5（切替済み or 二重実行の可能性）");
      }
      if (plan.totalScheduleDividers === 0 && plan.deleteCalloutIds.length === 0) {
        warnings.push(
          "変換対象ゼロ（ハックデータ無し）。対象クラス取り違えの可能性—解決チェーンを確認",
        );
      }
      if (plan.unclassifiedCalloutIds.length > 0) {
        warnings.push(
          `未分類 callout ${plan.unclassifiedCalloutIds.length} 件（校訓本文なら --pin-callout-ids に ID 追加。氏名なら残置で正）`,
        );
      }

      console.log(
        JSON.stringify(
          {
            event: "migrate.shinro.bulletin.plan",
            mode: args.apply ? "apply" : "dry-run",
            resolution: {
              via: device
                ? "device→token→magic_link"
                : args.classId
                  ? "--class-id"
                  : "--signage-token",
              device: device
                ? {
                    deviceId: device.deviceId,
                    label: device.label,
                    currentPattern: device.currentPattern,
                    tokenResolvesClassId: device.tokenClassId,
                    columnClassId: device.columnClassId,
                  }
                : null,
              resolvedClassId,
              resolvedClassName: resolvedName,
              expectClassId: args.expectClass,
              expectClassName: expectName,
              classMatchesExpect,
              schoolId,
            },
            plan: {
              scheduleDatesWithDashRows: plan.scheduleConversions.map((c) => ({
                date: c.date,
                dashRowsToDivider: c.convertedCount,
              })),
              totalScheduleDividers: plan.totalScheduleDividers,
              anchorDate: plan.anchorDate,
              pinnedNoticesToAdd: plan.pinnedNotices.length,
              calloutClassification: callouts.map((c) => ({
                id: c.id,
                date: c.calloutDate,
                hint: calloutHint(c.studentName, args.pinCalloutIds.includes(c.id)),
              })),
              dividerCalloutIds: plan.dividerCalloutIds,
              bodyCalloutIds: plan.bodyCalloutIds,
              deleteCalloutIds: plan.deleteCalloutIds,
              unclassifiedCalloutIds: plan.unclassifiedCalloutIds,
            },
            warnings,
          },
          null,
          2,
        ),
      );

      if (!args.apply) {
        console.log(
          "\n[dry-run] 書込なし。内容を確認し、校訓本文の ID を --pin-callout-ids に指定のうえ人間が --apply を実行してください（設計書 §4-G2）。",
        );
        return;
      }

      // ---- apply（人間専任）----
      if (!classMatchesExpect && !args.allowClassMismatch) {
        throw new Error(
          "apply 中止: 解決クラスが --expect-class と不一致。意図的なら --allow-class-mismatch を付けて再実行",
        );
      }

      // 削除する callout の全文をバックアップ（ロールバック用・実名含みうる＝ファイルのみ）。
      const backupCallouts =
        plan.deleteCalloutIds.length > 0
          ? await tx`SELECT * FROM student_callouts WHERE id IN ${tx(plan.deleteCalloutIds)}`
          : [];
      let anchorNoticesBefore: unknown = null;
      if (plan.anchorDate) {
        const before = await tx<{ notices: unknown }[]>`
          SELECT notices FROM daily_data
          WHERE scope = 'class' AND class_id = ${resolvedClassId} AND date = ${plan.anchorDate} LIMIT 1`;
        anchorNoticesBefore = before[0]?.notices ?? null;
      }
      writeFileSync(
        args.backupFile,
        JSON.stringify(
          {
            meta: {
              generatedAtJst: jstToday(),
              schoolId,
              classId: resolvedClassId,
              anchorDate: plan.anchorDate,
              note: "ロールバック用。callout 全文（実名含みうる）を含むため保持ポリシーに従い取り扱うこと。",
            },
            deletedCallouts: backupCallouts,
            anchorNoticesBefore,
          },
          null,
          2,
        ),
        "utf8",
      );

      // 1) 予定のダッシュ行 → 区切り線（既存行の schedules 列のみ置換）。
      for (const c of plan.scheduleConversions) {
        await tx`
          UPDATE daily_data
          SET schedules = ${JSON.stringify(c.next)}::jsonb, updated_at = now(), updated_by = NULL
          WHERE id = ${c.rowId}`;
      }

      // 2) 校訓 → 固定お知らせ（アンカー日の notices に追記。無ければ INSERT）。
      let noticesAdded = 0;
      if (plan.anchorDate && plan.pinnedNotices.length > 0) {
        const existing = await tx<{ id: string; notices: unknown }[]>`
          SELECT id, notices FROM daily_data
          WHERE scope = 'class' AND class_id = ${resolvedClassId} AND date = ${plan.anchorDate} LIMIT 1`;
        const merged = mergePinnedNotices(existing[0]?.notices ?? [], plan.pinnedNotices);
        noticesAdded = merged.addedCount;
        if (existing[0]) {
          await tx`
            UPDATE daily_data
            SET notices = ${JSON.stringify(merged.next)}::jsonb, updated_at = now(), updated_by = NULL
            WHERE id = ${existing[0].id}`;
        } else {
          await tx`
            INSERT INTO daily_data
              (school_id, scope, class_id, date, schedules, notices, assignments, quiet_hours, created_by, updated_by)
            VALUES
              (${schoolId}, 'class', ${resolvedClassId}, ${plan.anchorDate},
               '[]'::jsonb, ${JSON.stringify(merged.next)}::jsonb, '[]'::jsonb, '[]'::jsonb, NULL, NULL)`;
        }
      }

      // 3) 変換済み callout（区切り線＋選択本文）を削除（残置＝実在呼び出しは触らない）。
      let deleted = 0;
      if (plan.deleteCalloutIds.length > 0) {
        const del = await tx`
          DELETE FROM student_callouts WHERE id IN ${tx(plan.deleteCalloutIds)} RETURNING id`;
        deleted = del.length;
      }

      console.log(
        JSON.stringify({
          event: "migrate.shinro.bulletin.applied",
          classId: resolvedClassId,
          scheduleRowsUpdated: plan.scheduleConversions.length,
          scheduleDividersCreated: plan.totalScheduleDividers,
          anchorDate: plan.anchorDate,
          pinnedNoticesAdded: noticesAdded,
          calloutsDeleted: deleted,
          backupFile: args.backupFile,
          nextStep:
            "TV 設定編集 UI（/ops/tv-devices/[id]/edit）で当該端末を pattern5 に切替→実機目視。ロールバックは pattern3 へ戻す＋backupFile から callout 復元。",
        }),
      );
    });
  } catch (err) {
    // porsager の PostgresError は `.query`/`.parameters`（校訓本文・UUID を含みうる）を持つため object 全体を
    // ダンプしない。DB メッセージ（列名・制約名など）のみ出す（トークン/実名/DSN は message には乗らない）。
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
