"use server";

import { getProvisioningJob } from "@kimiterrace/db";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { isUuid } from "./config-edit-core";
import { ONBOARDING_ROLES } from "./onboarding-core";

/**
 * C方式 TV プロビジョニング: 管理 UI の**ライブ進捗ポーリング**用 Server Action。
 *
 * `/ops/tv-devices/provision` でジョブ作成後、フォームが数秒間隔で本 Action を呼び status / current_step /
 * steps_json を再取得して表示する（一覧 page の status 再取得と同方式）。認可は system_admin 限定
 * （ONBOARDING_ROLES）、可視範囲は RLS 委譲。秘密は含まない（steps_json は秘密非格納で設計、ルール5）。
 */

/** ライブ進捗の最小射影（UI 表示に必要な非秘密フィールドのみ）。 */
export type ProvisioningJobStatusView = {
  status: string;
  currentStep: string | null;
  steps: unknown;
  error: string | null;
  signageUrl: string | null;
  deviceId: string | null;
} | null;

/**
 * ジョブ進捗を取得する。未認可は requireRole が /forbidden へ。jobId 不正 / 不可視 / 不存在は null。
 */
export async function getProvisioningJobStatusAction(
  jobId: string,
): Promise<ProvisioningJobStatusView> {
  await requireRole(ONBOARDING_ROLES);
  if (!isUuid(jobId)) {
    return null;
  }
  const job = await withSession((tx) => getProvisioningJob(tx, jobId), {
    allowedRoles: ONBOARDING_ROLES,
  });
  if (!job) {
    return null;
  }
  return {
    status: job.status,
    currentStep: job.currentStep,
    steps: job.stepsJson,
    error: job.error,
    signageUrl: job.signageUrl,
    deviceId: job.deviceId,
  };
}
