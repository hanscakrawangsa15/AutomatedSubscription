import { getChainName } from "../lib/chains";

type WalletBarProps = {
  account: string | null;
  chainId: bigint | null;
  onDisconnect: () => void;
  onConnect: () => void;
  connecting: boolean;
};

function shorten(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Always visible (every step, not just the dedicated Connect Wallet step)
// so a returning subscriber — or anyone who dismissed that step — can
// connect from wherever they happen to be, next to the page title.
export function WalletBar({ account, chainId, onDisconnect, onConnect, connecting }: WalletBarProps) {
  return (
    <header className="wallet-bar">
      <div className="wallet-bar__title">
        <h1>Subscription Plan</h1>
      </div>
      <div className="wallet-bar__actions">
        {account ? (
          <>
            <span className="pill">
              {shorten(account)} {chainId !== null && `· ${getChainName(chainId)}`}
            </span>
            <button onClick={onDisconnect} className="secondary">
              Disconnect
            </button>
          </>
        ) : (
          <button onClick={onConnect} disabled={connecting}>
            {connecting ? "Connecting..." : "Connect Wallet"}
          </button>
        )}
      </div>
    </header>
  );
}
