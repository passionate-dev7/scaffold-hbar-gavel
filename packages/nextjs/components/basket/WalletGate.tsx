import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useWalletReady } from "~~/hooks/basket/useTx";

/** Shown in place of a panel's action when the wallet cannot send yet: not connected, or on another chain. */
export function WalletGate({
  ready,
  children,
}: {
  ready: ReturnType<typeof useWalletReady>;
  children: React.ReactNode;
}) {
  if (!ready.isConnected) {
    return (
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button type="button" className="btn btn-primary w-full" onClick={openConnectModal}>
            Connect a wallet
          </button>
        )}
      </ConnectButton.Custom>
    );
  }
  if (!ready.onTarget) {
    return (
      <button
        type="button"
        className="btn btn-primary w-full"
        onClick={ready.switchToTarget}
        disabled={ready.switching}
      >
        Switch to Hedera Testnet
      </button>
    );
  }
  return <>{children}</>;
}
