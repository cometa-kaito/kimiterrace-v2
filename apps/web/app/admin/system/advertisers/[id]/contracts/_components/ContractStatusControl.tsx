"use client";

import { updateContractStatusAction } from "@/lib/system-admin/contracts-actions";
import {
  CONTRACT_STATUS_LABEL,
  CONTRACT_STATUS_TRANSITIONS,
  type ContractStatus,
} from "@/lib/system-admin/contracts-core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F10 (#46): 契約のステータス遷移ボタン群。**Client Component**。現在ステータスから許可された遷移
 * (`CONTRACT_STATUS_TRANSITIONS`) のみをボタン表示し、押下で confirm → `updateContractStatusAction` →
 * 成功で `router.refresh()`。終端 (terminated) は遷移先が無いので「—」を表示する。
 *
 * 遷移の妥当性・楽観ロック・認可・監査は Server Action 側が担保するので、ここは「許可された候補だけを
 * 出す」UX と結果表示に徹する (contracts-core を単一ソースとし、UI と Action でルールを二重化しない)。
 */
export function ContractStatusControl({
  contractId,
  status,
}: {
  contractId: string;
  status: ContractStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const transitions = CONTRACT_STATUS_TRANSITIONS[status];

  function transition(to: ContractStatus) {
    if (!window.confirm(`ステータスを「${CONTRACT_STATUS_LABEL[to]}」に変更しますか？`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await updateContractStatusAction({ id: contractId, status: to });
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  if (transitions.length === 0) {
    return <span style={mutedStyle}>—</span>;
  }

  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
      {transitions.map((to) => (
        <button
          key={to}
          type="button"
          disabled={pending}
          onClick={() => transition(to)}
          style={btnStyle}
        >
          → {CONTRACT_STATUS_LABEL[to]}
        </button>
      ))}
      {error ? <output style={errorStyle}>{error}</output> : null}
    </span>
  );
}

const mutedStyle: React.CSSProperties = { color: "#9ca3af" };
const btnStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  background: "#fff",
  color: "#1d4ed8",
  border: "1px solid #bfdbfe",
  borderRadius: "6px",
  fontSize: "0.8rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { display: "block", color: "#b91c1c", fontSize: "0.8rem" };
