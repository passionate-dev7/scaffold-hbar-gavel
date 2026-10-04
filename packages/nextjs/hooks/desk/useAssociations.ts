import { useQueries } from "@tanstack/react-query";
import type { Address } from "viem";
import { type Association, MirrorError, fetchAssociation } from "~~/utils/desk/mirror";

export type AssociationState =
  | { kind: "no-account" }
  | { kind: "checking" }
  | { kind: "unknown"; retry: () => void; noAccount: boolean }
  | { kind: Association };

/** Per-token association of `account`, read from the mirror node. A failed lookup is "unknown", never "associated". */
export function useAssociations(account: Address | undefined, tokens: readonly Address[]) {
  const results = useQueries({
    queries: tokens.map(token => ({
      queryKey: ["desk", "assoc", account, token],
      enabled: !!account,
      staleTime: 10_000,
      retry: 1,
      queryFn: () => fetchAssociation(account!, token),
    })),
  });
  return results.map((r, i): { token: Address; state: AssociationState } => {
    const token = tokens[i];
    if (!account) return { token, state: { kind: "no-account" } };
    if (r.isError)
      return {
        token,
        state: {
          kind: "unknown",
          retry: () => void r.refetch(),
          noAccount: r.error instanceof MirrorError && r.error.status === 404,
        },
      };
    if (r.data === undefined) return { token, state: { kind: "checking" } };
    return { token, state: { kind: r.data } };
  });
}

export const needsAssociation = (state: AssociationState) => state.kind === "needs";
export const associationKnown = (state: AssociationState) =>
  state.kind === "associated" || state.kind === "auto" || state.kind === "needs";
