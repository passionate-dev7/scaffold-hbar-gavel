import type { AssociationState } from "~~/hooks/desk/useAssociations";

/** Shown when the mirror node could not say whether the account is associated. Never read as "associated". */
export const AssociationWarning = ({ state }: { state: AssociationState | undefined }) => {
  if (state?.kind !== "unknown") return null;
  return (
    <p className="m-0 text-sm text-warn" role="alert">
      [!]{" "}
      {state.noAccount
        ? "This address has no Hedera account yet. Send it some testnet HBAR first, then check again. "
        : "Could not read your token associations from the mirror node. "}
      <button type="button" className="link" onClick={state.retry}>
        Retry
      </button>
    </p>
  );
};
