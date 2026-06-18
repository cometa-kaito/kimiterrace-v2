import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { TV_CONFIG_EDIT_ROLES, isUuid } from "@/lib/tv/config-edit-core";
import { getTvDeviceConfig, listRecentTvCommands } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { TvCommandControl } from "./_components/TvCommandControl";
import { TvConfigEditForm } from "./_components/TvConfigEditForm";
import { TvDeviceDeleteButton } from "./_components/TvDeviceDeleteButton";

/**
 * F15 §4.2 (ADR-022): TV デバイス設定編集（`/ops/tv-devices/[deviceId]/edit`）。**Server Component**。
 *
 * ルートパラメータ `deviceId` は **`tv_devices.id`（行 PK の UUID）**。一覧 (`/ops/tv-devices`) の編集
 * リンクが `device.id` を渡す（TV 生成の `device_id` テキストではなく、安定した行 PK で参照する）。
 *
 * **認可**: 一覧は閲覧専用で ADMIN_ROLES（teacher 含む）だが、**編集は書き込み**のため
 * `TV_CONFIG_EDIT_ROLES`（school_admin / system_admin）に絞る（teacher は 403 → /forbidden、ルール2 の
 * role 境界第一層）。可視範囲は `tv_devices` の RLS が DB レベルで決める（他校 / 退役 TV は不可視 → 404）。
 *
 * 現在の設定を `withSession` の自校 RLS tx で `getTvDeviceConfig` から読み、不可視なら `notFound()`。
 * 編集フォーム（Client）に `defaultValue` として渡す。保存・検証・version +1・監査は Server Action 側
 * (`config-edit-actions.ts`) と RLS が担保する。
 */
export default async function TvDeviceEditPage({
  params,
}: {
  params: Promise<{ deviceId: string }>;
}) {
  await requireRole(TV_CONFIG_EDIT_ROLES);
  const { deviceId } = await params;
  // 不正な id は DB に投げず即 404（UUID でないパスは存在しないものとして扱う）。
  if (!isUuid(deviceId)) {
    notFound();
  }

  // 設定と直近コマンド履歴を同一 RLS セッションで取得する（コマンド送信コントロールの履歴表示用）。
  const loaded = await withSession(
    async (tx) => {
      const device = await getTvDeviceConfig(tx, deviceId);
      if (!device) {
        return null;
      }
      const commands = await listRecentTvCommands(tx, deviceId);
      return { device, commands };
    },
    { allowedRoles: TV_CONFIG_EDIT_ROLES, tenantScoped: true },
  );

  // 他校 / 存在しない / 退役 TV は RLS or deleted_at で不可視 → 404。
  if (!loaded) {
    notFound();
  }
  const { device, commands } = loaded;

  return (
    <section style={{ maxWidth: "640px" }}>
      <Breadcrumb
        items={[
          { label: "モニタ設定", href: "/ops/tv-devices" },
          { label: device.label ?? "（ラベル未設定）" },
          { label: "編集" },
        ]}
      />
      <h1 style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0.75rem 0 0.25rem" }}>
        TV 設定の編集
      </h1>
      <p style={{ color: "#6b7280", margin: "0 0 1.25rem", fontSize: "0.9rem" }}>
        設定を保存すると設定版（v{device.version}）が 1 つ上がり、各 TV が次回ポーリング（最大 60
        秒以内）で新しい設定を取り込みます。
      </p>
      <TvConfigEditForm
        deviceRowId={device.id}
        deviceId={device.deviceId}
        initial={{
          label: device.label,
          targetMac: device.targetMac,
          signageUrl: device.signageUrl,
          webhookUrl: device.webhookUrl,
          schedule: device.scheduleJson,
          monitoringEnabled: device.monitoringEnabled,
          notes: device.notes,
        }}
        currentVersion={device.version}
      />
      <TvCommandControl
        deviceRowId={device.id}
        recent={commands.map((c) => ({
          id: c.id,
          command: c.command,
          status: c.status,
          issuedAt: c.issuedAt.toISOString(),
          acknowledgedAt: c.acknowledgedAt ? c.acknowledgedAt.toISOString() : null,
        }))}
      />
      <TvDeviceDeleteButton
        deviceRowId={device.id}
        label={device.label}
        deviceId={device.deviceId}
      />
    </section>
  );
}
