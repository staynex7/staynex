import { verifyToken } from "../utils/jwt.js";
import { query } from "../db/pool.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }
  try {
    const payload = verifyToken(header.split(" ")[1]);
    // Admin tokens only work on /api/admin — never on student/manager routes.
    if (payload.typ === "admin") return res.status(401).json({ error: "Invalid or expired token" });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: `This action requires a ${role} account` });
    }
    next();
  };
}

/**
 * Admin-only guard. Requires an admin-type token AND that the admin row still
 * exists in the database, so deleting an admin revokes access immediately.
 */
export async function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Admin login required" });
  let payload;
  try {
    payload = verifyToken(header.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Admin session expired. Please sign in again." });
  }
  if (payload.typ !== "admin") return res.status(403).json({ error: "Admin access required" });
  const admin = (await query("SELECT id, email, name FROM admins WHERE id = $1", [payload.id])).rows[0];
  if (!admin) return res.status(401).json({ error: "Admin session expired. Please sign in again." });
  req.admin = admin;
  next();
}
