import { getChainName, isMainnetChain, IS_MAINNET_MODE } from "../lib/chains";

type WalletBarProps = {
  account: string | null;
  chainId: bigint | null;
  onDisconnect: () => void;
  onSwitchMode?: (targetMainnet: boolean) => void;
  switchingMode?: boolean;
};

function shorten(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletBar({ account, chainId, onDisconnect, onSwitchMode, switchingMode }: WalletBarProps) {
  // Reflects the actual connected chain when there is one (dev mode offers
  // both testnet and mainnet chains together, so the build-time flag alone
  // isn't accurate once connected) — falls back to the build flag before a
  // wallet connects, since there's no chain to read yet at that point.
  const isMainnet = chainId !== null ? isMainnetChain(chainId) : IS_MAINNET_MODE;
  return (
    <header className="wallet-bar">
      <div className="wallet-bar__title">
        <h1>Subscribe</h1>
        {onSwitchMode ? (
          <div className="mode-toggle">
            <button className={!isMainnet ? "active" : ""} onClick={() => onSwitchMode(false)} disabled={switchingMode || !isMainnet}>
              Testnet
            </button>
            <button
              className={isMainnet ? "active mode-toggle__mainnet" : ""}
              onClick={() => onSwitchMode(true)}
              disabled={switchingMode || isMainnet}
            >
              Mainnet
            </button>
          </div>
        ) : (
          <span className={`mode-badge ${isMainnet ? "mode-badge--mainnet" : "mode-badge--testnet"}`}>
            {isMainnet ? "Mainnet · real funds" : "Testnet"}
          </span>
        )}
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
