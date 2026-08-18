// Generates the bcrypt hash for ADMIN_PASSWORD_HASH in .env — run this
// yourself and paste the output into .env; the plaintext password never
// needs to be shared with anyone else this way.
//
// Usage: node scripts/hash-admin-password.js "your-password-here"
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-admin-password.js "your-password-here"');
  process.exitCode = 1;
} else {
  const hash = bcrypt.hashSync(password, 12);
  console.log("\nAdd these to .env (repo root):\n");
  console.log(`ADMIN_USERNAME=<choose a username>`);
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
}
