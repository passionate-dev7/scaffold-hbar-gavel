/**
 * Calls the Gavel tools directly, no LLM in the loop, against the desk that deployedContracts.ts names.
 *
 *   npx tsx examples/direct.ts                       read-only: desk, latest order, its quote board, and the unsigned bytes of a post and a quote
 *   npx tsx examples/direct.ts --order 12            read-only on order 12
 *   npx tsx examples/direct.ts --roundtrip 2         taker posts 2 HBAR -> USDC, maker quotes, taker lists and accepts (sends transactions)
 *   npx tsx examples/direct.ts --post 2              taker only: post an order
 *   npx tsx examples/direct.ts --quote 12            maker only: quote order 12
 *   npx tsx examples/direct.ts --accept 12           taker only: accept the best quote on order 12
 *   npx tsx examples/direct.ts --cancel 12           taker only: cancel order 12
 *   npx tsx examples/direct.ts --cancel-quotes 12,13 maker only: cancel quote nonces
 *
 * Write flags need keys: DEPLOYER_PRIVATE_KEY is the taker, MAKER_PRIVATE_KEY (and MAKER_ACCOUNT_ID, else looked
 * up from the mirror node) is the maker. They are read from the environment or packages/foundry/.env and are never printed.
 */
import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { createGavelPlugin, gavelToolNames as T } from "../src";
import { DeskChain } from "../src/chain";
import { configFromEnv } from "../src/config";

loadEnv({ path: fileURLToPath(new URL("../../packages/foundry/.env", import.meta.url)), quiet: true });
loadEnv({ quiet: true });

const args = process.argv.slice(2);
const flag = (name: string) => args.indexOf(`--${name}`);
const value = (name: string) => (flag(name) >= 0 ? args[flag(name) + 1] : undefined);

const cfg = configFromEnv();
const chain = new DeskChain(cfg);

type Actor = { client: Client; ctx: Context; tools: Record<string, { execute: (c: Client, ctx: Context, p: unknown) => Promise<any> }>; accountId: string };

/** An agent identity: a Hedera client with the key as operator, and the plugin built for that role. */
async function actor(role: "taker" | "maker", keyHex: string | undefined, accountEnv: string | undefined, mode: AgentMode): Promise<Actor | null> {
  const client = Client.forTestnet();
  let accountId = accountEnv?.trim() || "";
  if (keyHex) {
    const priv = PrivateKey.fromStringECDSA(keyHex.trim().replace(/^0x/, ""));
    accountId ||= (await chain.account(`0x${priv.publicKey.toEvmAddress()}`)).accountId;
    client.setOperator(accountId, priv);
  } else if (mode === AgentMode.AUTONOMOUS) return null;
  accountId ||= "0.0.4729347";
  const ctx: Context = { mode, accountId };
  const plugin = createGavelPlugin({ config: cfg, chain, makerKey: role === "maker" && keyHex ? (`0x${keyHex.trim().replace(/^0x/, "")}` as Hex) : undefined });
  return { client, ctx, accountId, tools: Object.fromEntries(plugin.tools(ctx).map((t) => [t.method, t])) as Actor["tools"] };
}

async function run(who: string, label: string, a: Actor, method: string, params: unknown) {
  console.log(`\n== [${who}] ${label}`);
  const out = await a.tools[method]!.execute(a.client, a.ctx, params);
  if (out.bytes) {
    const { bytes, ...rest } = out;
    console.log(`Unsigned ${rest.type} ready: ${(bytes as Uint8Array).length} bytes, payer ${rest.payerAccountId}. Not sent.`);
    console.log(JSON.stringify(rest, null, 2));
    return out;
  }
  console.log(out.humanMessage);
  console.log(JSON.stringify(out.raw, null, 2));
  return out;
}

const takerKey = process.env.DEPLOYER_PRIVATE_KEY;
const makerKey = process.env.MAKER_PRIVATE_KEY;
const writes = ["roundtrip", "post", "quote", "accept", "cancel", "cancel-quotes"].filter((f) => flag(f) >= 0);
const mode = writes.length ? AgentMode.AUTONOMOUS : AgentMode.RETURN_BYTES;
const taker = await actor("taker", takerKey, process.env.HEDERA_ACCOUNT_ID, mode);
const maker = await actor("maker", makerKey, process.env.MAKER_ACCOUNT_ID, mode);
const reader = (await actor("taker", undefined, process.env.HEDERA_ACCOUNT_ID, AgentMode.RETURN_BYTES))!;

console.log(`desk ${cfg.desk} (${cfg.contractName})  topic ${cfg.topicId ?? "none"}  rpc ${cfg.rpcUrl}`);
console.log(`taker ${taker?.accountId ?? "read-only"}  maker ${maker?.accountId ?? "read-only"}  write flags ${writes.length ? writes.join(",") : "off"}`);
const domain = await chain.domain();
console.log(`EIP-712 domain read from the desk: ${JSON.stringify(domain)}`);

const need = (a: Actor | null, role: string) => {
  if (!a) throw new Error(`--${writes[0]} needs ${role === "taker" ? "DEPLOYER_PRIVATE_KEY" : "MAKER_PRIVATE_KEY"} in the environment. Nothing was sent.`);
  return a;
};

if (writes.length === 0) {
  const count = await chain.orderCount();
  const id = value("order") ?? (count > 0n ? String(count) : undefined);
  console.log(`orders posted on this desk: ${count}`);
  if (id) {
    await run("read", T.status, reader, T.status, { orderId: id });
    if (cfg.topicId) await run("read", T.list, reader, T.list, { orderId: id });
  }
  await run("read", `${T.post} (RETURN_BYTES, not sent)`, reader, T.post, { amount: "2" });
  if (id) await run("read", `${T.quote} (RETURN_BYTES, not sent)`, (await actor("maker", makerKey, process.env.MAKER_ACCOUNT_ID, AgentMode.RETURN_BYTES))!, T.quote, { orderId: id });
  console.log("\nRead-only run complete. Add --roundtrip 2 with DEPLOYER_PRIVATE_KEY and MAKER_PRIVATE_KEY set to send.");
} else {
  if (flag("roundtrip") >= 0) {
    const t = need(taker, "taker");
    const m = need(maker, "maker");
    const post = await run("taker", T.post, t, T.post, { amount: value("roundtrip") ?? "2" });
    if (post.raw?.status !== "SUCCESS") throw new Error("post_order did not succeed; stopping.");
    const orderId = post.raw.orderId as string;
    const q = await run("maker", T.quote, m, T.quote, { orderId });
    if (q.raw?.status !== "SUCCESS") throw new Error("quote_order did not succeed; stopping.");
    await run("taker", T.list, t, T.list, { orderId });
    await run("taker", T.accept, t, T.accept, { orderId });
    await run("taker", T.status, t, T.status, { orderId });
  }
  if (flag("post") >= 0) await run("taker", T.post, need(taker, "taker"), T.post, { amount: value("post") ?? "2" });
  if (flag("quote") >= 0) await run("maker", T.quote, need(maker, "maker"), T.quote, { orderId: value("quote") });
  if (flag("accept") >= 0) await run("taker", T.accept, need(taker, "taker"), T.accept, { orderId: value("accept") });
  if (flag("cancel") >= 0) await run("taker", T.cancel, need(taker, "taker"), T.cancel, { orderId: value("cancel") });
  if (flag("cancel-quotes") >= 0) await run("maker", T.cancelQuotes, need(maker, "maker"), T.cancelQuotes, { nonces: (value("cancel-quotes") ?? "").split(",") });
}
taker?.client.close();
maker?.client.close();
reader.client.close();
// The SDK's network channels can keep the event loop alive after close(); exit explicitly.
process.exit(process.exitCode ?? 0);
