import express from "express";
import crypto from "crypto";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { settlePayment } from "../services/settlement.js";
import { httpError } from "../utils/httpError.js";

const router = express.Router();

/**
 * Browser callback after Paystack checkout. Only the reference is read from
 * the client; the ledger row decides whose payment it is, which bed or
 * booking it is for, and how much it must be. Safe to call repeatedly.
 */
function verifyHandler(expectedKind) {
  return async (req, res) => {
    const reference = req.body?.reference;
    if (typeof reference !== "string" || !reference) return res.status(400).json({ error: "reference is required" });

    const outcome = await settlePayment(reference, { studentId: req.user.id });
    if (outcome.kind !== expectedKind) throw httpError(409, "This payment reference is for a different kind of payment.");
    res.status(outcome.firstTime ? 201 : 200).json(outcome.booking);
  };
}

router.post("/verify", requireAuth, requireRole("student"), verifyHandler("deposit"));
router.post("/verify-balance", requireAuth, requireRole("student"), verifyHandler("balance"));

/**
 * Paystack -> us. This is what makes a payment count even if the student
 * closes the tab before the callback page loads. The body arrives RAW (see
 * server.js) because the HMAC signature is computed over the exact bytes.
 */
export function isValidPaystackSignature(rawBody, signature, secret = process.env.PAYSTACK_SECRET_KEY) {
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/webhook", async (req, res) => {
  if (!isValidPaystackSignature(req.body, req.headers["x-paystack-signature"])) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Bad JSON" });
  }

  if (event.event === "charge.success" && event.data?.reference) {
    try {
      await settlePayment(event.data.reference);
    } catch (err) {
      // 4xx = permanent (unknown reference, flagged for review): acknowledge so
      // Paystack stops retrying. Anything else is transient: 500 so it retries.
      if (err.status && err.status < 500) {
        console.error(`Webhook for ${event.data.reference} not applied: ${err.message}`);
      } else {
        console.error("Webhook settlement failed, asking Paystack to retry:", err);
        return res.status(500).json({ error: "retry" });
      }
    }
  }
  res.sendStatus(200);
});

export default router;
