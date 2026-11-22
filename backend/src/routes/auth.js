import express from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import crypto from "crypto";
import { query } from "../db/pool.js";
import { signToken } from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { sendPasswordResetEmail } from "../services/email.js";
import { ROOMMATE_INTERESTS, ROOMMATE_SPORTS, ROOMMATE_LIFESTYLE, ROOMMATE_RELIGIONS, pickAllowed } from "../constants/roommates.js";
import { uploadProfilePhoto, deleteRoomMedia, MAX_IMAGE_BYTES } from "../services/cloudinaryMedia.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });

const GHANA_PHONE_RE = /^(\+233|0)[2357][0-9]{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/signup", async (req, res) => {
  const { role, name, phone, password, gender } = req.body;
  if (typeof password !== "string" || typeof phone !== "string") {
    return res.status(400).json({ error: "Phone and password are required" });
  }
  const email = (req.body.email || "").trim().toLowerCase();

  if (!["student", "manager"].includes(role)) {
    return res.status(400).json({ error: "Role must be 'student' or 'manager'" });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (!GHANA_PHONE_RE.test(phone)) {
    return res.status(400).json({ error: "Enter a valid Ghana phone number, e.g. 024xxxxxxx" });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  // Only required for students — this is what lets us enforce a hostel's
  // gender policy and stop opposite genders being placed in the same room.
  // Managers don't need it.
  if (role === "student" && !["male", "female"].includes(gender)) {
    return res.status(400).json({ error: "Select male or female" });
  }

  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (role, name, email, phone, password_hash, gender)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, role, name, email, phone, gender`,
    [role, name.trim(), email, phone, passwordHash, role === "student" ? gender : null]
  );

  const user = result.rows[0];
  res.status(201).json({ user, token: signToken(user) });
});

router.post("/login", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const { password } = req.body;
  if (typeof password !== "string" || !password) {
    return res.status(401).json({ error: "Incorrect email or password" });
  }
  const result = await query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Incorrect email or password" });
  }

  const { password_hash, is_admin, ...safeUser } = user;
  res.json({ user: safeUser, token: signToken(user) });
});

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

/**
 * Always answers the same way whether or not the email exists, so this can't
 * be used to find out who has an account. The token is random, single-use,
 * expires in an hour, and only its hash is stored.
 */
router.post("/forgot-password", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const generic = { message: "If an account exists for that email, a reset link is on its way." };

  const user = (await query("SELECT id, name, email FROM users WHERE email = $1", [email])).rows[0];
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    await query("DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    await query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [user.id, sha256(token)]
    );
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0];
    try {
      await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl: `${frontendUrl}/reset-password?token=${token}` });
    } catch (err) {
      console.error("Password reset email failed:", err.message);
    }
  }
  res.json(generic);
});

router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== "string" || !token) return res.status(400).json({ error: "Reset link is invalid." });
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  // Atomically consume the token so it can only ever be used once.
  const used = await query(
    `UPDATE password_resets SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sha256(token)]
  );
  if (!used.rows.length) return res.status(400).json({ error: "This reset link is invalid or has expired." });

  const hash = await bcrypt.hash(password, 10);
  await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, used.rows[0].user_id]);
  res.json({ message: "Password updated. You can log in now." });
});

/** The logged-in student's own roommate profile (optional, opt-in). */
router.get("/roommate-profile", requireAuth, async (req, res) => {
  const row = (await query(
    "SELECT interests, sports, lifestyle, religion, share_with_roommates FROM users WHERE id = $1",
    [req.user.id]
  )).rows[0];
  res.json(row);
});

router.put("/roommate-profile", requireAuth, async (req, res) => {
  if (req.user.role !== "student") return res.status(403).json({ error: "Only students have a roommate profile." });
  const b = req.body || {};
  const religion = ROOMMATE_RELIGIONS.includes(b.religion) ? b.religion : null;
  const row = (await query(
    `UPDATE users SET interests = $1, sports = $2, lifestyle = $3, religion = $4, share_with_roommates = $5
     WHERE id = $6
     RETURNING interests, sports, lifestyle, religion, share_with_roommates`,
    [
      pickAllowed(b.interests, ROOMMATE_INTERESTS),
      pickAllowed(b.sports, ROOMMATE_SPORTS),
      pickAllowed(b.lifestyle, ROOMMATE_LIFESTYLE),
      religion,
      b.shareWithRoommates === true,
      req.user.id,
    ]
  )).rows[0];
  res.json(row);
});

/**
 * Uploads or replaces the logged-in student's profile photo. Deliberately
 * NOT part of the /signup payload itself — signup stays a plain JSON
 * request with no file handling, and this is a separate step the frontend
 * offers immediately after (skippable), same "create first, attach media
 * after" pattern already used for hostels and rooms.
 */
router.post("/profile-photo", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file was uploaded." });
  if (!req.file.mimetype.startsWith("image/")) {
    return res.status(415).json({ error: "Only images are supported for a profile photo." });
  }

  const existing = (await query("SELECT profile_photo_public_id FROM users WHERE id = $1", [req.user.id])).rows[0];

  let uploadResult;
  try {
    uploadResult = await uploadProfilePhoto(req.file.buffer);
  } catch (err) {
    return res.status(502).json({ error: "Upload to media storage failed. Please try again." });
  }
  const url = uploadResult.eager?.[0]?.secure_url || uploadResult.secure_url;

  await query(
    "UPDATE users SET profile_photo_url = $1, profile_photo_public_id = $2 WHERE id = $3",
    [url, uploadResult.public_id, req.user.id]
  );

  // Best-effort cleanup of the old photo, if replacing one — never block
  // the response on this, a stray orphaned file isn't worth failing over.
  if (existing?.profile_photo_public_id) {
    deleteRoomMedia(existing.profile_photo_public_id, "image").catch(() => {});
  }

  res.json({ profilePhotoUrl: url });
});

export default router;
