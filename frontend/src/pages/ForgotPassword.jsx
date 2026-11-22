import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto px-6 py-16">
      <h1 className="font-display text-2xl text-ink mb-2">Reset your password</h1>
      {sent ? (
        <>
          <p className="text-sm text-ink/60 mb-6">
            If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in 1 hour.
          </p>
          <Link to="/login" className="text-rust font-medium text-sm">Back to log in</Link>
        </>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-sm text-ink/60">Enter your email and we'll send you a link to choose a new password.</p>
          <div>
            <label htmlFor="fp-email" className="sr-only">Email</label>
            <input
              id="fp-email" type="email" required placeholder="Email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-ink/15 rounded-lg px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-rust"
            />
          </div>
          {error && <p role="alert" className="text-danger text-sm">{error}</p>}
          <button type="submit" disabled={busy} className="w-full bg-ink text-paper rounded-full py-2.5 font-medium hover:bg-rust disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-rust focus-visible:ring-offset-2">
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
    </div>
  );
}
