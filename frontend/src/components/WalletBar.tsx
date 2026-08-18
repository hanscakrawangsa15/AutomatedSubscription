import { getChainName } from "../lib/chains";

type WalletBarProps = {
  account: string | null;
  chainId: bigint | null;
  onDisconnect: () => void;
};

function shorten(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletBar({ account, chainId, onDisconnect }: WalletBarProps) {
  return (
    <header className="wallet-bar">
      <div className="wallet-bar__title">
        <h1>Subscribe</h1>
        <span className="mode-badge mode-badge--mainnet">Mainnet · real funds</span>
      </div>
      {account && (
        <div className="wallet-bar__actions">
          <span className="pill">
            {shorten(account)} {chainId !== null && `· ${getChainName(chainId)}`}
          </span>
          <button onClick={onDisconnect} className="secondary">
            Disconnect
          </button>
        </div>
      )}
    </header>
  );
}
