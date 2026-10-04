#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, toEventSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client, AccountId, PrivateKey, TopicId, TopicMessageSubmitTransaction, Status } from "@hiero-ledger/sdk";
import { deskAbi, erc20Abi, factoryAbi, poolAbi } from "./abi.mjs";
import { decideQuote, quoteDeadline, quoteJson, signQuote, recoverQuoteSigner, STATUS } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_IDS = { testnet: 296, mainnet: 295, previewnet: 297 };
const GAS_APPROVE = 1_500_000n;
const GAS_FILL = 2_000_000n;
const ORDER_POSTED = toEventSelector(deskAbi.find((x) => x.type === "event" && x.name === "OrderPosted"));

export function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  const envFile = resolve(HERE, "../../packages/foundry/.env");
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);
  const flags = new Set(argv);
  const network = env.HEDERA_NETWORK || "testnet";
  if (!(network in CHAIN_IDS)) throw new Error(`HEDERA_NETWORK must be one of ${Object.keys(CHAIN_IDS)}`);
  const privateKey = env.MAKER_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY;
  const need = (k, v) => {
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  return {
    network,
    chainId: CHAIN_IDS[network],
    desk: need("DESK_ADDRESS", env.DESK_ADDRESS),
    topicId: flags.has("--dry-run") ? env.QUOTE_TOPIC_ID : need("QUOTE_TOPIC_ID", env.QUOTE_TOPIC_ID),
    privateKey: need("MAKER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY in packages/foundry/.env)", privateKey).replace(/^(?!0x)/, "0x"),
    accountId: env.MAKER_ACCOUNT_ID,
    spreadBps: Number(env.SPREAD_BPS ?? 30),
    quoteTtlSec: Number(env.QUOTE_TTL_SECONDS ?? 300),
    pollMs: Number(env.POLL_SECONDS ?? 10) * 1000,
    mirrorUrl: (env.MIRROR_URL || `https://${network}.mirrornode.hedera.com`).replace(/\/$/, ""),
    rpcUrl: env.RPC_URL || "https://testnet.hashio.io/api",
    once: flags.has("--once"),
    dryRun: flags.has("--dry-run"),
    autoFill: flags.has("--auto-fill"),
  };
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function mirrorGet(cfg, path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith("http") ? path : `${cfg.mirrorUrl}${path}`);
    if (res.ok) return res.json();
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) throw new Error(`mirror ${res.status} for ${path}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

export async function fetchOrderPosted(cfg, afterTimestamp) {
  const ids = [];
  let cursor = afterTimestamp;
  let next = `/api/v1/contracts/${cfg.desk}/results/logs?order=asc&limit=100&timestamp=gt:${afterTimestamp}`;
  while (next) {
    const page = await mirrorGet(cfg, next);
    for (const l of page.logs ?? []) {
      cursor = l.timestamp;
      if (l.topics?.[0]?.toLowerCase() !== ORDER_POSTED.toLowerCase()) continue;
      const ev = decodeEventLog({ abi: deskAbi, data: l.data, topics: l.topics });
      ids.push(ev.args.id);
    }
    next = page.links?.next ?? null;
  }
  return { ids, cursor };
}

export function hederaClient({ network, accountId, privateKey }) {
  const client = Client.forName(network);
  client.setOperator(AccountId.fromString(accountId), PrivateKey.fromStringECDSA(privateKey.replace(/^0x/, "")));
  return client;
}

// Submits one HCS message and returns only once the receipt says SUCCESS, with the topic sequence number.
export async function postToTopic(client, topicId, message) {
  const resp = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(topicId)).setMessage(message).execute(client);
  const receipt = await resp.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error(`HCS submit status ${receipt.status}`);
  return { sequence: receipt.topicSequenceNumber.toString(), txId: resp.transactionId.toString() };
}

export async function resolveAccountId(cfg, address) {
  if (cfg.accountId) return cfg.accountId;
  const acct = await mirrorGet(cfg, `/api/v1/accounts/${address}`);
  return acct.account;
}

export async function main() {
  const cfg = loadConfig();
  const chain = defineChain({
    id: cfg.chainId,
    name: `hedera-${cfg.network}`,
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const account = privateKeyToAccount(cfg.privateKey);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const desk = cfg.desk;
  const factory = await pub.readContract({ address: desk, abi: deskAbi, functionName: "factory" });

  let hcs = null;
  if (!cfg.dryRun) {
    hcs = hederaClient({ network: cfg.network, accountId: await resolveAccountId(cfg, account.address), privateKey: cfg.privateKey });
  }
  log(`maker ${account.address} desk ${desk} chain ${cfg.chainId} spread ${cfg.spreadBps}bps mode ${cfg.dryRun ? "dry-run" : cfg.autoFill ? "post+auto-fill" : "post"}`);

  const known = new Set();
  const quoted = new Map(); // id -> { deadline, amountOut, tokenOut }
  let cursor = "0";
  const poolCache = new Map();

  const poolFor = async (o) => {
    const key = `${o.tokenIn}|${o.tokenOut}|${o.fee}`.toLowerCase();
    if (!poolCache.has(key)) {
      const pool = await pub.readContract({ address: factory, abi: factoryAbi, functionName: "getPool", args: [o.tokenIn, o.tokenOut, o.fee] });
      const token0 = await pub.readContract({ address: pool, abi: poolAbi, functionName: "token0" });
      poolCache.set(key, { pool, token0 });
    }
    return poolCache.get(key);
  };

  const waitReceipt = async (hash) => {
    for (let i = 0; ; i++) {
      try {
        const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 2_000 });
        if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
        return r;
      } catch (e) {
        if (String(e.message).includes("reverted") || i >= 5) throw e;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  };

  const outstanding = (tokenOut, nowSec, exceptId) => {
    let sum = 0n;
    for (const [id, q] of quoted) {
      if (id !== exceptId && q.tokenOut === tokenOut && q.deadline > BigInt(nowSec) && known.has(id)) sum += q.amountOut;
    }
    return sum;
  };

  const handle = async (id, nowSec) => {
    const order = await pub.readContract({ address: desk, abi: deskAbi, functionName: "getOrder", args: [id] });
    if (Number(order.status) !== STATUS.Open || BigInt(order.expiry) <= BigInt(nowSec)) {
      known.delete(id);
      if (quoted.delete(id)) log(`order ${id} done (status ${order.status}${BigInt(order.expiry) <= BigInt(nowSec) ? ", expired" : ""})`);
      return;
    }
    const prev = quoted.get(id);
    if (prev && prev.deadline > BigInt(nowSec) + 30n) return;

    const { pool, token0 } = await poolFor(order);
    const [sqrtPriceX96] = await pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
    let oracleFloor;
    try {
      oracleFloor = await pub.readContract({ address: desk, abi: deskAbi, functionName: "oracleFloor", args: [id] });
    } catch {
      log(`order ${id} skipped: oracle floor unavailable (stale or invalid feed), desk would reject any fill`);
      return;
    }
    const d = decideQuote({
      order,
      sqrtPriceX96,
      tokenInIsToken0: order.tokenIn.toLowerCase() === token0.toLowerCase(),
      spreadBps: cfg.spreadBps,
      nowSec,
      oracleFloor,
    });
    if (!d.ok) return log(`order ${id} skipped: ${d.reason}`);

    const balance = await pub.readContract({ address: order.tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    const need = outstanding(order.tokenOut, nowSec, id) + d.amountOut;
    if (balance < need) return log(`order ${id} skipped: maker balance ${balance} < ${need} of ${order.tokenOut}`);

    const deadline = quoteDeadline({ orderExpiry: order.expiry, nowSec, ttlSec: cfg.quoteTtlSec });
    const quote = { orderId: id, maker: account.address, amountOut: d.amountOut, deadline, nonce: id };
    const signature = await signQuote({ privateKey: cfg.privateKey, desk, chainId: cfg.chainId, quote });
    const signer = await recoverQuoteSigner({ desk, chainId: cfg.chainId, quote, signature });
    if (signer.toLowerCase() !== account.address.toLowerCase()) throw new Error("self-check failed: signature does not recover to maker");
    const message = quoteJson({ ...quote, signature });

    const allowance = await pub.readContract({ address: order.tokenOut, abi: erc20Abi, functionName: "allowance", args: [account.address, desk] });
    if (cfg.dryRun) {
      if (allowance < need) log(`order ${id} dry-run: would approve ${need} of ${order.tokenOut} (allowance ${allowance})`);
      log(`order ${id} dry-run quote:`);
      console.log(message);
      return;
    }
    if (allowance < need) {
      const hash = await wallet.writeContract({ address: order.tokenOut, abi: erc20Abi, functionName: "approve", args: [desk, need], gas: GAS_APPROVE });
      await waitReceipt(hash);
      const after = await pub.readContract({ address: order.tokenOut, abi: erc20Abi, functionName: "allowance", args: [account.address, desk] });
      if (after < need) throw new Error(`approve mined but allowance is ${after} < ${need}`);
      log(`order ${id} allowance raised to ${after} (${hash})`);
    }

    const posted = await postToTopic(hcs, cfg.topicId, message);
    quoted.set(id, { deadline, amountOut: d.amountOut, tokenOut: order.tokenOut });
    log(`order ${id} quoted ${d.amountOut} until ${deadline}: topic ${cfg.topicId} seq ${posted.sequence} tx ${posted.txId}`);

    if (cfg.autoFill) {
      const hash = await wallet.writeContract({
        address: desk,
        abi: deskAbi,
        functionName: "fillWithQuote",
        args: [id, { maker: quote.maker, amountOut: quote.amountOut, deadline, nonce: quote.nonce }, signature],
        gas: GAS_FILL,
      });
      await waitReceipt(hash);
      const after = await pub.readContract({ address: desk, abi: deskAbi, functionName: "getOrder", args: [id] });
      if (Number(after.status) !== STATUS.Filled) throw new Error(`fillWithQuote mined but order ${id} status is ${after.status}`);
      log(`order ${id} filled by maker (${hash})`);
    }
  };

  const tick = async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { ids, cursor: c } = await fetchOrderPosted(cfg, cursor);
    cursor = c;
    for (const id of ids) known.add(id);
    log(`tick: ${ids.length} new orders, ${known.size} tracked`);
    for (const id of [...known]) {
      try {
        await handle(id, nowSec);
      } catch (e) {
        log(`order ${id} error: ${e.shortMessage ?? e.message}`);
      }
    }
  };

  const stop = () => {
    hcs?.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  do {
    try {
      await tick();
    } catch (e) {
      log(`tick error: ${e.shortMessage ?? e.message}`);
      if (cfg.once) process.exitCode = 1;
    }
    if (!cfg.once) await new Promise((r) => setTimeout(r, cfg.pollMs));
  } while (!cfg.once);
  hcs?.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
