// Integration tests against a REAL Postgres (set TEST_DATABASE_URL) with Paystack mocked.
// Run: TEST_DATABASE_URL=postgresql://postgres@localhost:5433/staynex_test npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readFileSync } from "fs";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = "x".repeat(40);
process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
process.env.CRON_SECRET = "c".repeat(20);

const skip = !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL not set";

let app, server, base, pool;
const realFetch = globalThis.fetch;
const initCalls = [];
const paystackState = {}; // reference -> { status, amount }

function mockPaystack() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    if (u.endsWith("/transaction/initialize")) {
      const body = JSON.parse(opts.body);
      initCalls.push(body);
      return json({ status: true, data: { authorization_url: "https://paystack.test/pay", reference: body.reference } });
    }
    const m = u.match(/\/transaction\/verify\/(.+)$/);
    if (m) {
      const st = paystackState[m[1]] || { status: "abandoned", amount: 0 };
      return json({ status: true, data: { status: st.status, amount: st.amount, currency: "GHS" } });
    }
    if (u.includes("arkesel")) return json({ status: "success" });
    return json({ status: true, data: {} });
  };
}
const json = (o) => ({ ok: true, status: 200, json: async () => o });

async function call(method, path, { token, body, headers } = {}) {
  const res = await realFetch(`${base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function signup(role, name, gender, phone) {
  const email = `${name.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}@t.test`;
  const r = await call("POST", "/auth/signup", {
    body: { role, name, email, phone, password: "password123", gender },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { token: r.data.token, id: r.data.user.id, email };
}

let mgr, A, B, C, hostelId, roomId, beds;

before(async () => {
  if (skip) return;
  ({ pool } = await import("../src/db/pool.js"));
  const sql = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(sql);
  await pool.query(sql); // migration must be re-runnable

  app = (await import("../src/server.js")).default;
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  mockPaystack();

  mgr = await signup("manager", "Mgr", undefined, "0241111111");
  A = await signup("student", "Ama", "male", "0242222222");
  B = await signup("student", "Kofi", "male", "0243333333");
  C = await signup("student", "Esi", "female", "0244444444");

  hostelId = (await pool.query(
    `INSERT INTO hostels (manager_id, name, area, gender_policy, deposit_pct, paystack_subaccount_code, verified)
     VALUES ($1,'Test Hall','Ayeduase','mixed',0.35,'ACCT_real', true) RETURNING id`, [mgr.id])).rows[0].id;
  roomId = (await pool.query(
    "INSERT INTO rooms (hostel_id, room_code, room_type, price_per_year) VALUES ($1,'A1','2-in-1',1000) RETURNING id", [hostelId])).rows[0].id;
  beds = [];
  for (let i = 0; i < 3; i++) {
    beds.push((await pool.query("INSERT INTO beds (room_id, bed_index) VALUES ($1,$2) RETURNING id", [roomId, i])).rows[0].id);
  }
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) server.close();
  if (pool) await pool.end();
});

const t = (name, fn) => test(name, { skip }, fn);
const clearBookings = async () => { await pool.query("DELETE FROM payments"); await pool.query("DELETE FROM bookings"); };
const resetBeds = () => pool.query("UPDATE beds SET status='available', held_by=NULL, hold_expires_at=NULL");

async function holdAndInit(student, bedId, payAmount = 350) {
  const h = await call("POST", "/bookings/hold", { token: student.token, body: { bedId } });
  if (h.status !== 200) return { hold: h };
  const init = await call("POST", "/bookings/initialize-payment", {
    token: student.token,
    // hostile extras the server must ignore:
    body: { bedId, payAmount, subaccountCode: "ACCT_attacker", reference: "BRG-chosen-by-client" },
  });
  const ref = initCalls.at(-1)?.reference;
  return { hold: h, init, ref, total: initCalls.at(-1)?.amount };
}

t("concurrent holds on one bed: exactly one winner", async () => {
  await resetBeds();
  const [r1, r2] = await Promise.all([
    call("POST", "/bookings/hold", { token: A.token, body: { bedId: beds[0] } }),
    call("POST", "/bookings/hold", { token: B.token, body: { bedId: beds[0] } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal(r1.data.subaccountCode ?? r2.data.subaccountCode, undefined, "hold must not expose subaccount");
});

t("one active hold per student frees the previous bed", async () => {
  await resetBeds();
  await call("POST", "/bookings/hold", { token: A.token, body: { bedId: beds[0] } });
  await call("POST", "/bookings/hold", { token: A.token, body: { bedId: beds[1] } });
  const rows = (await pool.query("SELECT id,status FROM beds WHERE id = ANY($1)", [[beds[0], beds[1]]])).rows;
  assert.equal(rows.find((r) => r.id === beds[0]).status, "available");
  assert.equal(rows.find((r) => r.id === beds[1]).status, "reserved_pending");
});

t("mixed-gender room is refused, even for simultaneous holds", async () => {
  await resetBeds();
  const [r1, r2] = await Promise.all([
    call("POST", "/bookings/hold", { token: A.token, body: { bedId: beds[0] } }),
    call("POST", "/bookings/hold", { token: C.token, body: { bedId: beds[1] } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
});

t("initialize ignores client subaccount/reference; ledger row bound to bed+student", async () => {
  await resetBeds();
  const { init, ref, total } = await holdAndInit(A, beds[0]);
  assert.equal(init.status, 200);
  assert.equal(initCalls.at(-1).subaccount, "ACCT_real");
  assert.notEqual(ref, "BRG-chosen-by-client");
  const row = (await pool.query("SELECT * FROM payments WHERE reference=$1", [ref])).rows[0];
  assert.equal(row.student_id, A.id);
  assert.equal(row.bed_id, beds[0]);
  assert.equal(Number(row.expected_total_pesewas), total);
});

t("initialize refuses a bed the student isn't holding", async () => {
  await resetBeds();
  await call("POST", "/bookings/hold", { token: A.token, body: { bedId: beds[0] } });
  const r = await call("POST", "/bookings/initialize-payment", { token: B.token, body: { bedId: beds[0], payAmount: 350 } });
  assert.equal(r.status, 409);
});

t("deposit settles once via callback, replay + webhook are idempotent", async () => {
  await resetBeds();
  const { ref, total } = await holdAndInit(A, beds[0], 400);
  paystackState[ref] = { status: "success", amount: total };

  const v1 = await call("POST", "/payments/verify", { token: A.token, body: { reference: ref } });
  assert.equal(v1.status, 201, JSON.stringify(v1.data));
  assert.equal(Number(v1.data.deposit_amount), 400);
  assert.equal(Number(v1.data.balance_amount), 600);

  const v2 = await call("POST", "/payments/verify", { token: A.token, body: { reference: ref } });
  assert.equal(v2.status, 200);
  assert.equal(v2.data.id, v1.data.id);

  const raw = JSON.stringify({ event: "charge.success", data: { reference: ref } });
  const sig = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
  const w = await call("POST", "/payments/webhook", { body: raw, headers: { "x-paystack-signature": sig } });
  assert.equal(w.status, 200);

  const n = (await pool.query("SELECT count(*) FROM bookings WHERE paystack_ref=$1", [ref])).rows[0].count;
  assert.equal(Number(n), 1);
  assert.equal((await pool.query("SELECT status FROM beds WHERE id=$1", [beds[0]])).rows[0].status, "taken");
});

t("webhook alone settles a payment when the student never returns", async () => {
  await resetBeds();
  await clearBookings();
  const { ref, total } = await holdAndInit(B, beds[1]);
  paystackState[ref] = { status: "success", amount: total };
  const raw = JSON.stringify({ event: "charge.success", data: { reference: ref } });
  const sig = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
  const w = await call("POST", "/payments/webhook", { body: raw, headers: { "x-paystack-signature": sig } });
  assert.equal(w.status, 200);
  const b = (await pool.query("SELECT * FROM bookings WHERE paystack_ref=$1", [ref])).rows[0];
  assert.equal(b.student_id, B.id);
});

t("webhook rejects bad or missing signatures", async () => {
  const raw = JSON.stringify({ event: "charge.success", data: { reference: "x" } });
  assert.equal((await call("POST", "/payments/webhook", { body: raw })).status, 401);
  assert.equal((await call("POST", "/payments/webhook", { body: raw, headers: { "x-paystack-signature": "deadbeef" } })).status, 401);
});

t("someone else's reference cannot be verified from another account", async () => {
  await resetBeds();
  const { ref, total } = await holdAndInit(A, beds[0]);
  paystackState[ref] = { status: "success", amount: total };
  const r = await call("POST", "/payments/verify", { token: B.token, body: { reference: ref } });
  assert.equal(r.status, 403);
  assert.equal((await call("POST", "/payments/verify", { token: A.token, body: { reference: "nope" } })).status, 404);
});

t("underpayment is flagged for review, never booked", async () => {
  await resetBeds();
  await clearBookings();
  const { ref, total } = await holdAndInit(A, beds[0]);
  paystackState[ref] = { status: "success", amount: total - 5000 };
  const r = await call("POST", "/payments/verify", { token: A.token, body: { reference: ref } });
  assert.equal(r.status, 402);
  assert.equal((await pool.query("SELECT status FROM payments WHERE reference=$1", [ref])).rows[0].status, "needs_review");
  assert.equal((await pool.query("SELECT count(*) FROM bookings WHERE paystack_ref=$1", [ref])).rows[0].count, "0");
});

t("paid after hold lapsed and bed re-sold: flagged for refund, no double booking", async () => {
  await resetBeds();
  await clearBookings();
  const a = await holdAndInit(A, beds[0]);
  // A's hold lapses, B takes and fully pays for the same bed.
  await pool.query("UPDATE beds SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [beds[0]]);
  const b = await holdAndInit(B, beds[0]);
  paystackState[b.ref] = { status: "success", amount: b.total };
  assert.equal((await call("POST", "/payments/verify", { token: B.token, body: { reference: b.ref } })).status, 201);
  paystackState[a.ref] = { status: "success", amount: a.total };
  const r = await call("POST", "/payments/verify", { token: A.token, body: { reference: a.ref } });
  assert.equal(r.status, 409);
  assert.equal((await pool.query("SELECT count(*) FROM bookings WHERE bed_id=$1", [beds[0]])).rows[0].count, "1");
  const review = await pool.query("SELECT * FROM payments WHERE status='needs_review' AND reference=$1", [a.ref]);
  assert.equal(review.rows.length, 1);
});

t("balance: reference is bound to its booking; deposit refs can't pay balances", async () => {
  await resetBeds();
  await clearBookings();
  const d = await holdAndInit(A, beds[0], 350);
  paystackState[d.ref] = { status: "success", amount: d.total };
  const booking = (await call("POST", "/payments/verify", { token: A.token, body: { reference: d.ref } })).data;

  // Deposit reference replayed against the balance endpoint.
  const replay = await call("POST", "/payments/verify-balance", { token: A.token, body: { reference: d.ref, bookingId: booking.id } });
  assert.equal(replay.status, 409);

  const init = await call("POST", "/bookings/initialize-balance-payment", { token: A.token, body: { bookingId: booking.id } });
  assert.equal(init.status, 200);
  const bref = initCalls.at(-1).reference;

  // Unpaid -> not settled.
  assert.equal((await call("POST", "/payments/verify-balance", { token: A.token, body: { reference: bref } })).status, 402);
  paystackState[bref] = { status: "success", amount: initCalls.at(-1).amount };
  const ok = await call("POST", "/payments/verify-balance", { token: A.token, body: { reference: bref } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.status, "balance_paid");
  // Same reference can't be spent again on anything.
  assert.equal((await call("POST", "/payments/verify-balance", { token: A.token, body: { reference: bref } })).status, 200);
  assert.equal((await pool.query("SELECT count(*) FROM payments WHERE reference=$1 AND status='settled'", [bref])).rows[0].count, "1");
});

t("full upfront payment is booked as balance_paid", async () => {
  await resetBeds();
  await clearBookings();
  const { ref, total } = await holdAndInit(A, beds[2], 1000);
  paystackState[ref] = { status: "success", amount: total };
  const r = await call("POST", "/payments/verify", { token: A.token, body: { reference: ref } });
  assert.equal(r.data.status, "balance_paid");
});

t("waitlist: needs a full room, one entry each, others' names hidden, claim blocks outsiders", async () => {
  await resetBeds();
  assert.equal((await call("POST", "/waitlist/join", { token: B.token, body: { roomId } })).status, 409, "room has free beds");
  await pool.query("UPDATE beds SET status='taken'");
  assert.equal((await call("POST", "/waitlist/join", { token: B.token, body: { roomId } })).status, 201);
  assert.equal((await call("POST", "/waitlist/join", { token: B.token, body: { roomId } })).status, 409);
  const view = await call("GET", `/waitlist/room/${roomId}`, { token: A.token });
  assert.equal(view.data.total, 1);
  assert.equal(view.data.mine, null);
  assert.ok(!JSON.stringify(view.data).includes("Kofi"));

  // Bed frees; B is notified and holds the claim.
  const { notifyNextInWaitlist } = await import("../src/routes/waitlist.js");
  await pool.query("UPDATE beds SET status='available' WHERE id=$1", [beds[0]]);
  await notifyNextInWaitlist(roomId, "Test Hall", "A1");
  assert.equal((await call("POST", "/bookings/hold", { token: A.token, body: { bedId: beds[0] } })).status, 409);
  assert.equal((await call("POST", "/bookings/hold", { token: B.token, body: { bedId: beds[0] } })).status, 200);
});

t("expired waitlist claims are dropped and the next person is offered the bed", async () => {
  await resetBeds();
  await pool.query("DELETE FROM waitlist_entries");
  await pool.query("UPDATE beds SET status='taken'");
  await call("POST", "/waitlist/join", { token: A.token, body: { roomId } });
  await new Promise((r) => setTimeout(r, 20));
  await call("POST", "/waitlist/join", { token: B.token, body: { roomId } });
  await pool.query("UPDATE beds SET status='available' WHERE id=$1", [beds[0]]);
  const { notifyNextInWaitlist } = await import("../src/routes/waitlist.js");
  await notifyNextInWaitlist(roomId, "Test Hall", "A1");
  await pool.query("UPDATE waitlist_entries SET claim_expires_at = now() - interval '1 minute' WHERE notified_at IS NOT NULL");
  const { expireWaitlistClaims } = await import("../src/services/reminders.js");
  await expireWaitlistClaims();
  const left = (await pool.query("SELECT student_id, notified_at FROM waitlist_entries")).rows;
  assert.equal(left.length, 1);
  assert.equal(left[0].student_id, B.id);
  assert.ok(left[0].notified_at, "next student notified");
});

t("password reset: single-use, no account enumeration", async () => {
  const unknown = await call("POST", "/auth/forgot-password", { body: { email: "ghost@t.test" } });
  const known = await call("POST", "/auth/forgot-password", { body: { email: A.email } });
  assert.deepEqual(unknown.data, known.data);
  // Plant a known token (only the hash is stored).
  const token = "t".repeat(64);
  await pool.query("DELETE FROM password_resets");
  await pool.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now()+interval '1 hour')",
    [A.id, crypto.createHash("sha256").update(token).digest("hex")]);
  assert.equal((await call("POST", "/auth/reset-password", { body: { token, password: "short" } })).status, 400);
  assert.equal((await call("POST", "/auth/reset-password", { body: { token, password: "brandnew123" } })).status, 200);
  assert.equal((await call("POST", "/auth/reset-password", { body: { token, password: "another123" } })).status, 400);
  assert.equal((await call("POST", "/auth/login", { body: { email: A.email, password: "brandnew123" } })).status, 200);
});

t("internal job endpoint requires the secret", async () => {
  assert.equal((await call("POST", "/internal/run-jobs")).status, 401);
  assert.equal((await call("POST", "/internal/run-jobs", { headers: { "x-cron-secret": process.env.CRON_SECRET } })).status, 200);
});

t("reminders: missed days still send the current stage once; forfeit frees the bed", async () => {
  const { reminderStage, runDailyReminders } = await import("../src/services/reminders.js");
  const d = (n) => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + n); return x; };
  const today = d(0);
  assert.equal(reminderStage(today, d(30), d(34)), null);
  assert.equal(reminderStage(today, d(12), d(16)), "2_weeks");   // would have been skipped by === 14
  assert.equal(reminderStage(today, d(2), d(6)), "3_days");
  assert.equal(reminderStage(today, d(0), d(4)), "deadline");
  assert.equal(reminderStage(today, d(-2), d(2)), "grace_warning");
  assert.equal(reminderStage(today, d(-6), d(-2)), "forfeited");

  await resetBeds();
  await clearBookings();
  await pool.query("UPDATE beds SET status='taken' WHERE id=$1", [beds[0]]);
  await pool.query(
    `INSERT INTO bookings (student_id, bed_id, deposit_amount, balance_amount, balance_due_date, status, grace_period_ends_at)
     VALUES ($1,$2,350,650, current_date - 10, 'deposit_paid', current_date - 6)`, [A.id, beds[0]]);
  await runDailyReminders();
  await runDailyReminders(); // second run must be a no-op
  assert.equal((await pool.query("SELECT status FROM bookings WHERE bed_id=$1", [beds[0]])).rows[0].status, "forfeited");
  assert.equal((await pool.query("SELECT status FROM beds WHERE id=$1", [beds[0]])).rows[0].status, "available");
  assert.equal((await pool.query("SELECT count(*) FROM reminders_log")).rows[0].count, "1");
});

// ---------------------------------------------------------------------------
// Roommate profile + roommate filter
// ---------------------------------------------------------------------------
test("roommate profile: students only, whitelisted values, opt-in", { skip }, async () => {
  const opts = await call("GET", "/hostels/roommate-options");
  assert.equal(opts.status, 200);
  assert.ok(opts.data.sports.includes("Football"));

  const denied = await call("PUT", "/auth/roommate-profile", { token: mgr.token, body: { interests: ["Music"] } });
  assert.equal(denied.status, 403);

  const saved = await call("PUT", "/auth/roommate-profile", {
    token: A.token,
    body: { interests: ["Music", "not-a-real-option"], sports: ["Football"], lifestyle: ["Early riser"], religion: "Christian", shareWithRoommates: true },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.interests, ["Music"]); // junk dropped
  assert.equal(saved.data.religion, "Christian");
  assert.equal(saved.data.share_with_roommates, true);

  const bad = await call("PUT", "/auth/roommate-profile", { token: B.token, body: { religion: "Jedi", shareWithRoommates: "yes" } });
  assert.equal(bad.data.religion, null);
  assert.equal(bad.data.share_with_roommates, false); // only literal true opts in
});

test("roommate filter only matches opted-in, paid occupants", { skip }, async () => {
  const ids = async (qs) => (await call("GET", `/hostels?${qs}`)).data.map((h) => h.id);

  // Nobody has a paid booking yet -> no hostel matches, even though Ama's profile matches.
  assert.deepEqual(await ids("rmSports=Football"), []);

  // Ama (opted in, Football/Christian) takes bed 0 with a paid deposit.
  await pool.query("UPDATE beds SET status='taken' WHERE id=$1", [beds[0]]);
  await pool.query(
    `INSERT INTO bookings (student_id, bed_id, deposit_amount, balance_amount, balance_due_date, status)
     VALUES ($1,$2,350,650,'2027-01-01','deposit_paid')`, [A.id, beds[0]]);

  assert.deepEqual(await ids("rmSports=Football"), [hostelId]);
  assert.deepEqual(await ids("rmSports=Football,Tennis"), [hostelId]);       // any overlap
  assert.deepEqual(await ids("rmSports=Tennis"), []);
  assert.deepEqual(await ids("rmReligion=Christian&rmInterests=Music"), [hostelId]);
  assert.deepEqual(await ids("rmReligion=Muslim"), []);
  // all categories must match the SAME occupant
  assert.deepEqual(await ids("rmSports=Football&rmReligion=Muslim"), []);
  // junk values are ignored rather than erroring
  assert.equal((await call("GET", "/hostels?rmSports=%27%3B--&rmReligion=Jedi")).status, 200);
  // composes with existing filters
  assert.deepEqual(await ids("rmSports=Football&roomTypes=2-in-1"), [hostelId]);
  assert.deepEqual(await ids("rmSports=Football&roomTypes=Single"), []);

  // Ama opts out -> disappears from the filter.
  await call("PUT", "/auth/roommate-profile", { token: A.token, body: { sports: ["Football"], shareWithRoommates: false } });
  assert.deepEqual(await ids("rmSports=Football"), []);
});

test("unknown hostel ids and API paths return 404, not 500", { skip }, async () => {
  assert.equal((await call("GET", "/hostels/not-a-uuid")).status, 404);
  assert.equal((await call("GET", "/hostels/00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await call("GET", "/nope")).status, 404);
});

// ---------------------------------------------------------------------------
// Admin: separate credentials, separate token type
// ---------------------------------------------------------------------------
test("admin: own login, admin token only works on /admin, student/manager tokens don't", { skip }, async () => {
  const bcrypt = (await import("bcryptjs")).default;
  await pool.query("DELETE FROM admins");
  await pool.query("INSERT INTO admins (email, password_hash) VALUES ('boss@staynex.test', $1)", [await bcrypt.hash("a-long-admin-pass", 4)]);

  // Wrong password / unknown email / a normal user's credentials all fail the same way.
  assert.equal((await call("POST", "/admin/login", { body: { email: "boss@staynex.test", password: "nope" } })).status, 401);
  assert.equal((await call("POST", "/admin/login", { body: { email: "ghost@x.test", password: "a-long-admin-pass" } })).status, 401);
  assert.equal((await call("POST", "/admin/login", { body: { email: mgr.email, password: "password123" } })).status, 401);

  const login = await call("POST", "/admin/login", { body: { email: " Boss@Staynex.test ", password: "a-long-admin-pass" } });
  assert.equal(login.status, 200);
  const adminToken = login.data.token;

  // Student, manager and anonymous callers are all refused.
  assert.equal((await call("GET", "/admin/stats")).status, 401);
  assert.equal((await call("GET", "/admin/stats", { token: A.token })).status, 403);
  assert.equal((await call("GET", "/admin/stats", { token: mgr.token })).status, 403);
  // ...and an admin token is useless on student/manager routes.
  assert.equal((await call("GET", "/manager/hostels", { token: adminToken })).status, 401);
  assert.equal((await call("GET", "/auth/roommate-profile", { token: adminToken })).status, 401);

  const stats = await call("GET", "/admin/stats", { token: adminToken });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.hostels, 1);
  assert.equal((await call("GET", "/admin/bookings", { token: adminToken })).status, 200);

  // Change password: wrong current, too short, then success (old stops working).
  assert.equal((await call("POST", "/admin/change-password", { token: adminToken, body: { currentPassword: "bad", newPassword: "another-long-pass" } })).status, 401);
  assert.equal((await call("POST", "/admin/change-password", { token: adminToken, body: { currentPassword: "a-long-admin-pass", newPassword: "short" } })).status, 400);
  assert.equal((await call("POST", "/admin/change-password", { token: adminToken, body: { currentPassword: "a-long-admin-pass", newPassword: "another-long-pass" } })).status, 200);
  assert.equal((await call("POST", "/admin/login", { body: { email: "boss@staynex.test", password: "a-long-admin-pass" } })).status, 401);
  assert.equal((await call("POST", "/admin/login", { body: { email: "boss@staynex.test", password: "another-long-pass" } })).status, 200);

  // Deleting the admin row revokes an already-issued token immediately.
  await pool.query("DELETE FROM admins");
  assert.equal((await call("GET", "/admin/stats", { token: adminToken })).status, 401);
});

test("verification gate: unverified hostels are hidden and can't be booked; admin verifies", { skip }, async () => {
  const bcrypt = (await import("bcryptjs")).default;
  await pool.query("INSERT INTO admins (email, password_hash) VALUES ('boss@staynex.test', $1)", [await bcrypt.hash("a-long-admin-pass", 4)]);
  const { data: { token: adminToken } } = await call("POST", "/admin/login", { body: { email: "boss@staynex.test", password: "a-long-admin-pass" } });

  const h2 = (await pool.query(
    `INSERT INTO hostels (manager_id, name, area, gender_policy, deposit_pct, paystack_subaccount_code)
     VALUES ($1,'Pending Hall','Bomso','mixed',0.35,'ACCT_real') RETURNING id`, [mgr.id])).rows[0].id;
  const r2 = (await pool.query("INSERT INTO rooms (hostel_id, room_code, room_type, price_per_year) VALUES ($1,'P1','Single',900) RETURNING id", [h2])).rows[0].id;
  const bed2 = (await pool.query("INSERT INTO beds (room_id, bed_index) VALUES ($1,0) RETURNING id", [r2])).rows[0].id;

  const listed = async () => (await call("GET", "/hostels")).data.map((h) => h.id);
  assert.ok(!(await listed()).includes(h2));                                   // hidden from browse
  assert.equal((await call("GET", `/hostels/${h2}`)).status, 200);              // direct link still previews
  const held = await call("POST", "/bookings/hold", { token: B.token, body: { bedId: bed2 } });
  assert.equal(held.status, 403);                                               // cannot be booked
  assert.match(held.data.error, /verification/i);

  const pending = await call("GET", "/admin/hostels?status=pending", { token: adminToken });
  assert.deepEqual(pending.data.map((h) => h.id), [h2]);
  assert.equal(pending.data[0].manager_email, mgr.email);

  assert.equal((await call("PATCH", `/admin/hostels/${h2}/verify`, { token: adminToken, body: { verified: true } })).status, 200);
  assert.ok((await listed()).includes(h2));
  assert.equal((await call("POST", "/bookings/hold", { token: B.token, body: { bedId: bed2 } })).status, 200);

  assert.equal((await call("PATCH", `/admin/hostels/${h2}/verify`, { token: adminToken, body: { verified: false } })).status, 200);
  assert.ok(!(await listed()).includes(h2));
  assert.equal((await call("PATCH", "/admin/hostels/not-a-uuid/verify", { token: adminToken })).status, 404);
  await pool.query("DELETE FROM admins");
});

test("admin can resolve a needs-review payment exactly once", { skip }, async () => {
  const bcrypt = (await import("bcryptjs")).default;
  await pool.query("INSERT INTO admins (email, password_hash) VALUES ('boss@staynex.test', $1)", [await bcrypt.hash("a-long-admin-pass", 4)]);
  const { data: { token: adminToken } } = await call("POST", "/admin/login", { body: { email: "boss@staynex.test", password: "a-long-admin-pass" } });
  await pool.query(
    `INSERT INTO payments (reference, kind, student_id, principal_amount, expected_total_pesewas, status, review_reason)
     VALUES ('REF-REVIEW-1','deposit',$1,350,40000,'needs_review','test')`, [A.id]);

  const open = await call("GET", "/admin/payments/needs-review", { token: adminToken });
  assert.ok(open.data.some((p) => p.reference === "REF-REVIEW-1"));
  assert.equal((await call("POST", "/admin/payments/REF-REVIEW-1/resolve", { token: adminToken, body: { note: "" } })).status, 400);
  assert.equal((await call("POST", "/admin/payments/REF-REVIEW-1/resolve", { token: adminToken, body: { note: "refunded via Paystack" } })).status, 200);
  assert.equal((await call("POST", "/admin/payments/REF-REVIEW-1/resolve", { token: adminToken, body: { note: "again" } })).status, 404);
  assert.ok(!(await call("GET", "/admin/payments/needs-review", { token: adminToken })).data.some((p) => p.reference === "REF-REVIEW-1"));
  assert.ok((await call("GET", "/admin/payments/needs-review?resolved=true", { token: adminToken })).data.some((p) => p.reference === "REF-REVIEW-1"));
  await pool.query("DELETE FROM admins");
});

// ---------------------------------------------------------------------------
// Manager input validation
// ---------------------------------------------------------------------------
test("manager inputs are validated (400/409 instead of 500 or abuse)", { skip }, async () => {
  const post = (path, body) => call("POST", path, { token: mgr.token, body });
  assert.equal((await post("/manager/hostels", { name: "", area: "X" })).status, 400);
  assert.equal((await post("/manager/hostels", { name: "Good Hall", area: "Ayeduase", genderPolicy: "alien" })).status, 400);

  const base = { roomCode: "V1", roomType: "2-in-1", pricePerYear: 1000, bedCount: 2 };
  assert.equal((await post(`/manager/hostels/${hostelId}/rooms`, { ...base, bedCount: 5000000 })).status, 400);
  assert.equal((await post(`/manager/hostels/${hostelId}/rooms`, { ...base, bedCount: 0 })).status, 400);
  assert.equal((await post(`/manager/hostels/${hostelId}/rooms`, { ...base, pricePerYear: -5 })).status, 400);
  assert.equal((await post(`/manager/hostels/${hostelId}/rooms`, { ...base, roomType: "Palace" })).status, 400);
  assert.equal((await post(`/manager/hostels/${hostelId}/rooms`, { ...base, roomCode: "" })).status, 400);

  const ok = await post(`/manager/hostels/${hostelId}/rooms`, base);
  assert.equal(ok.status, 201);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM beds WHERE room_id=$1", [ok.data.id])).rows[0].n, 2);
  assert.equal((await post(`/manager/hostels/${hostelId}/rooms`, base)).status, 409);          // duplicate code

  assert.equal((await call("PATCH", `/manager/beds/${beds[2]}`, { token: mgr.token, body: { status: "reserved_pending" } })).status, 400);
  assert.equal((await call("PATCH", `/manager/hostels/${hostelId}/location`, { token: mgr.token, body: { latitude: 9999, longitude: 1 } })).status, 400);
});

test("deleting a hostel with bookings is refused before anything else happens", { skip }, async () => {
  const h3 = (await pool.query("INSERT INTO hostels (manager_id, name, area) VALUES ($1,'Booked Hall','Kentinkrono') RETURNING id", [mgr.id])).rows[0].id;
  const r3 = (await pool.query("INSERT INTO rooms (hostel_id, room_code, room_type, price_per_year) VALUES ($1,'B1','Single',500) RETURNING id", [h3])).rows[0].id;
  const b3 = (await pool.query("INSERT INTO beds (room_id, bed_index, status) VALUES ($1,0,'taken') RETURNING id", [r3])).rows[0].id;
  await pool.query("INSERT INTO media (hostel_id, url, public_id, resource_type) VALUES ($1,'http://x/y.jpg','pid-1','image')", [h3]);
  await pool.query(
    `INSERT INTO bookings (student_id, bed_id, deposit_amount, balance_amount, balance_due_date, status)
     VALUES ($1,$2,100,400,'2027-01-01','deposit_paid')`, [A.id, b3]);

  const del = await call("DELETE", `/manager/hostels/${h3}`, { token: mgr.token });
  assert.equal(del.status, 409);
  // hostel and its media row are both untouched
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM media WHERE hostel_id=$1", [h3])).rows[0].n, 1);
});
