// Shared Resend HTTP client — used by both scripts/keeper.js (renewal
// receipts) and server/index.js (subscription-confirmation emails) so the
// actual API call/error handling lives in exactly one place.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";

let warnedNoApiKey = false;

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    if (!warnedNoApiKey) {
      console.warn("RESEND_API_KEY not set — skipping email notifications (see .env.example)");
      warnedNoApiKey = true;
    }
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    if (!res.ok) {
      console.error(`Email send failed (${res.status}):`, await res.text());
      return false;
    }
    console.log(`Email sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error("Email send failed:", err.message);
    return false;
  }
}

module.exports = { sendEmail };
