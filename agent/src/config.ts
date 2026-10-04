import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Abi, Address } from "viem";

/**
 * The one place the desk contract is named. The deployment script generates
 * packages/nextjs/contracts/deployedContracts.ts, keyed by chain id and then by this name; the plugin reads the
 * address and ABI from there at runtime. After the contract is renamed, change this constant (or set
 * DESK_CONTRACT_NAME) and nothing else.
 */
export const CONTRACT_NAME = process.env.DESK_CONTRACT_NAME?.trim() || "GavelDesk";

export const HEDERA_TESTNET_CHAIN_ID = 296;

/** SAUCE on Hedera testnet (0.0.1183558). WHBAR and the stablecoin are read from the desk itself. */
export const SAUCE: Address = "0x0000000000000000000000000000000000120f46";

export type DeskConfig = {
  contractName: string;
  desk: Address;
  abi: Abi;
  chainId: number;
  rpcUrl: string;
  mirrorUrl: string;
  hashscanUrl: string;
  /** HCS topic the desk's quotes are posted to; null until configured (QUOTE_TOPIC_ID). */
  topicId: string | null;
};

const DEFAULT_DEPLOYED = fileURLToPath(new URL("../../packages/nextjs/contracts/deployedContracts.ts", import.meta.url));

type Deployed = Record<string, Record<string, { address: string; abi: Abi }>>;

/**
 * deployedContracts.ts is generated as one `const deployedContracts = { ... } as const;` object literal, so the
 * literal is evaluated as data. ponytail: relies on the generator's output shape, switch to a JSON export if it changes.
 */
export function parseDeployedContracts(source: string): Deployed {
  const start = source.indexOf("const deployedContracts =");
  const end = source.lastIndexOf("} as const;");
  if (start < 0 || end < 0) throw new Error("deployedContracts.ts does not contain `const deployedContracts = { ... } as const;`");
  const literal = source.slice(start + "const deployedContracts =".length, end + 1);
  return new Function(`"use strict"; return (${literal});`)() as Deployed;
}

const pick = (value: string | undefined, fallback: string) => (value && value.trim() !== "" ? value.trim() : fallback);

/** Required functions: a ABI without them is not a desk, and the error says so instead of failing deep in a tool. */
const REQUIRED = ["postOrder", "getOrder", "fillWithQuote", "cancel", "cancelNonces", "nonceUsed", "oracleFloor", "quoteDigest", "eip712Domain", "factory", "whbar", "usdToken", "fuelPerOrder", "MIN_TTL", "MAX_TTL"];

/**
 * Environment: DEPLOYED_CONTRACTS_PATH (default: the repo's generated file), HEDERA_RPC_URL, HEDERA_MIRROR_URL,
 * QUOTE_TOPIC_ID. `read` is injectable so tests do not touch the disk.
 */
export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): DeskConfig {
  const path = pick(env.DEPLOYED_CONTRACTS_PATH, DEFAULT_DEPLOYED);
  const deployed = parseDeployedContracts(read(path));
  const entry = deployed[String(HEDERA_TESTNET_CHAIN_ID)]?.[CONTRACT_NAME];
  if (!entry) {
    const have = Object.keys(deployed[String(HEDERA_TESTNET_CHAIN_ID)] ?? {});
    throw new Error(`${path} has no ${CONTRACT_NAME} on chain ${HEDERA_TESTNET_CHAIN_ID} (found: ${have.join(", ") || "nothing"}). Set CONTRACT_NAME in src/config.ts or DESK_CONTRACT_NAME.`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(entry.address)) throw new Error(`${CONTRACT_NAME} address in ${path} is not an EVM address: ${entry.address}`);
  const names = new Set(entry.abi.filter((x) => x.type === "function").map((x) => (x as { name: string }).name));
  const missing = REQUIRED.filter((n) => !names.has(n));
  if (missing.length) throw new Error(`${CONTRACT_NAME} ABI in ${path} lacks ${missing.join(", ")}; this plugin drives a Gavel/Backstop RFQ desk.`);
  const topic = env.QUOTE_TOPIC_ID?.trim();
  if (topic && !/^0\.0\.\d+$/.test(topic)) throw new Error(`QUOTE_TOPIC_ID is not a topic id (0.0.N): ${topic}`);
  return {
    contractName: CONTRACT_NAME,
    desk: entry.address as Address,
    abi: entry.abi,
    chainId: HEDERA_TESTNET_CHAIN_ID,
    rpcUrl: pick(env.HEDERA_RPC_URL, "https://testnet.hashio.io/api"),
    mirrorUrl: pick(env.HEDERA_MIRROR_URL, "https://testnet.mirrornode.hedera.com").replace(/\/$/, ""),
    hashscanUrl: "https://hashscan.io/testnet",
    topicId: topic || null,
  };
}
