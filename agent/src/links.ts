import type { Address } from "viem";

/** The entity number behind a long-zero EVM address (every HTS token and system contract), or null for an alias. */
export function entityNum(address: string): number | null {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex) || !/^0{24}/.test(hex)) return null;
  return Number(BigInt(`0x${hex.slice(24)}`));
}

/** 0.0.N for a long-zero address, otherwise the address itself (HashScan and the mirror node resolve both). */
export const entityRef = (address: string) => {
  const num = entityNum(address);
  return num === null ? address : `0.0.${num}`;
};

/** `0.0.123@1700000000.000000001` (SDK) to `0.0.123-1700000000-000000001` (mirror node and HashScan). */
export function mirrorTxId(sdkId: string): string {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(sdkId);
  if (!match) throw new Error(`not a Hedera transaction id: ${sdkId}`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export type Links = ReturnType<typeof linkBuilder>;

export function linkBuilder(hashscanUrl: string, mirrorUrl: string) {
  return {
    tx: (idOrHash: string) => `${hashscanUrl}/transaction/${idOrHash.includes("@") ? mirrorTxId(idOrHash) : idOrHash}`,
    contract: (address: Address) => `${hashscanUrl}/contract/${address}`,
    token: (address: string) => `${hashscanUrl}/token/${entityRef(address)}`,
    account: (idOrAddress: string) => `${hashscanUrl}/account/${idOrAddress}`,
    schedule: (address: string) => `${hashscanUrl}/schedule/${entityRef(address)}`,
    topic: (topicId: string) => `${hashscanUrl}/topic/${topicId}`,
    topicMessage: (topicId: string, sequence: number | string) => `${mirrorUrl}/api/v1/topics/${topicId}/messages/${sequence}`,
  };
}
