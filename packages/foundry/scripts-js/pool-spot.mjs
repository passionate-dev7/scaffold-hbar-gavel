// Raw-unit spot value of <amountIn> of <tokenIn> in a SaucerSwap V2 pool, before the pool fee.
//   node scripts-js/pool-spot.mjs <pool> <tokenIn> <amountIn>
import { createPublicClient, http, parseAbi } from "viem";

const [pool, tokenIn, amountIn] = process.argv.slice(2);
if (!pool || !tokenIn || !amountIn) throw new Error("usage: pool-spot.mjs <pool> <tokenIn> <amountIn>");
const client = createPublicClient({ transport: http(process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api") });
const abi = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
]);
const [token0, slot] = await Promise.all([
  client.readContract({ address: pool, abi, functionName: "token0" }),
  client.readContract({ address: pool, abi, functionName: "slot0" }),
]);
const p = slot[0] * slot[0];
const q192 = 1n << 192n;
const a = BigInt(amountIn);
console.log((token0.toLowerCase() === tokenIn.toLowerCase() ? (a * p) / q192 : (a * q192) / p).toString());
