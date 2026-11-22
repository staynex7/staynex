import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { signAdminToken } from "../utils/jwt.js";

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BCRYPT_COST = 12;

// Tight limit on the admin sign-in specifically (brute-force target).
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: "Too many admin sign-in attempts. Try again in 15 minutes." },
});

// Compared against when the email is unknown, so response time doesn't reveal which emails are admins.
let dummyHash;
const getDummyHash = () => (dummyHash ||= bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), BCRYPT_COST));

router.post("/login", adminLoginLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const admin = email ? (await query("SELECT * FROM admins WHERE email = $1", [email])).rows[0] : null;
  const ok = await bcrypt.compare(password, admin?.password_hash || getDummyHash());
  if (!admin || !ok) return res.status(401).json({ error: "Invalid admin credentials" });

  await query("UPDATE admins SET last_login_at = now() WHERE id = $1", [admin.id]);
  res.json({ token: signAdminToken(admin), admin: { id: admin.id, email: admin.email, name: admin.name } });
});

// Everything below requires a valid admin token.
router.use(requireAdmin);

router.get("/me", (req, res) => res.json(req.admin));

router.get("/stats", async (req, res) => {
  const row = (await query(
    `SELECT
       (SELECT count(*) FROM users WHERE role = 'student')::int AS students,
       (SELECT count(*) FROM users WHERE role = 'manager')::int AS managers,
       (SELECT count(*) FROM hostels)::int AS hostels,
       (SELECT count(*) FROM hostels WHERE verified)::int AS verified_hostels,
       (SELECT count(*) FROM beds)::int AS beds,
       (SELECT count(*) FROM beds WHERE status = 'available')::int AS open_beds,
       (SELECT count(*) FROM bookings WHERE status IN ('deposit_paid', 'balance_paid'))::int AS active_bookings,
       (SELECT COALESCE(sum(service_fee), 0) FROM bookings WHERE status <> 'pending_payment')::float AS service_fees,
       (SELECT count(*) FROM payments WHERE status = 'needs_review' AND resolved_at IS NULL)::int AS payments_to_review`
  )).rows[0];
  res.json(row);
});

/** Hostels for verification. ?status=pending|verified (default: all), pending first. */
router.get("/hostels", async (req, res) => {
  const { status } = req.query;
  const where = status === "pending" ? "WHERE NOT h.verified" : status === "verified" ? "WHERE h.verified" : "";
  const result = await query(
    `SELECT h.id, h.name, h.area, h.gender_policy, h.verified, h.created_at,
            u.name AS manager_name, u.email AS manager_email, u.phone AS manager_phone,
            (h.paystack_subaccount_code IS NOT NULL) AS payments_connected,
            (SELECT count(*) FROM rooms r WHERE r.hostel_id = h.id)::int AS rooms,
            (SELECT count(*) FROM beds b JOIN rooms r ON r.id = b.room_id WHERE r.hostel_id = h.id)::int AS beds,
            (SELECT count(*) FROM media m WHERE m.hostel_id = h.id OR m.room_id IN (SELECT id FROM rooms WHERE hostel_id = h.id))::int AS photos
     FROM hostels h JOIN users u ON u.id = h.manager_id
     ${where}
     ORDER BY h.verified, h.created_at DESC`
  );
  res.json(result.rows);
});

router.patch("/hostels/:id/verify", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Hostel not found" });
  const verified = req.body?.verified !== false;
  const result = await query("UPDATE hostels SET verified = $1 WHERE id = $2 RETURNING id, name, verified", [verified, req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: "Hostel not found" });
  res.json(result.rows[0]);
});

/** Successful payments we couldn't apply automatically. ?resolved=true shows handled ones. */
router.get("/payments/needs-review", async (req, res) => {
  const resolved = req.query.resolved === "true";
  const result = await query(
    `SELECT p.reference, p.kind, p.principal_amount, p.review_reason, p.created_at, p.resolved_at, p.resolution_note,
            u.name, u.phone, u.email
     FROM payments p JOIN users u ON u.id = p.student_id
     WHERE p.status = 'needs_review' AND (p.resolved_at IS NOT NULL) = $1
     ORDER BY p.created_at DESC`,
    [resolved]
  );
  res.json(result.rows);
});

router.post("/payments/:reference/resolve", async (req, res) => {
  const note = String(req.body?.note || "").trim().slice(0, 500);
  if (note.length < 3) return res.status(400).json({ error: "Add a short note (e.g. 'refunded via Paystack')." });
  const result = await query(
    `UPDATE payments SET resolved_at = now(), resolution_note = $2
     WHERE reference = $1 AND status = 'needs_review' AND resolved_at IS NULL RETURNING reference`,
    [req.params.reference, note]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Payment not found or already resolved" });
  res.json({ ok: true });
});

router.get("/bookings", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const result = await query(
    `SELECT bo.id, bo.status, bo.deposit_amount, bo.balance_amount, bo.service_fee, bo.balance_due_date, bo.created_at,
            u.name AS student_name, u.phone AS student_phone, h.name AS hostel_name, r.room_code
     FROM bookings bo
     JOIN users u ON u.id = bo.student_id
     JOIN beds be ON be.id = bo.bed_id
     JOIN rooms r ON r.id = be.room_id
     JOIN hostels h ON h.id = r.hostel_id
     ORDER BY bo.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json(result.rows);
});

router.post("/change-password", async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== "string" || newPassword.length < 12) {
    return res.status(400).json({ error: "New password must be at least 12 characters." });
  }
  const admin = (await query("SELECT password_hash FROM admins WHERE id = $1", [req.admin.id])).rows[0];
  if (!(await bcrypt.compare(String(currentPassword || ""), admin.password_hash))) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  await query("UPDATE admins SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(newPassword, BCRYPT_COST), req.admin.id]);
  res.json({ ok: true });
});

export default router;
