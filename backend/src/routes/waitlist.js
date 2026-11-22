import express from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { sendSMS, smsTemplates } from "../services/sms.js";

const router = express.Router();
const CLAIM_WINDOW_HOURS = 24;

/** Student joins a room's waitlist. Only makes sense when the room is full. */
router.post("/join", requireAuth, requireRole("student"), async (req, res) => {
  const { roomId } = req.body;

  const room = (await query(
    `SELECT r.id, COUNT(b.id) FILTER (WHERE b.status = 'available') AS open_beds
     FROM rooms r LEFT JOIN beds b ON b.room_id = r.id WHERE r.id = $1 GROUP BY r.id`,
    [roomId]
  )).rows[0];
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (Number(room.open_beds) > 0) {
    return res.status(409).json({ error: "This room has beds available right now — you can reserve one directly." });
  }

  // The unique index (room_id, student_id) makes this race-proof.
  const result = await query(
    `INSERT INTO waitlist_entries (student_id, room_id, position)
     VALUES ($1, $2, COALESCE((SELECT MAX(position) FROM waitlist_entries WHERE room_id = $2), 0) + 1)
     ON CONFLICT (room_id, student_id) DO NOTHING
     RETURNING *`,
    [req.user.id, roomId]
  );
  if (!result.rows.length) return res.status(409).json({ error: "You're already on the waitlist for this room" });
  res.status(201).json(result.rows[0]);
});

/**
 * The caller's own place in line for a room, plus how many are queued — NOT
 * the other students' names. Position is derived from join order at read
 * time, so it stays correct when people ahead leave.
 */
router.get("/room/:roomId", requireAuth, requireRole("student"), async (req, res) => {
  const rows = (await query(
    `SELECT id, student_id, notified_at, claim_expires_at,
            ROW_NUMBER() OVER (ORDER BY created_at, id) AS position,
            COUNT(*) OVER () AS total
     FROM waitlist_entries WHERE room_id = $1`,
    [req.params.roomId]
  )).rows;
  const mine = rows.find((r) => r.student_id === req.user.id);
  res.json({
    total: rows.length,
    mine: mine
      ? { id: mine.id, position: Number(mine.position), notifiedAt: mine.notified_at, claimExpiresAt: mine.claim_expires_at }
      : null,
  });
});

/**
 * Called when a bed frees up (manager vacates it, or a booking is forfeited).
 * Notifies the next student in line with a 24-hour claim window; while that
 * claim is live, /bookings/hold keeps the room closed to everyone else. If it
 * lapses, services/reminders.js expires it and offers the bed to the next person.
 */
export async function notifyNextInWaitlist(roomId, hostelName, roomCode) {
  const next = await query(
    `SELECT w.*, u.name, u.phone FROM waitlist_entries w JOIN users u ON u.id = w.student_id
     WHERE w.room_id = $1 AND w.notified_at IS NULL ORDER BY w.created_at, w.id LIMIT 1`,
    [roomId]
  );
  const entry = next.rows[0];
  if (!entry) return null;

  const claimExpires = new Date(Date.now() + CLAIM_WINDOW_HOURS * 60 * 60 * 1000);
  await query(
    "UPDATE waitlist_entries SET notified_at = now(), claim_expires_at = $1 WHERE id = $2",
    [claimExpires, entry.id]
  );
  try {
    await sendSMS(entry.phone, smsTemplates.waitlistClaim(entry.name, hostelName, roomCode));
  } catch (err) {
    console.error("Waitlist SMS failed (claim window still open):", err.message);
  }
  return entry;
}

/** Student removes themselves from a waitlist. */
router.delete("/:id", requireAuth, requireRole("student"), async (req, res) => {
  await query("DELETE FROM waitlist_entries WHERE id = $1 AND student_id = $2", [req.params.id, req.user.id]);
  res.status(204).send();
});

export default router;
