const NOTIFY_API_URL = import.meta.env.VITE_NOTIFY_API_URL || "http://localhost:4000";

export type SubscriberRow = {
  wallet_address: string;
  chain_name: string;
  chain_id: number | null;
  email: string | null;
  traffic_source: string | null;
  plan_id: number | null;
  plan_label: string | null;
  tx_hash: string | null;
  periods_paid: number | null;
  // mysql2 returns DATETIME columns as JS Date objects; Express's
  // res.json() then serializes them to ISO 8601 UTC strings.
  next_charge_at: string | null;
};

export type SubscribersPage = {
  rows: SubscriberRow[];
  total: number;
  page: number;
  pageSize: number;
};

async function parseJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// credentials: "include" on every call — the login session lives in an
// httpOnly cookie the browser manages, never touched directly by this code
// (can't be read by JS even if it wanted to, which is the point).
export async function adminLogin(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${NOTIFY_API_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, password }),
  }).catch(() => null);
  if (!res) return { ok: false, error: "Couldn't reach the server. Is it running?" };
  if (res.ok) return { ok: true };
  const body = await parseJson(res);
  return { ok: false, error: body?.error || `Login failed (${res.status})` };
}

export async function adminLogout(): Promise<void> {
  await fetch(`${NOTIFY_API_URL}/api/admin/logout`, { method: "POST", credentials: "include" }).catch(() => {});
}

export async function adminMe(): Promise<{ loggedIn: boolean; username?: string }> {
  const res = await fetch(`${NOTIFY_API_URL}/api/admin/me`, { credentials: "include" }).catch(() => null);
  if (!res || !res.ok) return { loggedIn: false };
  const body = await parseJson(res);
  return { loggedIn: true, username: body?.username };
}

export async function adminFetchSubscribers(params: {
  page: number;
  pageSize: number;
  search?: string;
}): Promise<{ ok: true; data: SubscribersPage } | { ok: false; error: string; unauthorized?: boolean }> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
    ...(params.search ? { search: params.search } : {}),
  });
  const res = await fetch(`${NOTIFY_API_URL}/api/admin/subscribers?${query}`, { credentials: "include" }).catch(
    () => null,
  );
  if (!res) return { ok: false, error: "Couldn't reach the server." };
  if (res.status === 401) return { ok: false, error: "Session expired — log in again.", unauthorized: true };
  if (!res.ok) {
    const body = await parseJson(res);
    return { ok: false, error: body?.error || `Request failed (${res.status})` };
  }
  return { ok: true, data: await res.json() };
}
