import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { QUOTE_TYPES, assessQuote, bpsOver, parseQuote, sortQuotes, verifyQuote } from "./quotes.ts";

const DOMAIN = {
  name: "Gavel",
  version: "1",
  chainId: 296,
  verifyingContract: "0x659380d965EE890fD93bf36C537dAd80ee76F73C",
};

// Message 4 of HCS topic 0.0.10861214 exactly as the mirror node served it.
const LIVE = {"sequence":1,"consensusTimestamp":"1791141700.859219104","message":"eyJvcmRlcklkIjoiMSIsIm1ha2VyIjoiMHg5Q2FkNjc4ZjdEOTcwYWZlMEI5NzM2QmFlMDM2ODc3MjU1YTlkQTg0IiwiYW1vdW50T3V0IjoiNTUyNTUyNSIsImRlYWRsaW5lIjoiMTc5MTE0MjI5OCIsIm5vbmNlIjoiMTc5MTE0MTY5OCIsInNpZ25hdHVyZSI6IjB4ZTY1YmZjZjQxOTZmNzhhYTI1MGNmNWUyODc4ZDg3ZDMwZjRlYmQ4YTJlNzA2NTU3OTk1YmQyODVmNDE2YTM0ZTA4ZmQxNTcyNGVjNTM1MGZmM2M0YWEyMjg0YzllZTk0OTNiZGNlNTc0NTQzOTA1NWRhOGViNTNjNGVlMGRhOTgxYyJ9"};

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64");
const asMessage = (obj, sequence = 1) => ({ sequence, consensusTimestamp: "1791141700.859219104", message: b64(obj) });

test("a live topic message parses and its signature recovers to the maker under the desk domain", async () => {
  const q = parseQuote(LIVE);
  assert.ok(q);
  assert.equal(q.orderId, 1n);
  assert.equal(await verifyQuote(q, DOMAIN), true);
});

test("the live message fails verification the moment any signed field, or the domain, changes", async () => {
  const q = parseQuote(LIVE);
  assert.equal(await verifyQuote({ ...q, amountOut: q.amountOut + 1n }, DOMAIN), false);
  assert.equal(await verifyQuote({ ...q, orderId: 4n }, DOMAIN), false);
  assert.equal(await verifyQuote({ ...q, nonce: q.nonce + 1n }, DOMAIN), false);
  assert.equal(await verifyQuote(q, { ...DOMAIN, chainId: 295 }), false);
  assert.equal(await verifyQuote(q, { ...DOMAIN, verifyingContract: "0x0000000000000000000000000000000000000001" }), false);
});

test("a quote signed by someone other than the stated maker is rejected", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const claimed = privateKeyToAccount(generatePrivateKey());
  const message = { orderId: 7n, maker: claimed.address, amountOut: 1_850_000n, deadline: 1_790_000_000n, nonce: 7n };
  const signature = await signer.signTypedData({ domain: DOMAIN, types: QUOTE_TYPES, primaryType: "Quote", message });
  const wire = { orderId: "7", maker: claimed.address, amountOut: "1850000", deadline: "1790000000", nonce: "7", signature };
  assert.equal(await verifyQuote(parseQuote(asMessage(wire)), DOMAIN), false);
  const honest = await claimed.signTypedData({ domain: DOMAIN, types: QUOTE_TYPES, primaryType: "Quote", message });
  assert.equal(await verifyQuote(parseQuote(asMessage({ ...wire, signature: honest })), DOMAIN), true);
});

test("malformed topic messages are dropped, not guessed at", () => {
  const good = { orderId: "1", maker: "0x9Cad678f7D970afe0B9736Bae036877255a9dA84", amountOut: "5", deadline: "9", nonce: "1", signature: "0x" + "ab".repeat(65) };
  assert.ok(parseQuote(asMessage(good)));
  for (const bad of [
    { ...good, amountOut: 5 },
    { ...good, amountOut: "-5" },
    { ...good, amountOut: "0x5" },
    { ...good, maker: "0x1234" },
    { ...good, signature: "0x" + "ab".repeat(64) },
    { ...good, nonce: undefined },
  ])
    assert.equal(parseQuote(asMessage(bad)), null);
  assert.equal(parseQuote({ sequence: 1, consensusTimestamp: "1.0", message: "not base64 json" }), null);
  assert.equal(parseQuote({ sequence: 1, consensusTimestamp: "1.0", message: Buffer.from("[1]").toString("base64") }), null);
});

test("verdicts follow the contract's check order", () => {
  const ctx = { nowSec: 100, minOut: 50n, oracleFloor: 40n };
  const ok = { signatureOk: true, nonceSpent: false, funded: true };
  const q = { amountOut: 60n, deadline: 200n };
  assert.equal(assessQuote(q, ok, ctx), "live");
  assert.equal(assessQuote(q, { ...ok, signatureOk: false, nonceSpent: true }, ctx), "bad-signature");
  assert.equal(assessQuote(q, { ...ok, nonceSpent: true }, ctx), "nonce-spent");
  assert.equal(assessQuote({ ...q, deadline: 99n }, ok, ctx), "expired");
  assert.equal(assessQuote({ ...q, amountOut: 49n }, ok, ctx), "below-min");
  assert.equal(assessQuote(q, { ...ok, funded: false }, ctx), "unfunded");
  assert.equal(assessQuote({ ...q, amountOut: 55n }, ok, { ...ctx, minOut: 10n, oracleFloor: 56n }), "outside-band");
});

test("quotes sort best first and equal amounts keep the earlier consensus timestamp", () => {
  const sorted = sortQuotes([
    { amountOut: 5n, consensusTimestamp: "10.000000001" },
    { amountOut: 9n, consensusTimestamp: "20.5" },
    { amountOut: 9n, consensusTimestamp: "20.000000009" },
  ]);
  assert.deepEqual(sorted.map(q => q.consensusTimestamp), ["20.000000009", "20.5", "10.000000001"]);
  assert.equal(bpsOver(5_030_000n, 5_000_000n), 60);
  assert.equal(bpsOver(4_985_000n, 5_000_000n), -30);
  assert.equal(bpsOver(1n, 0n), null);
});
