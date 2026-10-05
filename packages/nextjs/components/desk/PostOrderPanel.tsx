"use client";

import { useState } from "react";
import { parseEventLogs } from "viem";
import { useAccount, useBalance, usePublicClient } from "wagmi";
import { AssociationWarning } from "~~/components/desk/AssociationWarning";
import { type PlannedStep, TxSteps } from "~~/components/desk/TxSteps";
import { WalletGate } from "~~/components/desk/WalletGate";
import { needsAssociation, useAssociations } from "~~/hooks/desk/useAssociations";
import { useDeskParams, usePoolSpot } from "~~/hooks/desk/useDesk";
import { type RunnableStep, useTx, useWalletReady } from "~~/hooks/desk/useTx";
import {
  CHAIN_ID,
  DEFAULT_SLIPPAGE_BPS,
  DESK_ABI,
  DESK_ADDRESS,
  GAS_FLOOR,
  PAIRS,
  SLIPPAGE_OPTIONS_BPS,
  TTL_OPTIONS,
  WEIBAR_PER_TINYBAR,
} from "~~/utils/desk/constants";
import { fmtHbar, fmtPercentFromBps, fmtToken, fmtUnits, parseAmount } from "~~/utils/desk/format";
import { applySlippage, spotOut } from "~~/utils/desk/pool";

const ONE_HBAR = 100_000_000n;

export function PostOrderPanel({ onPosted }: { onPosted: (id: bigint) => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const ready = useWalletReady();
  const tx = useTx();
  const params = useDeskParams();

  const [pairId, setPairId] = useState<(typeof PAIRS)[number]["id"]>(PAIRS[0].id);
  const [amountText, setAmountText] = useState("5");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [ttlSeconds, setTtlSeconds] = useState<number>(TTL_OPTIONS[1].seconds);

  const pair = PAIRS.find(p => p.id === pairId)!;
  const spot = usePoolSpot(
    { tokenIn: pair.tokenIn.address, tokenOut: pair.tokenOut.address, fee: pair.fee },
    params.data?.factory,
  );
  const balance = useBalance({ address, chainId: CHAIN_ID });
  const [{ state: association }] = useAssociations(address, [pair.tokenOut.address]);

  const fuel = params.data?.fuelPerOrder;
  const amountIn = parseAmount(amountText, pair.tokenIn.decimals);
  const priceOfOne = spot.data ? spotOut(spot.data.sqrtPriceX96, spot.data.tokenInIsToken0, ONE_HBAR) : undefined;
  const poolOut =
    spot.data && amountIn ? spotOut(spot.data.sqrtPriceX96, spot.data.tokenInIsToken0, amountIn) : undefined;
  const minOut = poolOut === undefined ? undefined : applySlippage(poolOut, slippageBps);
  const total = amountIn !== null && fuel !== undefined ? amountIn + fuel : undefined;
  const walletTinybar = balance.data ? balance.data.value / WEIBAR_PER_TINYBAR : undefined;

  const ttlChoices = TTL_OPTIONS.filter(t =>
    params.data ? BigInt(t.seconds) >= params.data.minTtl && BigInt(t.seconds) <= params.data.maxTtl : true,
  );

  let blocker: string | null = null;
  if (!amountIn) blocker = "Enter an HBAR amount.";
  else if (spot.isError) blocker = "The SaucerSwap pool could not be read.";
  else if (minOut === undefined || fuel === undefined) blocker = "Reading the pool and the desk.";
  else if (minOut === 0n) blocker = "That amount is too small to price.";
  else if (total !== undefined && walletTinybar !== undefined && total > walletTinybar)
    blocker = `Your wallet holds ${fmtHbar(walletTinybar, 2)}; the order needs ${fmtHbar(total, 2)}.`;
  else if (association.kind === "unknown" || association.kind === "checking")
    blocker = `Checking whether you are associated with ${pair.tokenOut.symbol}.`;

  const needsAssoc = needsAssociation(association);
  const steps: PlannedStep[] = [
    {
      id: "associate",
      label: `Associate ${pair.tokenOut.symbol} with your account`,
      needed: needsAssoc,
      hint: "Hedera accounts opt in to a token before they can receive it. Proceeds are paid straight to you.",
    },
    {
      id: "post",
      label: "Post the order",
      needed: true,
      hint: "One transaction escrows the HBAR, wraps it, and books the fallback swap on the Hedera Schedule Service.",
    },
  ];

  const post = async () => {
    if (!address || !amountIn || minOut === undefined || fuel === undefined) return;
    const sequence: RunnableStep[] = [];
    if (needsAssoc) sequence.push(tx.associateStep(pair.tokenOut.address, "associate"));
    sequence.push({
      id: "post",
      send: () =>
        tx.call(
          {
            address: DESK_ADDRESS,
            abi: DESK_ABI,
            functionName: "postOrder",
            args: [pair.tokenIn.address, pair.tokenOut.address, pair.fee, amountIn, minOut, BigInt(ttlSeconds)],
            // msg.value reaches the contract in tinybar; the JSON-RPC layer counts weibar.
            value: (amountIn + fuel) * WEIBAR_PER_TINYBAR,
          },
          GAS_FLOOR.post,
        ),
      verify: async hash => {
        const receipt = await client!.getTransactionReceipt({ hash });
        const [posted] = parseEventLogs({ abi: DESK_ABI, logs: receipt.logs, eventName: "OrderPosted" });
        if (!posted) throw new Error("The transaction mined without an OrderPosted event.");
        const id = posted.args.id;
        const order = await client!.readContract({
          address: DESK_ADDRESS,
          abi: DESK_ABI,
          functionName: "getOrder",
          args: [id],
        });
        if (order.status !== 0 || order.taker.toLowerCase() !== address.toLowerCase())
          throw new Error(`Order #${id} is not open under your account.`);
        onPosted(id);
      },
    });
    await tx.run(sequence);
  };

  return (
    <section id="post" aria-labelledby="post-title" className="scroll-mt-6">
      <div className="sec-h">
        <h2 id="post-title">Post an order</h2>
      </div>
      <p className="m-0 mt-3 text-sm text-sub">
        Sell HBAR for a token. Makers bid with signed quotes; if none beats your floor, the swap runs on SaucerSwap.
      </p>

      <fieldset className="m-0 mt-6 border-0 p-0">
        <legend className="mb-2 p-0 text-sm font-bold">Pair</legend>
        <div className="flex flex-wrap gap-2">
          {PAIRS.map(p => (
            <button
              key={p.id}
              type="button"
              className="pick"
              aria-pressed={p.id === pairId}
              onClick={() => setPairId(p.id)}
            >
              HBAR to {p.tokenOut.symbol}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <label htmlFor="amount-in" className="text-sm font-bold">
            Amount to sell
          </label>
          <span className="text-xs text-mute">
            {walletTinybar !== undefined ? `Wallet ${fmtHbar(walletTinybar, 2)}` : "Connect to see your balance"}
          </span>
        </div>
        <label className="field mt-2" aria-invalid={amountText !== "" && amountIn === null}>
          <input
            id="amount-in"
            inputMode="decimal"
            autoComplete="off"
            className="tabular-nums"
            value={amountText}
            onChange={e => setAmountText(e.target.value)}
            aria-invalid={amountText !== "" && amountIn === null}
          />
          <span className="text-sm text-mute">HBAR</span>
        </label>
      </div>

      <div className="mt-6 grid gap-6">
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-bold">Slippage below pool spot</legend>
          <div className="flex flex-wrap gap-2">
            {SLIPPAGE_OPTIONS_BPS.map(bps => (
              <button
                key={bps}
                type="button"
                className="pick"
                aria-pressed={bps === slippageBps}
                onClick={() => setSlippageBps(bps)}
              >
                {fmtPercentFromBps(bps)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-bold">Quotes stay open for</legend>
          <div className="flex flex-wrap gap-2">
            {ttlChoices.map(t => (
              <button
                key={t.seconds}
                type="button"
                className="pick"
                aria-pressed={t.seconds === ttlSeconds}
                onClick={() => setTtlSeconds(t.seconds)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <dl className="m-0 mt-8 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 border-t border-hair pt-4 text-sm">
        <dt className="text-mute">SaucerSwap spot</dt>
        <dd className="m-0 text-right tabular-nums">
          {priceOfOne !== undefined
            ? `1 HBAR = ${fmtUnits(priceOfOne, pair.tokenOut.decimals, 5)} ${pair.tokenOut.symbol}`
            : "Reading pool"}
        </dd>
        <dt className="text-mute">Pool output at this size</dt>
        <dd className="m-0 text-right tabular-nums">
          {poolOut !== undefined ? fmtToken(poolOut, pair.tokenOut.address) : "-"}
        </dd>
        <dt className="font-bold">Your floor (minimum out)</dt>
        <dd className="m-0 text-right font-bold tabular-nums">
          {minOut !== undefined ? fmtToken(minOut, pair.tokenOut.address) : "-"}
        </dd>
        <dt className="text-mute">Escrowed and wrapped</dt>
        <dd className="m-0 text-right tabular-nums">{amountIn ? fmtHbar(amountIn) : "-"}</dd>
        <dt className="text-mute">Fuel for the fallback, returned on fill or cancel</dt>
        <dd className="m-0 text-right tabular-nums">{fuel !== undefined ? fmtHbar(fuel) : "-"}</dd>
        <dt className="text-mute">Sent from your wallet</dt>
        <dd className="m-0 text-right tabular-nums">{total !== undefined ? fmtHbar(total) : "-"}</dd>
      </dl>

      <div className="mt-8 flex flex-col gap-4">
        <AssociationWarning state={association} />
        <TxSteps steps={steps} runs={tx.runs} />
        <WalletGate ready={ready}>
          <button type="button" className="act act-block" onClick={post} disabled={!!blocker || tx.running}>
            {tx.running ? "Working" : "Post order"}
          </button>
        </WalletGate>
        {blocker && ready.isConnected && <p className="m-0 text-sm text-mute">{blocker}</p>}
      </div>
    </section>
  );
}
