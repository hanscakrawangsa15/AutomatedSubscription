const NOTIFY_API_URL = import.meta.env.VITE_NOTIFY_API_URL || "http://localhost:4000";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Registers an address -> email mapping with the local notification server
 * so the keeper can send renewal receipts. Best-effort: failures are
 * swallowed so a missing/offline notify server never blocks subscribing.
 */
export async function registerNotificationEmail(address: string, email: string): Promise<boolean> {
  try {
    const res = await fetch(`${NOTIFY_API_URL}/api/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, email }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
