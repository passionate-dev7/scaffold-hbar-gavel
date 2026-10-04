/**
 * Ask an LLM to trade on the Gavel RFQ desk through the Hedera Agent Kit (Vercel AI SDK adapter).
 *
 *   OPENAI_API_KEY=...    npx tsx examples/ask.ts "What is the best quote on order 5, and how does it compare with the fallback?"
 *   ANTHROPIC_API_KEY=... MODEL=anthropic:claude-sonnet-4-5 npx tsx examples/ask.ts "Sell 2 HBAR for USDC and settle with the best quote"
 *   npx tsx examples/ask.ts --maker "Quote order 12 at a 25 bps spread"
 *
 * MODEL is provider:model (openai or anthropic; any other AI SDK provider is one import away).
 * Without MODEL the provider is chosen by whichever API key is set.
 * Taker: DEPLOYER_PRIVATE_KEY signs and sends (AUTONOMOUS). Maker (--maker): MAKER_PRIVATE_KEY signs the quotes and
 * the same key's Hedera account pays. Without the key, or with --bytes, write tools return unsigned transaction bytes
 * for a human or wallet to sign (RETURN_BYTES). Keys come from the environment or packages/foundry/.env; they are never printed.
 */
import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { coreTokenPlugin } from "@hashgraph/hedera-agent-kit/plugins";
import { HederaAIToolkit } from "@hashgraph/hedera-agent-kit-ai-sdk";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { createGavelPlugin, gavelToolNames } from "../src";
import { DeskChain } from "../src/chain";
import { configFromEnv } from "../src/config";

loadEnv({ path: fileURLToPath(new URL("../../packages/foundry/.env", import.meta.url)), quiet: true });
loadEnv({ quiet: true });

function pickModel() {
  const spec = process.env.MODEL?.trim() || (process.env.ANTHROPIC_API_KEY ? "anthropic:claude-sonnet-4-5" : process.env.OPENAI_API_KEY ? "openai:gpt-4o" : "");
  const [provider, ...rest] = spec.split(":");
  const id = rest.join(":");
  if (provider === "anthropic" && id) return anthropic(id);
  if (provider === "openai" && id) return openai(id);
  throw new Error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or MODEL=openai:<model> / MODEL=anthropic:<model>.");
}

const args = process.argv.slice(2);
const bytesOnly = args.includes("--bytes");
const asMaker = args.includes("--maker");
const prompt =
  args.filter((a) => !a.startsWith("--")).join(" ") ||
  (asMaker ? "Look at the newest open order on the desk and quote it." : "Show me the newest order on the desk and every verified quote for it, best first, against the fallback.");

const cfg = configFromEnv();
const chain = new DeskChain(cfg);
const keyHex = (asMaker ? process.env.MAKER_PRIVATE_KEY : process.env.DEPLOYER_PRIVATE_KEY)?.trim();
const client = Client.forTestnet();
let accountId = (asMaker ? process.env.MAKER_ACCOUNT_ID : process.env.HEDERA_ACCOUNT_ID)?.trim() || undefined;
if (keyHex) {
  const priv = PrivateKey.fromStringECDSA(keyHex.replace(/^0x/, ""));
  accountId ||= (await chain.account(`0x${priv.publicKey.toEvmAddress()}`)).accountId;
  client.setOperator(accountId, priv);
}

const context: Context = keyHex && !bytesOnly ? { mode: AgentMode.AUTONOMOUS, accountId } : { mode: AgentMode.RETURN_BYTES, accountId: accountId ?? "0.0.4729347" };
const toolkit = new HederaAIToolkit({
  client,
  configuration: {
    plugins: [createGavelPlugin({ config: cfg, chain, makerKey: asMaker && keyHex ? (`0x${keyHex.replace(/^0x/, "")}` as Hex) : undefined }), coreTokenPlugin],
    // The desk tools, plus the kit's own associate_token_tool: post_order and accept_quote tell the agent to use it.
    tools: [...Object.values(gavelToolNames), "associate_token_tool"],
    context,
  },
});

console.log(`desk ${cfg.desk} (${cfg.contractName}), role ${asMaker ? "maker" : "taker"}, mode ${context.mode}, account ${context.accountId ?? "none"}, tools: ${Object.keys(toolkit.getTools()).join(", ")}\n`);
const { text, steps } = await generateText({
  model: pickModel(),
  tools: toolkit.getTools(),
  stopWhen: stepCountIs(10),
  system: asMaker
    ? "You are a market maker on the Gavel RFQ desk on Hedera testnet. Read get_order_status before quoting; quote_order prices from the SaucerSwap pool and signs for you. Report transaction and topic links verbatim. Never invent numbers: every figure comes from a tool result."
    : "You are a taker on the Gavel RFQ desk on Hedera testnet. Read get_order_status and list_quotes before advising. Every order is backed by a network-scheduled fallback swap, so compare any quote with the fallback figure. Report transaction links verbatim. Never invent numbers: every figure comes from a tool result.",
  prompt,
});
for (const step of steps) for (const call of step.toolCalls) console.log(`tool call: ${call.toolName}(${JSON.stringify(call.input)})`);
console.log(`\n${text}`);
client.close();
