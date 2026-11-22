import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import "dotenv/config";
import "express-async-errors"; // must load before routes — lets thrown errors in
// async handlers reach the error middleware below instead of hanging forever.

import authRoutes from "./routes/auth.js";
import hostelRoutes from "./routes/hostels.js";
import bookingRoutes from "./routes/bookings.js";
import paymentRoutes from "./routes/payments.js";
import waitlistRoutes from "./routes/waitlist.js";
import managerRoutes from "./routes/manager.js";
import adminRoutes from "./routes/admin.js";
import crypto from "crypto";
import { startReminderJobs, runAllJobs } from "./services/reminders.js";

const app = express();

// Render (and most hosts) sit behind a reverse proxy. Without this,
// express-rate-limit and req.ip both see the proxy's IP for every request
// instead of the real client — rate limiting would then treat every visitor
// as the same person.
app.set("trust proxy", 1);

app.use(helmet());

// In dev, allow any localhost port (Vite sometimes picks 5174+ if 5173 is
// busy). In production, only the deployed frontend's real URL is allowed —
// set FRONTEND_URL in .env once you know it (e.g. https://staynex.vercel.app).
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      const isLocalDev = !origin || /^http:\/\/localhost:\d+$/.test(origin);
      if (isLocalDev || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  })
);

// Caps request body size — nothing this app sends legitimately needs more
// than a fraction of this, so it's a cheap guard against oversized payloads.
// Paystack's webhook signature is an HMAC over the exact raw bytes, so this
// one route must be parsed as a Buffer BEFORE the global JSON parser runs.
app.use("/api/payments/webhook", express.raw({ type: "application/json", limit: "200kb" }));
app.use(express.json({ limit: "200kb" }));

// Auth endpoints get their own, tighter limit — this is where credential
// stuffing / brute-force login attempts would land.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// A looser baseline for everything else, mainly to blunt scripted abuse
// rather than to constrain normal browsing/booking traffic.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Render's free tier puts the service to sleep, and in-process cron doesn't
 * run while asleep. Point a free external pinger (e.g. cron-job.org, every
 * 10-15 min) at this endpoint with the x-cron-secret header: it wakes the
 * server AND runs the hold sweep, waitlist expiry and reminders. All jobs are
 * idempotent, so overlap with the internal cron is harmless.
 */
app.post("/api/internal/run-jobs", async (req, res) => {
  const secret = process.env.CRON_SECRET || "";
  const given = String(req.headers["x-cron-secret"] || "");
  const ok = secret.length >= 16 && given.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  await runAllJobs();
  res.json({ ok: true });
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/admin", generalLimiter, adminRoutes);
app.use("/api/hostels", generalLimiter, hostelRoutes);
app.use("/api/bookings", generalLimiter, bookingRoutes);
app.use("/api/payments", generalLimiter, paymentRoutes);
app.use("/api/waitlist", generalLimiter, waitlistRoutes);
app.use("/api/manager", generalLimiter, managerRoutes);

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// Central error handler — keeps stack traces out of API responses.
app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") return res.status(403).json({ error: "Origin not allowed" });
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "That file is too large." });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  // Never leak internals (SQL errors, stack hints) on a 500.
  res.status(status).json({
    error: status >= 500 && !err.expose ? "Something went wrong. Please try again." : err.message,
    ...(err.detail ? { detail: err.detail } : {}),
  });
});

export default app;

// Tests import the app without binding a port or starting cron.
if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`StayNex API running on port ${PORT}`);
    startReminderJobs();
  });
}
