import jwt from "jsonwebtoken";

// Read lazily and fail loudly: a missing secret must stop the server at boot,
// never silently sign tokens with `undefined`.
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set to a random string of at least 32 characters.");
}

export function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    SECRET,
    { expiresIn: "7d" }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

/** Admin tokens are a different TYPE (typ: "admin"), short-lived, and rejected by requireAuth. */
export function signAdminToken(admin) {
  return jwt.sign({ id: admin.id, role: "admin", typ: "admin" }, SECRET, { expiresIn: "2h" });
}
