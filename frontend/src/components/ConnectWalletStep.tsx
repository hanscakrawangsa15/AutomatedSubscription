type ConnectWalletStepProps = {
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
  description?: string;
  connectingLabel?: string;
  connectLabel?: string;
};

export function ConnectWalletStep({
  connecting,
  error,
  onConnect,
  description = "Browser extensions, mobile wallets via QR, Coinbase Wallet, and more — pick whichever you use.",
  connectingLabel = "Opening wallet options...",
  connectLabel = "Connect Wallet",
}: ConnectWalletStepProps) {
  return (
    <section className="checkout-step">
      <h2>Connect your wallet</h2>
      <p className="muted">{description}</p>

      <div className="row connect-wallet-actions">
        <button onClick={onConnect} disabled={connecting}>
          {connecting ? connectingLabel : connectLabel}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
