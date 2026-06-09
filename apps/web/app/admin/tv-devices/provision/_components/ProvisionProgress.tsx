"use client";

import {
  type ProvisioningJobStatusView,
  getProvisioningJobStatusAction,
} from "@/lib/tv/provisioning-status-actions";
import { useEffect, useState } from "react";

/**
 * C方式 TV プロビジョニング: 作成済みジョブの**ライブ進捗**を 3 秒間隔でポーリング表示する Client Component。
 * 端末（現地エージェント）が進める段階（preflight → awaiting_physical → provisioning → succeeded/failed）を
 * 運用者に提示する。終端状態（succeeded/failed/canceled）でポーリングを停止する。
 */

const STATUS_LABELS: Record<string, string> = {
  pending: "エージェントの claim 待ち",
  claimed: "エージェントが claim 済み",
  preflight: "preflight（接続・県Wi-Fi設定キャプチャ中）",
  awaiting_physical: "物理作業（工場リセット → 県Wi-Fi 再設定）を運用者に依頼中",
  provisioning: "プロビジョニング実行中（install / Device Owner / 起動）",
  succeeded: "完了（表示確認まで成功）",
  failed: "失敗",
  canceled: "中止",
};
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

export function ProvisionProgress({ jobId }: { jobId: string }) {
  const [view, setView] = useState<ProvisioningJobStatusView>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const v = await getProvisioningJobStatusAction(jobId);
      if (!active) {
        return;
      }
      setView(v);
      if (v && TERMINAL.has(v.status)) {
        setDone(true);
        return;
      }
      timer = setTimeout(poll, 3000);
    }
    poll();
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId]);

  if (!view) {
    return <p style={mutedStyle}>進捗を取得中…</p>;
  }

  const steps = Array.isArray(view.steps)
    ? (view.steps as { name?: string; status?: string }[])
    : [];

  return (
    <div style={progressStyle}>
      <p style={{ margin: 0, fontWeight: 700 }}>
        現在の状態: {STATUS_LABELS[view.status] ?? view.status}
        {done ? null : <span style={mutedStyle}>（自動更新中…）</span>}
      </p>
      {view.currentStep ? (
        <p style={{ margin: "0.3rem 0 0", fontSize: "0.9rem" }}>ステップ: {view.currentStep}</p>
      ) : null}
      {view.error ? (
        <p style={{ margin: "0.3rem 0 0", color: "#b91c1c", fontSize: "0.9rem" }}>
          エラー: {view.error}
        </p>
      ) : null}
      {steps.length > 0 ? (
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem", fontSize: "0.82rem" }}>
          {steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps_json は追記専用ログで並べ替えが無く、index が安定キー
            <li key={`${s.name ?? "step"}-${i}`}>
              {s.name ?? "step"} — {s.status ?? ""}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

const progressStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  padding: "0.75rem 1rem",
  marginTop: "0.75rem",
  background: "#f9fafb",
};
const mutedStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.85rem",
  marginLeft: "0.4rem",
};
