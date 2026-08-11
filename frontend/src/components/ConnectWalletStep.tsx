type ConnectWalletStepProps = {
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
};

export function ConnectWalletStep({ connecting, error, onConnect }: ConnectWalletStepProps) {
  return (
    <section className="checkout-step">
      <h2>Connect your wallet</h2>
      <p className="muted">
        Browser extensions, mobile wallets via QR, Coinbase Wallet, and more — pick whichever you use.
      </p>

      <div className="row connect-wallet-actions">
        <button onClick={onConnect} disabled={connecting}>
          {connecting ? "Opening wallet options..." : "Connect Wallet"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
