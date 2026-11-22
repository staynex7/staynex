import { Link, useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Home, ArrowLeft } from "lucide-react";

/**
 * Shown for any unknown URL and for hostel ids that don't exist. Tagged
 * noindex so search engines don't list dead links.
 */
export default function NotFound({ title = "This page drifted off course", message }) {
  const navigate = useNavigate();

  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-deep via-ink to-rust text-white">
      <Helmet>
        <title>Page not found — StayNex</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      {/* soft "waves" along the bottom */}
      <svg aria-hidden="true" viewBox="0 0 1440 120" preserveAspectRatio="none" className="absolute bottom-0 left-0 w-full h-24 sm:h-32 text-paper">
        <path fill="currentColor" d="M0,64 C240,112 480,16 720,56 C960,96 1200,24 1440,64 L1440,120 L0,120 Z" />
      </svg>

      <div className="relative px-6 sm:px-10 pt-16 sm:pt-24 pb-36 sm:pb-44 max-w-2xl mx-auto text-center">
        <svg aria-hidden="true" viewBox="0 0 64 64" className="w-16 h-16 mx-auto mb-6">
          <circle cx="28" cy="28" r="24" fill="#8FD0F5" fillOpacity="0.25" />
          <path d="M28 14 L42 25 L38 25 L38 38 L18 38 L18 25 L14 25 Z" fill="#fff" />
          <rect x="25" y="30" width="6" height="8" fill="#08304F" />
          <circle cx="44" cy="44" r="11" fill="none" stroke="#8FD0F5" strokeWidth="4" />
          <line x1="52" y1="52" x2="60" y2="60" stroke="#8FD0F5" strokeWidth="5" strokeLinecap="round" />
        </svg>

        <p className="font-mono text-xs uppercase tracking-widest text-sky mb-3">Error 404</p>
        <h1 className="font-display text-4xl sm:text-5xl leading-[1.1] mb-4">{title}</h1>
        <p className="text-white/75 max-w-md mx-auto mb-8 leading-relaxed">
          {message || "We couldn't find the page you were looking for. It may have moved, or the link might be mistyped."}
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            to="/"
            className="inline-flex items-center justify-center gap-2 bg-white text-ink rounded-full px-6 py-2.5 text-sm font-medium hover:bg-sky outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
          >
            <Home size={16} /> Browse hostels
          </Link>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center justify-center gap-2 border border-white/40 text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-white/10 outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ArrowLeft size={16} /> Go back
          </button>
        </div>
      </div>
    </div>
  );
}
