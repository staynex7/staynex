// Usage: npm run make-admin -- someone@example.com
import "dotenv/config";
import { pool } from "../db/pool.js";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.log("Usage: npm run make-admin -- someone@example.com");
  process.exit(1);
}
const res = await pool.query("UPDATE users SET is_admin = true WHERE email = $1 RETURNING email", [email]);
console.log(res.rowCount ? `✅ ${email} is now an admin.` : `No user found with email ${email}.`);
await pool.end();
