import express from "express";
import crypto from "crypto";
import { query, pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { initializeSplitTransaction, PAYSTACK_FEE_RATE, calculatePaystackFee } from "../services/paystack.js";
import { genderBlock } from "../services/holds.js";
import { SERVICE_FEE } from "../services/settlement.js";
import { httpError } from "../utils/httpError.js";

const router = express.Router();
const HOLD_MINUTES = 15;

/**
 * Step 1: place a 15-minute hold on a bed and return the payment breakdown.
 * The bed is NOT marked "taken" yet — only "reserved_pending" — so it
 * releases automatically if payment isn't completed.
 *
 * Runs in a transaction that locks the ROOM row, so two students can never
 * hold the same bed, or hold two beds of the same room with clashing genders,
 * at the same instant (the old check-then-update had both races).
 */
router.post("/hold", requireAuth, requireRole("student"), async (req, res) => {
  const { bedId } = req.body;
  if (typeof bedId !== "string") return res.status(400).json({ error: "bedId is required" });

  const client = await pool.connect();
  let bed, holdExpires;
  try {
    await client.query("BEGIN");

    const found = (await client.query(
      `SELECT b.id, b.room_id FROM beds b WHERE b.id = $1`, [bedId]
    )).rows[0];
    if (!found) throw httpError(404, "Bed not found");

    // Serialize everything that happens in this room.
    await client.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [found.room_id]);

    bed = (await client.query(
      `SELECT b.*, r.price_per_year, r.room_code, r.hostel_id, h.deposit_pct, h.name AS hostel_name,
              h.paystack_subaccount_code, h.gender_policy, h.verified
       FROM beds b
       JOIN rooms r ON r.id = b.room_id
       JOIN hostels h ON h.id = r.hostel_id
       WHERE b.id = $1`,
      [bedId]
    )).rows[0];

    if (!bed.verified) {
      throw httpError(403, "This hostel is awaiting StayNex verification and can't take bookings yet.");
    }

    const holdLapsed = bed.status === "reserved_pending" && new Date(bed.hold_expires_at) < new Date();
    const ownHold = bed.status === "reserved_pending" && bed.held_by === req.user.id && !holdLapsed;
    if (bed.status !== "available" && !holdLapsed && !ownHold) {
      throw httpError(409, "This bed is no longer available. It may already be held or taken.");
    }
    if (!bed.paystack_subaccount_code) {
      throw httpError(422, "This hostel hasn't finished payment setup yet — the manager needs to connect their Paystack account.");
    }

    // A waitlisted student who was texted gets first claim on freed beds.
    const claim = (await client.query(
      `SELECT 1 FROM waitlist_entries
       WHERE room_id = $1 AND student_id != $2 AND notified_at IS NOT NULL AND claim_expires_at > now() LIMIT 1`,
      [bed.room_id, req.user.id]
    )).rows[0];
    if (claim) {
      throw httpError(409, "This bed is being offered to students on the waitlist right now. Try again in a little while.");
    }

    const student = (await client.query("SELECT gender FROM users WHERE id = $1", [req.user.id])).rows[0];
    const blocked = await genderBlock(client, {
      roomId: bed.room_id, bedId: bed.id, hostelGenderPolicy: bed.gender_policy,
      studentId: req.user.id, studentGender: student.gender,
    });
    if (blocked) throw httpError(409, blocked);

    // One active hold per student: starting a new one frees any other bed
    // they were sitting on, so a single account can't lock up a hostel.
    await client.query(
      `UPDATE beds SET status = 'available', hold_expires_at = NULL, held_by = NULL
       WHERE held_by = $1 AND status = 'reserved_pending' AND id != $2`,
      [req.user.id, bed.id]
    );

    holdExpires = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
    const updated = await client.query(
      `UPDATE beds SET status = 'reserved_pending', hold_expires_at = $1, held_by = $2
       WHERE id = $3 AND (status = 'available' OR (status = 'reserved_pending' AND (held_by = $2 OR hold_expires_at < now())))`,
      [holdExpires, req.user.id, bed.id]
    );
    if (updated.rowCount !== 1) throw httpError(409, "This bed is no longer available. It may already be held or taken.");

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({
    bedId: bed.id,
    roomCode: bed.room_code,
    hostelName: bed.hostel_name,
    pricePerYear: Number(bed.price_per_year),
    minDeposit: Number(bed.price_per_year) * Number(bed.deposit_pct),
    serviceFee: SERVICE_FEE,
    paystackFeeRate: PAYSTACK_FEE_RATE,
    holdExpiresAt: holdExpires,
  });
});

/**
 * Step 2: initialize the Paystack transaction for the held bed. Students can
 * pay any amount from the hostel's minimum deposit up to the full room price.
 *
 * Everything security-relevant is decided HERE on the server and recorded in
 * the payments ledger: the reference is generated by us, the subaccount is
 * read from the bed's hostel (never from the request), and the bed must be
 * actively held by this student.
 */
router.post("/initialize-payment", requireAuth, requireRole("student"), async (req, res) => {
  const { bedId, payAmount } = req.body;

  const bed = (await query(
    `SELECT b.id, b.status, b.hold_expires_at, b.held_by, r.price_per_year, h.deposit_pct, h.paystack_subaccount_code
     FROM beds b JOIN rooms r ON r.id = b.room_id JOIN hostels h ON h.id = r.hostel_id
     WHERE b.id = $1`,
    [bedId]
  )).rows[0];
  if (!bed || bed.status !== "reserved_pending" || bed.held_by !== req.user.id || new Date(bed.hold_expires_at) < new Date()) {
    return res.status(409).json({ error: "Your hold has expired. Please reserve the bed again." });
  }
  if (!bed.paystack_subaccount_code) {
    return res.status(422).json({ error: "This hostel hasn't finished payment setup yet." });
  }

  const pricePerYear = Number(bed.price_per_year);
  const minDeposit = pricePerYear * Number(bed.deposit_pct);
  const amount = Math.round(Number(payAmount) * 100) / 100;

  if (!Number.isFinite(amount) || amount < minDeposit - 0.01 || amount > pricePerYear + 0.01) {
    return res.status(422).json({
      error: `Payment amount must be between ${minDeposit.toFixed(2)} and ${pricePerYear.toFixed(2)} GHS.`,
    });
  }

  const subtotal = amount + SERVICE_FEE;
  const paystackFee = calculatePaystackFee(subtotal);
  const total = subtotal + paystackFee;
  const reference = `BRG-${crypto.randomBytes(8).toString("hex")}`;
  const student = (await query("SELECT email FROM users WHERE id = $1", [req.user.id])).rows[0];

  await query(
    `INSERT INTO payments (reference, kind, student_id, bed_id, principal_amount, expected_total_pesewas)
     VALUES ($1, 'deposit', $2, $3, $4, $5)`,
    [reference, req.user.id, bed.id, amount, Math.round(total * 100)]
  );

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0];
  const paystackData = await initializeSplitTransaction({
    email: student.email,
    amountGHS: total,
    depositGHS: amount,
    subaccountCode: bed.paystack_subaccount_code,
    reference,
    metadata: { bedId: bed.id, studentId: req.user.id },
    callbackUrl: `${frontendUrl}/payment-callback`,
  });

  res.json(paystackData);
});

/**
 * Initialize payment for the REMAINING balance on an existing booking — not
 * a new deposit. No new StayNex service fee here (that was already charged
 * at deposit time); this is a pure pass-through to the manager, with only
 * Paystack's own processing fee added transparently, same gross-up logic
 * as the deposit flow.
 */
router.post("/initialize-balance-payment", requireAuth, requireRole("student"), async (req, res) => {
  const { bookingId } = req.body;

  const bookingResult = await query(
    `SELECT bo.*, h.paystack_subaccount_code
     FROM bookings bo
     JOIN beds be ON be.id = bo.bed_id
     JOIN rooms r ON r.id = be.room_id
     JOIN hostels h ON h.id = r.hostel_id
     WHERE bo.id = $1 AND bo.student_id = $2`,
    [bookingId, req.user.id]
  );
  const booking = bookingResult.rows[0];
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  if (booking.status !== "deposit_paid") {
    return res.status(409).json({ error: "This booking isn't awaiting a balance payment." });
  }

  const balanceOwed = Number(booking.balance_amount);
  if (balanceOwed <= 0) {
    return res.status(409).json({ error: "There's no balance left to pay on this booking." });
  }
  const paystackFee = calculatePaystackFee(balanceOwed);
  const total = balanceOwed + paystackFee;

  const student = (await query("SELECT email FROM users WHERE id = $1", [req.user.id])).rows[0];
  const reference = `BRG-BAL-${crypto.randomBytes(8).toString("hex")}`;
  await query(
    `INSERT INTO payments (reference, kind, student_id, booking_id, principal_amount, expected_total_pesewas)
     VALUES ($1, 'balance', $2, $3, $4, $5)`,
    [reference, req.user.id, booking.id, balanceOwed, Math.round(total * 100)]
  );
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0];
  const callbackUrl = `${frontendUrl}/payment-callback?type=balance`;

  const paystackData = await initializeSplitTransaction({
    email: student.email,
    amountGHS: total,
    depositGHS: balanceOwed, // the manager's subaccount gets the full balance, untouched
    subaccountCode: booking.paystack_subaccount_code,
    reference,
    metadata: { bookingId, studentId: req.user.id, type: "balance" },
    callbackUrl,
  });

  res.json(paystackData);
});

/**
 * Manually list bookings for the logged-in student's dashboard.
 * Actual booking creation happens in payments.js after Paystack verification.
 */
router.get("/mine", requireAuth, requireRole("student"), async (req, res) => {
  const result = await query(
    `SELECT bo.*, r.room_code, r.room_type, h.name AS hostel_name, h.area
     FROM bookings bo
     JOIN beds be ON be.id = bo.bed_id
     JOIN rooms r ON r.id = be.room_id
     JOIN hostels h ON h.id = r.hostel_id
     WHERE bo.student_id = $1
     ORDER BY bo.created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

export default router;
