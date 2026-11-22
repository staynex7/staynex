import { query, pool } from "../db/pool.js";
import { verifyTransaction } from "./paystack.js";
import { sendSMS, smsTemplates } from "./sms.js";
import { sendReceiptEmail, sendManagerBookingEmail } from "./email.js";
import { computeBalanceDueDate } from "./academicCalendar.js";
import { genderBlock } from "./holds.js";
import { httpError } from "../utils/httpError.js";

export const SERVICE_FEE = 50;
export const GRACE_DAYS = 4;

/**
 * THE one place a Paystack payment turns into a booking / a paid balance.
 * Called by both the browser callback (/payments/verify*) and Paystack's
 * server-to-server webhook, so a payment settles even if the student closes
 * the tab, and settles exactly once if both fire.
 *
 * Trust model: nothing from the client matters except the reference. Who the
 * payment belongs to, which bed/booking it is for and how much we expect are
 * all read from the `payments` ledger row we wrote at initialization.
 */
export async function settlePayment(reference, { studentId } = {}) {
  const ledger = (await query("SELECT * FROM payments WHERE reference = $1", [reference])).rows[0];
  if (!ledger) throw httpError(404, "Unknown payment reference.");
  if (studentId && ledger.student_id !== studentId) throw httpError(403, "This payment belongs to a different account.");

  if (ledger.status === "settled") return { ...(await loadResult(ledger)), firstTime: false };
  if (ledger.status === "needs_review") {
    throw httpError(409, reviewMessage(reference));
  }

  const verified = await verifyTransaction(reference);
  if (verified.status !== "success") {
    throw httpError(402, "Payment was not successful", { detail: verified.gateway_response });
  }
  if ((verified.currency && verified.currency !== "GHS") || Number(verified.amount) < Number(ledger.expected_total_pesewas)) {
    await flagForReview(reference, "Paystack reported a different currency or a lower amount than expected.");
    throw httpError(402, reviewMessage(reference));
  }

  const outcome = ledger.kind === "deposit" ? await settleDeposit(reference) : await settleBalance(reference);
  if (outcome.firstTime) {
    notify(ledger.kind, outcome, reference).catch((err) => console.error("Settled, but notification failed:", err));
  }
  return outcome;
}

function reviewMessage(reference) {
  return `Your payment (ref ${reference}) went through, but we couldn't apply it automatically. ` +
    "Contact support with this reference and it will be sorted out or refunded.";
}

async function flagForReview(reference, reason) {
  await query(
    "UPDATE payments SET status = 'needs_review', review_reason = $2 WHERE reference = $1 AND status = 'initialized'",
    [reference, reason]
  );
  console.error(`PAYMENT NEEDS REVIEW ${reference}: ${reason}`);
}

async function loadResult(ledger) {
  const booking = ledger.booking_id
    ? (await query("SELECT * FROM bookings WHERE id = $1", [ledger.booking_id])).rows[0]
    : null;
  return { kind: ledger.kind, booking };
}

async function settleDeposit(reference) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = (await client.query("SELECT * FROM payments WHERE reference = $1 FOR UPDATE", [reference])).rows[0];
    if (p.status === "settled") {
      await client.query("COMMIT");
      return { ...(await loadResult(p)), firstTime: false };
    }

    const bed = (await client.query(
      `SELECT b.*, r.price_per_year, r.id AS room_id, r.hostel_id, h.gender_policy
       FROM beds b JOIN rooms r ON r.id = b.room_id JOIN hostels h ON h.id = r.hostel_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [p.bed_id]
    )).rows[0];

    const holdExpired = bed.hold_expires_at && new Date(bed.hold_expires_at) < new Date();
    const ownHold = bed.status === "reserved_pending" && bed.held_by === p.student_id;
    const free = bed.status === "available" || (bed.status === "reserved_pending" && holdExpired);

    let blockReason = null;
    if (!ownHold && !free) {
      blockReason = "Bed was no longer available when payment completed.";
    } else if (!ownHold) {
      // Hold lapsed before payment landed but nobody took the bed: honour the
      // payment, but re-run the gender rules since the hold no longer protects them.
      const student = (await client.query("SELECT gender FROM users WHERE id = $1", [p.student_id])).rows[0];
      blockReason = await genderBlock(client, {
        roomId: bed.room_id, bedId: bed.id, hostelGenderPolicy: bed.gender_policy,
        studentId: p.student_id, studentGender: student.gender,
      });
    }

    if (blockReason) {
      await client.query(
        "UPDATE payments SET status = 'needs_review', review_reason = $2 WHERE reference = $1",
        [reference, blockReason]
      );
      await client.query("COMMIT");
      console.error(`PAYMENT NEEDS REVIEW ${reference}: ${blockReason}`);
      throw httpError(409, reviewMessage(reference));
    }

    const deposit = Number(p.principal_amount);
    const balance = Math.max(0, Number(bed.price_per_year) - deposit);
    const balanceDueDate = computeBalanceDueDate();
    const graceEnd = new Date(balanceDueDate);
    graceEnd.setDate(graceEnd.getDate() + GRACE_DAYS);
    // Paid in full up front -> already settled; don't strand it as deposit_paid.
    const status = balance <= 0 ? "balance_paid" : "deposit_paid";

    await client.query("UPDATE beds SET status = 'taken', hold_expires_at = NULL, held_by = NULL WHERE id = $1", [bed.id]);
    const booking = (await client.query(
      `INSERT INTO bookings (student_id, bed_id, deposit_amount, service_fee, balance_amount, balance_due_date, status, paystack_ref, grace_period_ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [p.student_id, bed.id, deposit, SERVICE_FEE, balance, balanceDueDate, status, reference, graceEnd]
    )).rows[0];
    await client.query(
      "UPDATE payments SET status = 'settled', booking_id = $2, settled_at = now() WHERE reference = $1",
      [reference, booking.id]
    );
    // They got a bed — drop them off this room's waitlist if they were on it.
    await client.query("DELETE FROM waitlist_entries WHERE room_id = $1 AND student_id = $2", [bed.room_id, p.student_id]);
    await client.query("COMMIT");
    return { kind: "deposit", booking, firstTime: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function settleBalance(reference) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = (await client.query("SELECT * FROM payments WHERE reference = $1 FOR UPDATE", [reference])).rows[0];
    if (p.status === "settled") {
      await client.query("COMMIT");
      return { ...(await loadResult(p)), firstTime: false };
    }
    const booking = (await client.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [p.booking_id])).rows[0];

    if (!booking || booking.status !== "deposit_paid") {
      const reason = "Booking was no longer awaiting a balance payment (forfeited, cancelled or already paid).";
      await client.query("UPDATE payments SET status = 'needs_review', review_reason = $2 WHERE reference = $1", [reference, reason]);
      await client.query("COMMIT");
      console.error(`PAYMENT NEEDS REVIEW ${reference}: ${reason}`);
      throw httpError(409, reviewMessage(reference));
    }

    const updated = (await client.query("UPDATE bookings SET status = 'balance_paid' WHERE id = $1 RETURNING *", [booking.id])).rows[0];
    await client.query("UPDATE payments SET status = 'settled', settled_at = now() WHERE reference = $1", [reference]);
    await client.query("COMMIT");
    return { kind: "balance", booking: updated, firstTime: true, balancePaid: Number(p.principal_amount) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Best-effort SMS/email after the money is safely recorded — never undoes a settlement. */
async function notify(kind, outcome, reference) {
  const { booking } = outcome;
  const info = (await query(
    `SELECT s.name AS student_name, s.email AS student_email, s.phone AS student_phone,
            h.name AS hostel_name, r.room_code,
            m.name AS manager_name, m.email AS manager_email, m.phone AS manager_phone
     FROM bookings bo
     JOIN users s ON s.id = bo.student_id
     JOIN beds be ON be.id = bo.bed_id
     JOIN rooms r ON r.id = be.room_id
     JOIN hostels h ON h.id = r.hostel_id
     JOIN users m ON m.id = h.manager_id
     WHERE bo.id = $1`,
    [booking.id]
  )).rows[0];
  if (!info) return;

  if (kind === "deposit") {
    const due = new Date(booking.balance_due_date).toDateString();
    await sendSMS(info.student_phone, smsTemplates.bookingReceipt(info.student_name, reference, booking.balance_amount, due));
    await sendReceiptEmail({
      to: info.student_email, name: info.student_name, hostelName: info.hostel_name, roomCode: info.room_code,
      deposit: booking.deposit_amount, serviceFee: SERVICE_FEE, balance: booking.balance_amount, dueDate: due, reference,
    });
    await sendSMS(info.manager_phone, smsTemplates.newBookingManager(info.student_name, info.room_code, booking.deposit_amount));
    await sendManagerBookingEmail({
      to: info.manager_email, managerName: info.manager_name, studentName: info.student_name, studentPhone: info.student_phone,
      hostelName: info.hostel_name, roomCode: info.room_code, depositAmount: booking.deposit_amount, balanceAmount: booking.balance_amount,
    });
  } else {
    await sendSMS(info.student_phone, smsTemplates.balancePaid(info.student_name, info.room_code));
    await sendReceiptEmail({
      to: info.student_email, name: info.student_name, hostelName: info.hostel_name, roomCode: info.room_code,
      deposit: booking.deposit_amount, serviceFee: 0, balance: 0, dueDate: "Paid in full", reference,
    });
    await sendSMS(info.manager_phone, smsTemplates.balancePaidManager(info.student_name, info.room_code, outcome.balancePaid));
    await sendManagerBookingEmail({
      to: info.manager_email, managerName: info.manager_name, studentName: info.student_name, studentPhone: info.student_phone,
      hostelName: info.hostel_name, roomCode: info.room_code, depositAmount: outcome.balancePaid, balanceAmount: 0,
    });
  }
}
