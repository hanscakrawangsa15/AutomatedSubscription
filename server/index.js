require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

const PORT = process.env.NOTIFY_PORT || 4000;
const DATA_FILE = path.join(__dirname, "subscribers.json");

function loadSubscribers() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSubscribers(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// TRON base58check addresses: 'T' + 33 base58 chars. Case-sensitive, unlike
// EVM hex addresses — must NOT be lowercased, that would corrupt the address.
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

// Returns the canonical storage key for a wallet address, or null if the
// address matches neither known chain's format. EVM addresses are
// case-insensitive so we normalize to lowercase; TRON addresses are
// case-sensitive base58 and are stored exactly as given.
function normalizeAddress(address) {
  if (typeof address !== "string") return null;
  if (EVM_ADDRESS_RE.test(address)) return address.toLowerCase();
  if (TRON_ADDRESS_RE.test(address)) return address;
  return null;
}

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/subscribers", (req, res) => {
  const { address, email } = req.body || {};
  const key = normalizeAddress(address);
  if (!key) {
    return res.status(400).json({ error: "invalid address" });
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "invalid email" });
  }

  const data = loadSubscribers();
  data[key] = email;
  saveSubscribers(data);

  console.log(`Registered ${address} -> ${email}`);
  res.json({ ok: true });
});

app.get("/api/subscribers/:address", (req, res) => {
  const key = normalizeAddress(req.params.address);
  if (!key) {
    return res.status(400).json({ error: "invalid address" });
  }
  const data = loadSubscribers();
  const email = data[key];
  res.json({ email: email || null });
});

app.listen(PORT, () => {
  console.log(`Notification server listening on http://localhost:${PORT}`);
});
