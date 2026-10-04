import { useState } from "react";
import { DepositPanel } from "./DepositPanel";
import { RedeemPanel } from "./RedeemPanel";
import type { Snapshot } from "~~/hooks/basket/useVault";

export function TradePanel({ snap }: { snap: Snapshot }) {
  const [tab, setTab] = useState<"deposit" | "redeem">("deposit");
  return (
    <section className="rounded-box border border-base-300 bg-base-100 p-6" aria-label="Deposit or redeem">
      <div role="tablist" className="tabs tabs-border mb-6">
        {(["deposit", "redeem"] as const).map(name => (
          <button
            key={name}
            role="tab"
            type="button"
            aria-selected={tab === name}
            className={`tab capitalize ${tab === name ? "tab-active font-semibold" : "text-base-content/70"}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "deposit" ? <DepositPanel snap={snap} /> : <RedeemPanel snap={snap} />}
    </section>
  );
}
