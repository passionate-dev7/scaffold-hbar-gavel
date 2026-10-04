// Hedera Consensus Service helper for the Backstop quote board. Keys are read from packages/foundry/.env inside the
// process and never printed.
//
//   node scripts-js/hcs.mjs create-topic [memo]              operator: deployer (DEPLOYER_PRIVATE_KEY, 0.0.10855086)
//   node scripts-js/hcs.mjs submit <topicId> <json> [--as maker]   operator: deployer, or the maker with --as maker
//
// Prints one JSON line: { topicId } or { topicId, sequence, txId }.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Client,
  AccountId,
  PrivateKey,
  TopicId,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  Status,
} from "@hiero-ledger/sdk";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const MIRROR = process.env.MIRROR_URL || "https://testnet.mirrornode.hedera.com";
const [cmd, ...rest] = process.argv.slice(2);
const asMaker = rest.includes("--as") && rest[rest.indexOf("--as") + 1] === "maker";
const args = rest.filter((a, i) => a !== "--as" && rest[i - 1] !== "--as");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing in packages/foundry/.env`);
  return v;
}

async function operator() {
  const keyHex = need(asMaker ? "MAKER_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY").replace(/^0x/, "");
  const key = PrivateKey.fromStringECDSA(keyHex);
  let accountId = asMaker ? process.env.MAKER_ACCOUNT_ID : process.env.DEPLOYER_ACCOUNT_ID;
  if (!accountId) {
    const evm = `0x${key.publicKey.toEvmAddress()}`;
    const res = await fetch(`${MIRROR}/api/v1/accounts/${evm}`);
    if (!res.ok) throw new Error(`mirror has no account for ${evm} (${res.status})`);
    accountId = (await res.json()).account;
  }
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), key);
  return client;
}

if (cmd === "create-topic") {
  const client = await operator();
  const resp = await new TopicCreateTransaction().setTopicMemo(args[0] || "Backstop quote board").execute(client);
  const receipt = await resp.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error(`topic create status ${receipt.status}`);
  console.log(JSON.stringify({ topicId: receipt.topicId.toString(), txId: resp.transactionId.toString() }));
  client.close();
} else if (cmd === "submit") {
  const [topicId, message] = args;
  if (!topicId || !message) throw new Error("usage: hcs.mjs submit <topicId> <json> [--as maker]");
  const client = await operator();
  const resp = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(topicId)).setMessage(message).execute(client);
  const receipt = await resp.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error(`submit status ${receipt.status}`);
  console.log(
    JSON.stringify({ topicId, sequence: receipt.topicSequenceNumber.toString(), txId: resp.transactionId.toString() }),
  );
  client.close();
} else {
  console.error("usage: hcs.mjs create-topic [memo] | submit <topicId> <json> [--as maker]");
  process.exit(2);
}
