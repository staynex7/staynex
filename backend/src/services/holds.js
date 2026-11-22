import { query } from "../db/pool.js";

/**
 * Gender rules shared by hold creation and payment settlement.
 * `db` is either the pool-level `query` wrapper or a transaction client.
 * Returns an error string if the student can't take this bed, else null.
 */
export async function genderBlock(db, { roomId, bedId, hostelGenderPolicy, studentId, studentGender }) {
  const run = db.query ? (t, p) => db.query(t, p) : query;

  if (hostelGenderPolicy !== "mixed" && hostelGenderPolicy !== studentGender) {
    return `This hostel is for ${hostelGenderPolicy} students only.`;
  }

  // Even inside a "mixed" hostel a room must not end up with both genders.
  // Counts anyone booked AND anyone actively mid-checkout (held_by) in the room.
  const roommates = await run(
    `SELECT DISTINCT u.gender
     FROM beds b2
     LEFT JOIN bookings bk ON bk.bed_id = b2.id AND bk.status NOT IN ('forfeited', 'cancelled')
     LEFT JOIN users u ON u.id = COALESCE(bk.student_id, b2.held_by)
     WHERE b2.room_id = $1 AND b2.id != $2
       AND (b2.status = 'taken' OR (b2.status = 'reserved_pending' AND b2.hold_expires_at > now()))
       AND u.gender IS NOT NULL
       AND ($3::uuid IS NULL OR u.id != $3::uuid)`,
    [roomId, bedId, studentId || null]
  );
  if (roommates.rows.some((r) => r.gender !== studentGender)) {
    return "This room already has a student of a different gender. Rooms can't mix genders.";
  }
  return null;
}
