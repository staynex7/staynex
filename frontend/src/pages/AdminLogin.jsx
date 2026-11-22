import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { ShieldCheck, Loader2 } from "lucide-react";
import { adminApi, adminSession } from "../api/client.js";
import PasswordField from "../components/PasswordField.jsx";

/** Separate sign-in for platform staff. Not linked from anywhere on the public site. */
export default function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (adminSession.token) navigate("/admin", { replace: true });
  }, [navigate]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { token, admin } = await adminApi.login(email, password);
      adminSession.set(token, admin);
      navigate("/admin", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-deep via-ink to-rust flex items-center justify-center px-6 py-12">
      <Helmet>
        <title>Admin sign in</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={20} className="text-rust" />
          <p className="font-display text-xl text-ink">
            <span className="text-rust font-semibold">stay</span><span className="font-black">NEX</span> Admin
          </p>
        </div>
        <p className="text-sm text-ink/60 mb-6">Authorised staff only.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="admin-email" className="sr-only">Admin email</label>
            <input
              id="admin-email" type="email" required autoComplete="username" placeholder="Admin email"
              value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-ink/15 rounded-lg px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-rust"
            />
          </div>
          <div>
            <label htmlFor="admin-password" className="sr-only">Admin password</label>
            <PasswordField
              id="admin-password" required autoComplete="current-password" placeholder="Admin password"
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p role="alert" className="text-sm text-[#a33a2e]">{error}</p>}
          <button
            type="submit" disabled={busy}
            className="w-full bg-ink text-paper rounded-full py-2.5 font-medium hover:bg-rust disabled:opacity-60 flex items-center justify-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-rust focus-visible:ring-offset-2"
          >
            {busy && <Loader2 size={16} className="animate-spin" />} Sign in
          </button>
        </form>

        <Link to="/" className="block text-center text-xs text-ink/40 hover:text-ink mt-6">Back to StayNex</Link>
      </div>
    </div>
  );
}
