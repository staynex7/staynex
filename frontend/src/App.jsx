import { useState, useEffect } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { ListChecks } from "lucide-react";
import Header from "./components/Header.jsx";
import Browse from "./pages/Browse.jsx";
import HostelDetail from "./pages/HostelDetail.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import ManagerDashboard from "./pages/ManagerDashboard.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import ResetPassword from "./pages/ResetPassword.jsx";
import PaymentCallback from "./pages/PaymentCallback.jsx";
import NotFound from "./pages/NotFound.jsx";
import AdminLogin from "./pages/AdminLogin.jsx";
import AdminDashboard from "./pages/AdminDashboard.jsx";
import RequireAuth from "./components/RequireAuth.jsx";
import { sessionAuth } from "./api/client.js";

// Account, checkout and admin-ish pages have nothing to rank for — keep them out of search results.
const NOINDEX_PREFIXES = ["/login", "/signup", "/forgot-password", "/reset-password", "/dashboard", "/manager", "/payment-callback", "/admin"];

function NoIndex() {
  const { pathname } = useLocation();
  if (!NOINDEX_PREFIXES.some((p) => pathname.startsWith(p))) return null;
  return <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>;
}

export default function App() {
  const [user, setUser] = useState(sessionAuth.user);
  const navigate = useNavigate();
  const location = useLocation();
  const isAdminArea = location.pathname.startsWith("/admin");

  // A 401 anywhere (expired token) clears the session; send them to log in and bring them back.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      navigate("/login", { replace: true, state: { redirectTo: window.location.pathname + window.location.search, expired: true } });
    };
    window.addEventListener("staynex:session-expired", onExpired);
    return () => window.removeEventListener("staynex:session-expired", onExpired);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-paper font-sans text-ink">
      <NoIndex />
      {!isAdminArea && <Header user={user} onLogout={() => setUser(null)} />}

      <main>
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/hostels/:id" element={<HostelDetail />} />
          <Route path="/login" element={<Login onAuthed={setUser} />} />
          <Route path="/signup" element={<Signup onAuthed={setUser} />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route
            path="/dashboard"
            element={<RequireAuth role="student"><Dashboard /></RequireAuth>}
          />
          <Route
            path="/manager"
            element={<RequireAuth role="manager"><ManagerDashboard /></RequireAuth>}
          />
          <Route
            path="/payment-callback"
            element={<RequireAuth role="student"><PaymentCallback /></RequireAuth>}
          />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      {!isAdminArea && <footer className="px-6 sm:px-10 py-8 border-t border-ink/10 flex items-center justify-between text-xs text-ink/40">
        <span>StayNex · Student Hostel Booking</span>
        <span className="flex items-center gap-1.5"><ListChecks size={13} /> 2026/27 academic year</span>
      </footer>}
    </div>
  );
}
