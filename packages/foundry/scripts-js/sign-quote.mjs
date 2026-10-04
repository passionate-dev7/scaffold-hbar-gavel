// Signs a Backstop EIP-712 quote with MAKER_PRIVATE_KEY from packages/foundry/.env and prints the quote JSON.
// The key is read here and never printed. The output is the HCS wire format the maker bot also posts.
//   node scripts-js/sign-quote.mjs <desk> <orderId> <amountOut> <deadlineUnix> <nonce> [chainId]
import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const [desk, orderId, amountOut, deadline, nonce, chainId = "296"] = process.argv.slice(2);
if (!desk || !orderId || !amountOut || !deadline || !nonce) {
  console.error("usage: sign-quote.mjs <desk> <orderId> <amountOut> <deadlineUnix> <nonce> [chainId]");
  process.exit(2);
}
const pk = process.env.MAKER_PRIVATE_KEY;
if (!pk) throw new Error("MAKER_PRIVATE_KEY missing in packages/foundry/.env");
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);

export const types = {
  Quote: [
    { name: "orderId", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "amountOut", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};
const message = {
  orderId: BigInt(orderId),
  maker: account.address,
  amountOut: BigInt(amountOut),
  deadline: BigInt(deadline),
  nonce: BigInt(nonce),
};
const signature = await account.signTypedData({
  domain: { name: "Backstop", version: "1", chainId: Number(chainId), verifyingContract: desk },
  types,
  primaryType: "Quote",
  message,
});
console.log(
  JSON.stringify({
    orderId,
    maker: account.address,
    amountOut,
    deadline,
    nonce,
    signature,
  }),
);
