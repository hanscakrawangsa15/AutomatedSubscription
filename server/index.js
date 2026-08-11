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

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/subscribers", (req, res) => {
  const { address, email } = req.body || {};
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "invalid address" });
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "invalid email" });
  }

  const data = loadSubscribers();
  data[address.toLowerCase()] = email;
  saveSubscribers(data);

  console.log(`Registered ${address} -> ${email}`);
  res.json({ ok: true });
});

app.get("/api/subscribers/:address", (req, res) => {
  const data = loadSubscribers();
  const email = data[req.params.address.toLowerCase()];
  res.json({ email: email || null });
});

app.listen(PORT, () => {
  console.log(`Notification server listening on http://localhost:${PORT}`);
});
