import { useEffect, useState } from "react";
import "./App.css";
import { adminLogin, adminLogout, adminMe, adminFetchSubscribers, type SubscriberRow } from "./lib/adminApi";

const PAGE_SIZE = 50;

const EXPLORER_TX_BASE: Record<string, string> = {
  "ethereum-mainnet": "https://etherscan.io/tx/",
  "bnb-mainnet": "https://bscscan.com/tx/",
  "base-mainnet": "https://basescan.org/tx/",
};

function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await adminLogin(username, password);
    setBusy(false);
    if (result.ok) onLoggedIn();
    else setError(result.error ?? "Login failed");
  };

  return (
    <section className="checkout-step" style={{ maxWidth: 380, margin: "60px auto" }}>
      <h2>Admin login</h2>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="admin-username">
          Username
        </label>
        <input
          id="admin-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <label className="field-label" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !username || !password} style={{ width: "100%", marginTop: 16 }}>
          {busy ? "Logging in..." : "Log in"}
        </button>
      </form>
    </section>
  );
}

function SubscribersTable({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [rows, setRows] = useState<SubscriberRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminFetchSubscribers({ page, pageSize: PAGE_SIZE, search: search.trim() || undefined }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setRows(result.data.rows);
        setTotal(result.data.total);
      } else {
        setError(result.error);
        if (result.unauthorized) onLoggedOut();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [page, search, onLoggedOut]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="checkout-step" style={{ maxWidth: "100%" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Subscribers ({total})</h2>
        <button
          className="secondary"
          onClick={async () => {
            await adminLogout();
            onLoggedOut();
          }}
        >
          Log out
        </button>
      </div>

      <input
        placeholder="Search by wallet address or email..."
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        style={{ width: "100%", margin: "16px 0" }}
      />

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="muted">No subscribers found.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="plans-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Chain</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Traffic source</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.wallet_address}:${r.chain_name}`}>
                  <td title={r.wallet_address}>{short(r.wallet_address)}</td>
                  <td>{r.chain_name}</td>
                  <td>{r.email ?? "—"}</td>
                  <td>
                    {r.plan_label ?? "—"} {r.plan_id !== null ? `(#${r.plan_id})` : ""}
                  </td>
                  <td>{r.traffic_source ?? "—"}</td>
                  <td>
                    {r.tx_hash ? (
                      EXPLORER_TX_BASE[r.chain_name] ? (
                        <a href={`${EXPLORER_TX_BASE[r.chain_name]}${r.tx_hash}`} target="_blank" rel="noreferrer">
                          {short(r.tx_hash)}
                        </a>
                      ) : (
                        short(r.tx_hash)
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
        <button className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span className="muted">
          Page {page} of {totalPages}
        </span>
        <button className="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </section>
  );
}

export function AdminApp() {
  const [checking, setChecking] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    adminMe().then((result) => {
      setLoggedIn(result.loggedIn);
      setChecking(false);
    });
  }, []);

  return (
    <div className="app">
      <header className="wallet-bar">
        <div className="wallet-bar__title">
          <h1>Admin</h1>
        </div>
      </header>
      <main className="admin-main">
        {checking ? (
          <p className="muted centered">Checking session...</p>
        ) : loggedIn ? (
          <SubscribersTable onLoggedOut={() => setLoggedIn(false)} />
        ) : (
          <LoginForm onLoggedIn={() => setLoggedIn(true)} />
        )}
      </main>
    </div>
  );
}
