"use client";

import { ActivityFeed } from "./ActivityFeed";
import { AutomationCard } from "./AutomationCard";
import { Composition } from "./CompositionBar";
import { StatStrip } from "./StatStrip";
import { TradePanel } from "./TradePanel";
import { useVault } from "~~/hooks/basket/useVault";
import { VAULT_ADDRESS } from "~~/utils/basket/constants";
import { hashscan } from "~~/utils/basket/hedera";

const joinNames = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const Notice = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-box border border-base-300 bg-base-100 p-8">
    <h2 className="m-0 text-xl font-semibold">{title}</h2>
    <div className="mt-2 max-w-xl text-sm text-base-content/70">{children}</div>
  </div>
);

export function FundView() {
  const vault = useVault();
  const { config, live } = vault;
  const symbols = config.data ? config.data.tokens.map(t => t.symbol) : [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10 lg:px-8 lg:py-14">
      <header>
        <h1 className="m-0 max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">
          One share, a slice of every token in the basket.
        </h1>
        <p className="mt-4 max-w-xl text-base text-base-content/70">
          Deposit HBAR and the vault buys {symbols.length ? joinNames(symbols) : "the basket"} on SaucerSwap at their
          target weights. A Hedera schedule rebalances it. Redeem and take your slice in kind.
          {vault.deployed && (
            <>
              {" "}
              <a className="link link-primary" href={hashscan.contract(VAULT_ADDRESS)} target="_blank" rel="noreferrer">
                Vault on HashScan
              </a>
            </>
          )}
        </p>
      </header>

      {!vault.deployed && (
        <Notice title="No vault address for Hedera Testnet">
          <p className="m-0">
            Deploy with <code className="font-mono">yarn foundry:deploy --network hedera_testnet</code>. The deploy
            writes the address and ABI to deployedContracts.ts, and this page reads the vault from there.
          </p>
        </Notice>
      )}

      {vault.deployed && (config.isError || live.isError) && (
        <Notice title="Hedera Testnet did not answer">
          <p className="m-0">
            The vault could not be read through the RPC.{" "}
            <button
              type="button"
              className="link link-primary"
              onClick={() => {
                void config.refetch();
                void live.refetch();
              }}
            >
              Retry
            </button>
          </p>
        </Notice>
      )}

      {vault.deployed && !(config.isError || live.isError) && (!config.data || !live.data) && (
        <div className="flex flex-col gap-8" aria-busy="true" aria-label="Reading the vault">
          <div className="h-28 animate-pulse rounded-box bg-base-300/50" />
          <div className="h-80 animate-pulse rounded-box bg-base-300/50" />
        </div>
      )}

      {config.data && live.data && <Loaded snap={{ vault, cfg: config.data, lv: live.data }} />}
    </div>
  );
}

function Loaded({ snap }: { snap: Parameters<typeof StatStrip>[0]["snap"] }) {
  return (
    <>
      <StatStrip snap={snap} />
      <Composition snap={snap} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TradePanel snap={snap} />
        <AutomationCard snap={snap} />
      </div>
      <ActivityFeed snap={snap} />
    </>
  );
}
