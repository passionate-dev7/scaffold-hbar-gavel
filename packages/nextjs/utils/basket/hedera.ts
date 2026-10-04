/**
 * Entity id behind a long-zero EVM address: 4 bytes shard, 8 bytes realm, 8 bytes number.
 * Holds for HTS tokens and schedules, not for ECDSA-aliased accounts.
 */
export function evmToEntityId(address: string): string {
  const n = BigInt(address);
  const num = n & ((1n << 64n) - 1n);
  const realm = (n >> 64n) & ((1n << 64n) - 1n);
  const shard = n >> 128n;
  return `${shard}.${realm}.${num}`;
}

const HASHSCAN = "https://hashscan.io/testnet";

export const hashscan = {
  tx: (hash: string) => `${HASHSCAN}/transaction/${hash}`,
  contract: (address: string) => `${HASHSCAN}/contract/${address}`,
  account: (address: string) => `${HASHSCAN}/account/${address}`,
  token: (address: string) => `${HASHSCAN}/token/${evmToEntityId(address)}`,
  schedule: (address: string) => `${HASHSCAN}/schedule/${evmToEntityId(address)}`,
};
