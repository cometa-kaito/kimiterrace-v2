"use client";

import { setSensorDecommissionedAction } from "@/lib/system-admin/sensor-ops-actions";
import { ConfirmDialog, useToast } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * 運営整理 §4 item5: 全校センサーの **撤去 / 再稼働** ボタン。**Client Component** — 一覧の各行に置く。
 * 認可・更新・監査・RLS は `setSensorDecommissionedAction` (system_admin) が担保するので、ここは操作と結果表示に徹する。
 *
 * **誤操作防止**: 撤去は配信運用に影響する (応答なし扱いから外れる等) ため共通 `ConfirmDialog` で確認する。
 * 再稼働は確認不要。撤去は不可逆ではない (再稼働で戻せる) が、誤って隣接行を撤去する事故を防ぐ。
 */
export function SensorDecommissionButton({
  sensorId,
  decommissioned,
  label,
}: {
  sensorId: string;
  decommissioned: boolean;
  label: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await setSensorDecommissionedAction({
        id: sensorId,
        decommissioned: !decommissioned,
      });
      // 成否いずれもダイアログは閉じる (失敗はインラインの error 表示に集約)。
      setConfirmOpen(false);
      if (res.ok) {
        toast(`「${label}」を${decommissioned ? "再稼働" : "撤去"}しました`, { tone: "success" });
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  function onClick() {
    // 撤去は確認ダイアログ経由、再稼働は即実行 (確認不要)。
    if (decommissioned) {
      run();
    } else {
      setConfirmOpen(true);
    }
  }

  return (
    <span style={wrapStyle}>
      <button type="button" onClick={onClick} disabled={pending} style={btnStyle}>
        {pending ? "…" : decommissioned ? "再稼働" : "撤去"}
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}
      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title={`「${label}」を撤去しますか？`}
        description="撤去すると稼働一覧で撤去済みになります。再稼働で戻せます。"
        confirmLabel="撤去する"
        pending={pending}
        onConfirm={run}
        onCancel={() => setConfirmOpen(false)}
      />
    </span>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.15rem 0.6rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.78rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: "0.75rem" };
