import cron from "node-cron";
import { query, pool } from "../db/pool.js";
import { sendSMS, smsTemplates } from "./sms.js";
import { notifyNextInWaitlist } from "../routes/waitlist.js";

const DAY = 86400000;

/**
 * Which reminder stage a booking is in TODAY. Stages are ranges, not exact
 * days, so a missed run (server asleep, deploy, outage) can't skip a reminder
 * forever — the next run that sees the booking in a stage it hasn't been
 * reminded for sends it. Only the current stage is ever sent, so a booking
 * never gets a burst of stale reminders after downtime.
 */
export function reminderStage(today, dueDate, graceEnd) {
  const daysToDue = Math.round((dueDate - today) / DAY);
  if (today > graceEnd) return "forfeited";
  if (daysToDue < 0) return "grace_warning";
  if (daysToDue === 0) return "deadline";
  if (daysToDue <= 3) return "3_days";
  if (daysToDue <= 14) return "2_weeks";
  return null;
}

/** Idempotent: safe to run from cron, an external ping, or on startup, any number of times. */
export async function runDailyReminders() {
  const bookings = await query(
    `SELECT bo.*, u.name, u.phone, r.id AS room_id, r.room_code, h.name AS hostel_name
     FROM bookings bo
     JOIN users u ON u.id = bo.student_id
     JOIN beds be ON be.id = bo.bed_id
     JOIN rooms r ON r.id = be.room_id
     JOIN hostels h ON h.id = r.hostel_id
     WHERE bo.status = 'deposit_paid'`
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const b of bookings.rows) {
    try {
      const dueDate = new Date(b.balance_due_date);
      const graceEnd = new Date(b.grace_period_ends_at);
      const stage = reminderStage(today, dueDate, graceEnd);
      if (!stage) continue;

      // Claim the stage in the DB first (unique index on booking+type): if two
      // runs race, exactly one inserts and sends.
      const claimed = await query(
        "INSERT INTO reminders_log (booking_id, reminder_type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
        [b.id, stage]
      );
      if (!claimed.rows.length) continue;

      if (stage === "2_weeks") await sendSMS(b.phone, smsTemplates.reminder2Weeks(b.name, b.balance_amount, dueDate.toDateString()));
      else if (stage === "3_days") await sendSMS(b.phone, smsTemplates.reminder3Days(b.name, b.balance_amount, dueDate.toDateString()));
      else if (stage === "deadline") await sendSMS(b.phone, smsTemplates.reminderDeadline(b.name, b.balance_amount));
      else if (stage === "grace_warning") await sendSMS(b.phone, smsTemplates.graceWarning(b.name, graceEnd.toDateString()));
      else if (stage === "forfeited") await forfeitBooking(b);
    } catch (err) {
      // One bad booking (e.g. an SMS provider error) must not stop everyone else's.
      console.error(`Reminder processing failed for booking ${b.id}:`, err.message);
    }
  }
}

async function forfeitBooking(booking) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Re-check under lock: a balance payment may have landed a moment ago.
    const cur = (await client.query("SELECT status FROM bookings WHERE id = $1 FOR UPDATE", [booking.id])).rows[0];
    if (cur?.status !== "deposit_paid") {
      await client.query("ROLLBACK");
      return;
    }
    await client.query("UPDATE bookings SET status = 'forfeited' WHERE id = $1", [booking.id]);
    await client.query("UPDATE beds SET status = 'available', held_by = NULL, hold_expires_at = NULL WHERE id = $1", [booking.bed_id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await sendSMS(booking.phone, smsTemplates.forfeited(booking.name));
  // Bed is free again — automatically pull the next waitlisted student in.
  await notifyNextInWaitlist(booking.room_id, booking.hostel_name, booking.room_code);
}

/** Sweeps expired 15-minute reservation holds back to 'available'. */
export async function releaseExpiredHolds() {
  await query(
    "UPDATE beds SET status = 'available', hold_expires_at = NULL, held_by = NULL WHERE status = 'reserved_pending' AND hold_expires_at < now()"
  );
}

/**
 * A waitlisted student who was texted has CLAIM_WINDOW_HOURS to book. When
 * that lapses, drop them from the list and offer the bed to the next person.
 */
export async function expireWaitlistClaims() {
  const lapsed = await query(
    `DELETE FROM waitlist_entries w
     USING rooms r, hostels h
     WHERE w.room_id = r.id AND h.id = r.hostel_id
       AND w.claim_expires_at IS NOT NULL AND w.claim_expires_at < now()
     RETURNING w.room_id, r.room_code, h.name AS hostel_name`
  );
  const seen = new Set();
  for (const row of lapsed.rows) {
    if (seen.has(row.room_id)) continue;
    seen.add(row.room_id);
    const free = await query(
      "SELECT 1 FROM beds WHERE room_id = $1 AND status = 'available' LIMIT 1", [row.room_id]
    );
    if (free.rows.length) await notifyNextInWaitlist(row.room_id, row.hostel_name, row.room_code);
  }
}

/** Everything periodic, in one call — used by cron, the external trigger endpoint, and startup. */
export async function runAllJobs() {
  await releaseExpiredHolds();
  await expireWaitlistClaims();
  await runDailyReminders();
}

export function startReminderJobs() {
  // Deliberately NOT every minute: on Neon's free plan the database suspends
  // after 5 idle minutes and compute is capped at 100 CU-hours/month, so a
  // per-minute job would keep it awake 24/7 and burn the allowance in ~2 weeks.
  // Expired holds don't need a sweep — /bookings/hold and payment settlement
  // already treat a lapsed hold as free. Everything else is idempotent, so:
  //   * once at boot (catches up after Render wakes the server),
  //   * hourly while the server happens to be awake,
  //   * and from an external pinger hitting POST /api/internal/run-jobs hourly.
  cron.schedule("0 * * * *", () => {
    runAllJobs().catch((err) => console.error("Hourly job run failed:", err));
  });
  runAllJobs().catch((err) => console.error("Startup job run failed:", err));
}
