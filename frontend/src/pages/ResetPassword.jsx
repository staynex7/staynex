import { useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import PasswordField from "../components/PasswordField.jsx";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters");
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate("/login"), 1800);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="max-w-sm mx-auto px-6 py-16">
        <p className="text-sm text-ink/60 mb-4">This reset link is missing its token.</p>
        <Link to="/forgot-password" className="text-rust font-medium text-sm">Request a new link</Link>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto px-6 py-16">
      <h1 className="font-display text-2xl text-ink mb-6">Choose a new password</h1>
      {done ? (
        <p className="text-sm text-forest">Password updated. Taking you to log in…</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="rp-password" className="sr-only">New password</label>
            <PasswordField id="rp-password" required placeholder="New password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-danger text-sm">
              {error} <Link to="/forgot-password" className="underline">Request a new link</Link>
            </p>
          )}
          <button type="submit" disabled={busy} className="w-full bg-ink text-paper rounded-full py-2.5 font-medium hover:bg-rust disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-rust focus-visible:ring-offset-2">
            {busy ? "Saving…" : "Update password"}
          </button>
        </form>
      )}
    </div>
  );
}
