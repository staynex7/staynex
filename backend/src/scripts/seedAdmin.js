// Creates the platform admin from ADMIN_EMAIL / ADMIN_PASSWORD in .env.
// Usage:  npm run seed-admin            (creates it if missing)
//         npm run seed-admin -- --reset (also resets the password to the .env value)
// The password is stored hashed (bcrypt); it is never written to the codebase.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
const reset = process.argv.includes("--reset");

if (!email || password.length < 12) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in backend/.env first.");
  process.exit(1);
}

const existing = (await pool.query("SELECT id FROM admins WHERE email = $1", [email])).rows[0];
if (existing && !reset) {
  console.log(`Admin ${email} already exists. Use "npm run seed-admin -- --reset" to reset its password.`);
} else {
  const hash = await bcrypt.hash(password, 12);
  if (existing) {
    await pool.query("UPDATE admins SET password_hash = $1 WHERE id = $2", [hash, existing.id]);
    console.log(`Password reset for admin ${email}.`);
  } else {
    await pool.query("INSERT INTO admins (email, name, password_hash) VALUES ($1, 'Admin', $2)", [email, hash]);
    console.log(`Admin ${email} created.`);
  }
}
await pool.end();
