import express from "express";
import { query } from "../db/pool.js";
import { HOSTEL_AMENITIES, ROOM_AMENITIES } from "../constants/amenities.js";
import { ROOMMATE_OPTIONS } from "../constants/roommates.js";

const router = express.Router();

/** Powers both the manager's amenity checklists and the student filter panel. */
router.get("/amenity-options", (req, res) => {
  res.json({ hostelAmenities: HOSTEL_AMENITIES, roomAmenities: ROOM_AMENITIES });
});

router.get("/roommate-options", (req, res) => res.json(ROOMMATE_OPTIONS));

/**
 * Public browse — filter by area/gender/price/room type/amenities.
 * Amenity filters require ALL selected items to match (a strict AND), which
 * is what a student picking specific must-haves would expect.
 */
router.get("/", async (req, res) => {
  const { search, gender, minPrice, maxPrice, roomTypes, hostelAmenities, roomAmenities,
    rmInterests, rmSports, rmLifestyle, rmReligion } = req.query;

  // Only admin-verified hostels are listed. A manager sees their own listing in their dashboard.
  const conditions = ["h.verified = true"];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(h.name ILIKE $${params.length} OR h.area ILIKE $${params.length})`);
  }
  if (gender && gender !== "any") {
    params.push(gender);
    conditions.push(`(h.gender_policy = $${params.length} OR h.gender_policy = 'mixed')`);
  }
  if (hostelAmenities) {
    const list = hostelAmenities.split(",").filter(Boolean);
    if (list.length) {
      params.push(list);
      conditions.push(`h.includes @> $${params.length}::text[]`);
    }
  }

  // Price range, room type, and room-level amenities all need to match some
  // ROOM at the hostel, not the hostel row itself — hence the EXISTS checks
  // rather than a plain column comparison.
  const roomConditions = [];
  const roomParams = [];
  if (minPrice) {
    roomParams.push(Number(minPrice));
    roomConditions.push(`r2.price_per_year >= $${params.length + roomParams.length}`);
  }
  if (maxPrice) {
    roomParams.push(Number(maxPrice));
    roomConditions.push(`r2.price_per_year <= $${params.length + roomParams.length}`);
  }
  if (roomTypes) {
    const list = roomTypes.split(",").filter(Boolean);
    if (list.length) {
      roomParams.push(list);
      roomConditions.push(`r2.room_type = ANY($${params.length + roomParams.length}::text[])`);
    }
  }
  if (roomAmenities) {
    const list = roomAmenities.split(",").filter(Boolean);
    if (list.length) {
      roomParams.push(list);
      roomConditions.push(`r2.amenities @> $${params.length + roomParams.length}::text[]`);
    }
  }
  if (roomConditions.length) {
    conditions.push(`EXISTS (SELECT 1 FROM rooms r2 WHERE r2.hostel_id = h.id AND ${roomConditions.join(" AND ")})`);
  }
  params.push(...roomParams);

  // Roommate filter: a hostel matches when ONE current occupant (paid booking,
  // opted in to sharing) matches every roommate category selected. Within a
  // category any overlap counts; religion is an exact match. Only a match is
  // ever revealed — never who the occupant is.
  const rm = [];
  const rmList = (v, allowed) => String(v || "").split(",").filter((x) => allowed.includes(x));
  const addOverlap = (col, list) => {
    if (!list.length) return;
    params.push(list);
    rm.push(`u.${col} && $${params.length}::text[]`);
  };
  addOverlap("interests", rmList(rmInterests, ROOMMATE_OPTIONS.interests));
  addOverlap("sports", rmList(rmSports, ROOMMATE_OPTIONS.sports));
  addOverlap("lifestyle", rmList(rmLifestyle, ROOMMATE_OPTIONS.lifestyle));
  if (ROOMMATE_OPTIONS.religions.includes(rmReligion)) {
    params.push(rmReligion);
    rm.push(`u.religion = $${params.length}`);
  }
  if (rm.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM rooms r3
               JOIN beds b3 ON b3.room_id = r3.id
               JOIN bookings bk ON bk.bed_id = b3.id AND bk.status IN ('deposit_paid', 'balance_paid')
               JOIN users u ON u.id = bk.student_id AND u.share_with_roommates = true
               WHERE r3.hostel_id = h.id AND ${rm.join(" AND ")})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(
    `SELECT h.id, h.name, h.area, h.gender_policy, h.includes, h.verified, h.landmark_distances,
            (SELECT m.url FROM media m WHERE m.hostel_id = h.id AND m.resource_type = 'image' ORDER BY m.created_at LIMIT 1) AS cover_photo,
            COUNT(b.id) AS total_beds,
            COUNT(b.id) FILTER (WHERE b.status = 'available') AS open_beds,
            MIN(r.price_per_year) AS from_price
     FROM hostels h
     LEFT JOIN rooms r ON r.hostel_id = h.id
     LEFT JOIN beds b ON b.room_id = r.id
     ${where}
     GROUP BY h.id
     ORDER BY open_beds DESC`,
    params
  );

  res.json(result.rows);
});

/** Hostel detail — rooms + live bed grid + photos/clips, in a single round trip. */
router.get("/:id", async (req, res) => {
  // A malformed id (e.g. /hostels/abc) would make Postgres throw on the uuid cast and surface as a 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(404).json({ error: "Hostel not found" });
  }
  const result = await query(
    `SELECT h.*,
            (SELECT COALESCE(
               json_agg(
                 json_build_object('id', m.id, 'url', m.url, 'resource_type', m.resource_type)
                 ORDER BY m.created_at
               ), '[]'
             ) FROM media m WHERE m.hostel_id = h.id) AS media,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', r.id, 'room_code', r.room_code, 'room_type', r.room_type,
                  'price_per_year', r.price_per_year, 'beds', r.beds, 'media', r.media,
                  'amenities', r.amenities
                ) ORDER BY r.room_code
              ) FILTER (WHERE r.id IS NOT NULL), '[]'
            ) AS rooms
     FROM hostels h
     LEFT JOIN (
       SELECT rm.id, rm.hostel_id, rm.room_code, rm.room_type, rm.price_per_year, rm.amenities,
              (SELECT COALESCE(
                 json_agg(
                   json_build_object('id', b.id, 'bed_index', b.bed_index, 'status', b.status)
                   ORDER BY b.bed_index
                 ), '[]'
               ) FROM beds b WHERE b.room_id = rm.id) AS beds,
              (SELECT COALESCE(
                 json_agg(
                   json_build_object('id', m.id, 'url', m.url, 'resource_type', m.resource_type)
                   ORDER BY m.created_at
                 ), '[]'
               ) FROM media m WHERE m.room_id = rm.id) AS media
       FROM rooms rm
     ) r ON r.hostel_id = h.id
     WHERE h.id = $1
     GROUP BY h.id`,
    [req.params.id]
  );

  const hostel = result.rows[0];
  if (!hostel) return res.status(404).json({ error: "Hostel not found" });
  res.json(hostel);
});

export default router;
