import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import {
  ShieldCheck, ShieldOff, LogOut, Loader2, RefreshCw, Phone, Mail, CheckCircle2, AlertTriangle, ExternalLink,
} from "lucide-react";
import { adminApi, adminSession } from "../api/client.js";
import PasswordField from "../components/PasswordField.jsx";

const cedis = (n) => `₵${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "-");

const BOOKING_TONES = {
  deposit_paid: "bg-gold/15 text-[#7a5c14]",
  balance_paid: "bg-forest/10 text-forest",
  forfeited: "bg-danger/10 text-danger",
  cancelled: "bg-ink/10 text-ink/60",
  pending_payment: "bg-ink/10 text-ink/60",
};

function ErrorLine({ children }) {
  return children ? <p role="alert" className="text-sm text-danger">{children}</p> : null;
}

function Spinner({ label = "Loading…" }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink/50 py-10 justify-center">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("overview");
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState("");

  const loadStats = useCallback(() => {
    setStatsError("");
    return adminApi.stats().then(setStats).catch((e) => setStatsError(e.message));
  }, []);

  useEffect(() => {
    if (adminSession.token) loadStats();
  }, [loadStats]);

  // Session expired / revoked while the page is open.
  useEffect(() => {
    const onExpired = () => navigate("/admin/login", { replace: true });
    window.addEventListener("staynex:admin-expired", onExpired);
    return () => window.removeEventListener("staynex:admin-expired", onExpired);
  }, [navigate]);

  if (!adminSession.token) return <Navigate to="/admin/login" replace />;

  const pending = stats ? stats.hostels - stats.verified_hostels : 0;
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "hostels", label: "Hostels", badge: pending },
    { id: "payments", label: "Payments", badge: stats?.payments_to_review || 0 },
    { id: "bookings", label: "Bookings" },
    { id: "account", label: "Account" },
  ];

  function signOut() {
    adminSession.clear();
    navigate("/admin/login", { replace: true });
  }

  return (
    <div className="min-h-screen bg-paper">
      <Helmet>
        <title>Admin · StayNex</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <header className="bg-ink text-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <p className="font-display text-lg">
            <span className="text-sky font-semibold">stay</span><span className="font-black">NEX</span>
            <span className="text-white/60 text-sm ml-2 font-sans">Admin</span>
          </p>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden sm:inline text-white/60">{adminSession.admin?.email}</span>
            <button
              type="button" onClick={signOut}
              className="flex items-center gap-1.5 text-white/80 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white rounded"
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </div>
        <nav className="max-w-5xl mx-auto px-6 flex gap-1 overflow-x-auto" role="tablist" aria-label="Admin sections">
          {tabs.map((t) => (
            <button
              key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm whitespace-nowrap rounded-t-lg outline-none focus-visible:ring-2 focus-visible:ring-white ${
                tab === t.id ? "bg-paper text-ink font-medium" : "text-white/70 hover:text-white"
              }`}
            >
              {t.label}
              {t.badge > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-gold text-ink text-[11px] font-semibold">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {tab === "overview" && <Overview stats={stats} error={statsError} onRetry={loadStats} goto={setTab} />}
        {tab === "hostels" && <HostelsPanel onChanged={loadStats} />}
        {tab === "payments" && <PaymentsPanel onChanged={loadStats} />}
        {tab === "bookings" && <BookingsPanel />}
        {tab === "account" && <AccountPanel />}
      </main>
    </div>
  );
}

/* ----------------------------- Overview ----------------------------- */

function Stat({ label, value, sub, tone, onClick }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick} type={onClick ? "button" : undefined}
      className={`text-left bg-white border rounded-xl p-5 ${tone === "warn" ? "border-gold/60" : "border-ink/10"} ${onClick ? "hover:border-rust/50 outline-none focus-visible:ring-2 focus-visible:ring-rust" : ""}`}
    >
      <p className="font-mono text-[11px] uppercase tracking-wide text-ink/50 mb-1">{label}</p>
      <p className="font-display text-3xl text-ink">{value}</p>
      {sub && <p className="text-xs text-ink/50 mt-1">{sub}</p>}
    </Tag>
  );
}

function Overview({ stats, error, onRetry, goto }) {
  if (error) {
    return (
      <div className="text-center py-10 space-y-3">
        <ErrorLine>{error}</ErrorLine>
        <button onClick={onRetry} className="bg-ink text-paper rounded-full px-5 py-2 text-sm font-medium hover:bg-rust">Try again</button>
      </div>
    );
  }
  if (!stats) return <Spinner />;
  const pending = stats.hostels - stats.verified_hostels;
  return (
    <div className="space-y-6">
      {(pending > 0 || stats.payments_to_review > 0) && (
        <div className="bg-gold/10 border border-gold/40 rounded-xl p-4 text-sm text-ink space-y-1">
          <p className="font-medium flex items-center gap-2"><AlertTriangle size={16} className="text-[#7a5c14]" /> Needs your attention</p>
          {pending > 0 && <p><button className="underline text-rust" onClick={() => goto("hostels")}>{pending} hostel{pending === 1 ? "" : "s"}</button> waiting for verification.</p>}
          {stats.payments_to_review > 0 && <p><button className="underline text-rust" onClick={() => goto("payments")}>{stats.payments_to_review} payment{stats.payments_to_review === 1 ? "" : "s"}</button> need a manual refund or fix.</p>}
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Students" value={stats.students} />
        <Stat label="Managers" value={stats.managers} />
        <Stat label="Hostels" value={stats.hostels} sub={`${stats.verified_hostels} verified`} onClick={() => goto("hostels")} />
        <Stat label="Beds open" value={stats.open_beds} sub={`of ${stats.beds}`} />
        <Stat label="Active bookings" value={stats.active_bookings} onClick={() => goto("bookings")} />
        <Stat label="Service fees" value={cedis(stats.service_fees)} sub="non-refundable, all time" />
        <Stat label="To review" value={stats.payments_to_review} tone={stats.payments_to_review ? "warn" : undefined} onClick={() => goto("payments")} />
      </div>
    </div>
  );
}

/* ------------------------------ Hostels ------------------------------ */

function HostelsPanel({ onChanged }) {
  const [filter, setFilter] = useState("pending");
  const [hostels, setHostels] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setError("");
    return adminApi.hostels(filter).then(setHostels).catch((e) => setError(e.message));
  }, [filter]);

  useEffect(() => { setHostels(null); load(); }, [load]);

  async function setVerified(h, verified) {
    if (!verified && !window.confirm(`Revoke verification for ${h.name}? It will disappear from search and stop taking bookings.`)) return;
    setBusyId(h.id);
    setError("");
    try {
      await adminApi.verifyHostel(h.id, verified);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex gap-2" role="group" aria-label="Filter hostels">
          {[["pending", "Pending"], ["verified", "Verified"], ["all", "All"]].map(([id, label]) => (
            <button
              key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
              className={`text-sm px-3.5 py-1.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-rust ${filter === id ? "bg-ink text-paper" : "bg-ink/[0.06] text-ink/70"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={load} className="flex items-center gap-1.5 text-sm text-ink/60 hover:text-ink"><RefreshCw size={14} /> Refresh</button>
      </div>

      {filter === "pending" && (
        <p className="text-xs text-ink/60 bg-ink/[0.04] rounded-lg px-4 py-3 mb-5 leading-relaxed">
          Before you verify: call the manager on the number below, check the photos match the real building, and confirm the
          payout account is in the hostel's or the owner's name. Verified hostels receive student deposits directly.
        </p>
      )}

      <ErrorLine>{error}</ErrorLine>
      {!hostels && !error && <Spinner />}
      {hostels && hostels.length === 0 && (
        <p className="text-center text-sm text-ink/50 py-12">{filter === "pending" ? "Nothing waiting for verification." : "No hostels here yet."}</p>
      )}

      <div className="space-y-4">
        {(hostels || []).map((h) => (
          <article key={h.id} className="bg-white border border-ink/10 rounded-xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg text-ink">{h.name}</h3>
                <p className="text-sm text-ink/60">{h.area} · {h.gender_policy} · added {fmtDate(h.created_at)}</p>
              </div>
              <span className={`shrink-0 text-xs px-2.5 py-1 rounded-full ${h.verified ? "bg-forest/10 text-forest" : "bg-gold/15 text-[#7a5c14]"}`}>
                {h.verified ? "Verified" : "Pending"}
              </span>
            </div>

            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm mt-4">
              <div>
                <dt className="text-ink/50 text-xs">Manager</dt>
                <dd className="text-ink">{h.manager_name}</dd>
                <dd className="flex flex-wrap gap-x-4 text-rust text-sm">
                  <a className="flex items-center gap-1 hover:underline" href={`mailto:${h.manager_email}`}><Mail size={13} /> {h.manager_email}</a>
                  <a className="flex items-center gap-1 hover:underline" href={`tel:${h.manager_phone}`}><Phone size={13} /> {h.manager_phone}</a>
                </dd>
              </div>
              <div>
                <dt className="text-ink/50 text-xs">Listing</dt>
                <dd className="text-ink">{h.rooms} rooms · {h.beds} beds · {h.photos} photos</dd>
                <dd className={h.payments_connected ? "text-forest" : "text-[#7a5c14]"}>
                  {h.payments_connected ? "Payout account connected" : "No payout account yet"}
                </dd>
              </div>
            </dl>

            {!h.verified && !h.payments_connected && (
              <p className="text-xs text-[#7a5c14] mt-3">Students still can't book until the manager connects a payout account.</p>
            )}

            <div className="flex flex-wrap gap-2 mt-4">
              {h.verified ? (
                <button
                  type="button" disabled={busyId === h.id} onClick={() => setVerified(h, false)}
                  className="flex items-center gap-1.5 border border-danger/40 text-danger rounded-full px-4 py-2 text-sm font-medium hover:bg-danger/5 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-danger"
                >
                  {busyId === h.id ? <Loader2 size={14} className="animate-spin" /> : <ShieldOff size={14} />} Revoke verification
                </button>
              ) : (
                <button
                  type="button" disabled={busyId === h.id} onClick={() => setVerified(h, true)}
                  className="flex items-center gap-1.5 bg-ink text-paper rounded-full px-4 py-2 text-sm font-medium hover:bg-rust disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-rust focus-visible:ring-offset-2"
                >
                  {busyId === h.id ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Verify hostel
                </button>
              )}
              <a
                href={`/hostels/${h.id}`} target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 border border-ink/15 text-ink/70 rounded-full px-4 py-2 text-sm hover:border-rust/40 outline-none focus-visible:ring-2 focus-visible:ring-rust"
              >
                <ExternalLink size={14} /> Preview listing
              </a>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ Payments ------------------------------ */

function PaymentsPanel({ onChanged }) {
  const [showResolved, setShowResolved] = useState(false);
  const [payments, setPayments] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    return adminApi.paymentsToReview(showResolved).then(setPayments).catch((e) => setError(e.message));
  }, [showResolved]);

  useEffect(() => { setPayments(null); load(); }, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-display text-xl text-ink">{showResolved ? "Resolved payments" : "Payments needing review"}</h2>
        <button type="button" onClick={() => setShowResolved((v) => !v)} className="text-sm text-rust hover:underline">
          {showResolved ? "Show open ones" : "Show resolved"}
        </button>
      </div>
      {!showResolved && (
        <p className="text-xs text-ink/60 bg-ink/[0.04] rounded-lg px-4 py-3 mb-5 leading-relaxed">
          These are payments Paystack confirmed but we couldn't apply automatically (for example the bed was re-sold, or the
          amount was short). Refund or fix each in the Paystack dashboard using the reference, contact the student, then mark it resolved.
        </p>
      )}
      <ErrorLine>{error}</ErrorLine>
      {!payments && !error && <Spinner />}
      {payments && payments.length === 0 && (
        <p className="text-center text-sm text-ink/50 py-12 flex items-center justify-center gap-2">
          <CheckCircle2 size={16} className="text-forest" /> {showResolved ? "No resolved payments yet." : "All clear. Nothing to review."}
        </p>
      )}
      <div className="space-y-4">
        {(payments || []).map((p) => (
          <PaymentCard key={p.reference} p={p} onResolved={() => { load(); onChanged(); }} />
        ))}
      </div>
    </div>
  );
}

function PaymentCard({ p, onResolved }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function resolve(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await adminApi.resolvePayment(p.reference, note);
      onResolved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <article className="bg-white border border-ink/10 rounded-xl p-5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-ink/50 break-all">{p.reference}</p>
          <p className="font-display text-lg text-ink">{cedis(p.principal_amount)} <span className="text-sm text-ink/50 font-sans">{p.kind}</span></p>
        </div>
        <p className="text-xs text-ink/50">{fmtDate(p.created_at)}</p>
      </div>
      <p className="text-ink/70 mt-2">{p.review_reason}</p>
      <p className="mt-3 text-ink">
        {p.name} ·{" "}
        <a className="text-rust hover:underline" href={`tel:${p.phone}`}>{p.phone}</a> ·{" "}
        <a className="text-rust hover:underline" href={`mailto:${p.email}`}>{p.email}</a>
      </p>

      {p.resolved_at ? (
        <p className="mt-3 text-forest flex items-start gap-1.5"><CheckCircle2 size={15} className="mt-0.5 shrink-0" /> Resolved {fmtDate(p.resolved_at)}: {p.resolution_note}</p>
      ) : (
        <form onSubmit={resolve} className="mt-4 flex flex-col sm:flex-row gap-2">
          <label htmlFor={`note-${p.reference}`} className="sr-only">Resolution note</label>
          <input
            id={`note-${p.reference}`} required minLength={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="What was done? e.g. Refunded via Paystack"
            className="flex-1 border border-ink/15 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-rust"
          />
          <button
            type="submit" disabled={busy}
            className="bg-ink text-paper rounded-full px-5 py-2 text-sm font-medium hover:bg-rust disabled:opacity-60 flex items-center justify-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-rust"
          >
            {busy && <Loader2 size={14} className="animate-spin" />} Mark resolved
          </button>
        </form>
      )}
      <div className="mt-2"><ErrorLine>{error}</ErrorLine></div>
    </article>
  );
}

/* ------------------------------ Bookings ------------------------------ */

function BookingsPanel() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi.bookings().then(setRows).catch((e) => setError(e.message));
  }, []);

  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!rows) return <Spinner />;
  if (rows.length === 0) return <p className="text-center text-sm text-ink/50 py-12">No bookings yet.</p>;

  return (
    <div className="bg-white border border-ink/10 rounded-xl divide-y divide-ink/10">
      {rows.map((b) => (
        <div key={b.id} className="p-4 grid sm:grid-cols-[1.4fr_1.2fr_1fr_auto] gap-x-4 gap-y-1 text-sm items-center">
          <div>
            <p className="text-ink font-medium">{b.student_name}</p>
            <a className="text-rust text-xs hover:underline" href={`tel:${b.student_phone}`}>{b.student_phone}</a>
          </div>
          <p className="text-ink/70">{b.hostel_name} · {b.room_code}</p>
          <p className="font-mono text-xs text-ink/60">
            paid {cedis(b.deposit_amount)}<br />owes {cedis(b.balance_amount)} by {fmtDate(b.balance_due_date)}
          </p>
          <span className={`justify-self-start sm:justify-self-end text-xs px-2.5 py-1 rounded-full ${BOOKING_TONES[b.status] || "bg-ink/10 text-ink/60"}`}>
            {b.status.replace("_", " ")}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ Account ------------------------------ */

function AccountPanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setDone(false);
    if (next.length < 12) return setError("New password must be at least 12 characters.");
    if (next !== confirm) return setError("The two new passwords don't match.");
    setBusy(true);
    try {
      await adminApi.changePassword(current, next);
      setDone(true);
      setCurrent(""); setNext(""); setConfirm("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm">
      <h2 className="font-display text-xl text-ink mb-1">Change admin password</h2>
      <p className="text-sm text-ink/60 mb-5">Use 12+ characters. Mix words, numbers and symbols; avoid anything guessable.</p>
      <form onSubmit={submit} className="space-y-3">
        <PasswordField id="adm-cur" required autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <PasswordField id="adm-new" required autoComplete="new-password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} />
        <PasswordField id="adm-conf" required autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <ErrorLine>{error}</ErrorLine>
        {done && <p role="status" className="text-sm text-forest flex items-center gap-1.5"><CheckCircle2 size={15} /> Password updated.</p>}
        <button
          type="submit" disabled={busy}
          className="bg-ink text-paper rounded-full px-6 py-2.5 text-sm font-medium hover:bg-rust disabled:opacity-60 flex items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-rust"
        >
          {busy && <Loader2 size={14} className="animate-spin" />} Update password
        </button>
      </form>
    </div>
  );
}
