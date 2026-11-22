import { useEffect, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { api } from "../api/client.js";

/**
 * Paystack redirects here after checkout. Asks the server to confirm
 * the payment. The server ALSO gets a webhook from Paystack, so the booking
 * is created even if the student never reaches this page; whichever arrives
 * first wins and the other is a harmless no-op.
 */
export default function PaymentCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("verifying"); // verifying | success | error
  const [error, setError] = useState("");
  const isBalancePayment = params.get("type") === "balance";

  useEffect(() => {
    // Only the reference is trusted by the server; it knows which bed or
    // booking the payment was for from its own ledger.
    const reference = params.get("reference") || params.get("trxref");
    if (!reference) {
      setStatus("error");
      setError("Missing payment reference. If you completed payment, contact support — it will still be applied.");
      return;
    }

    const confirm = isBalancePayment ? api.verifyBalancePayment : api.verifyPayment;
    confirm({ reference })
      .then(() => setStatus("success"))
      .catch((err) => {
        setStatus("error");
        setError(`${err.message || "Couldn't confirm your payment."} Your reference: ${reference}`);
      });
  }, [params, isBalancePayment]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-sm w-full text-center">
        {status === "verifying" && (
          <>
            <Loader2 className="animate-spin text-ink/40 mx-auto mb-4" size={32} />
            <h1 className="font-display text-xl text-ink mb-2">Confirming your payment…</h1>
            <p className="text-sm text-ink/50">Don't close this page — this only takes a moment.</p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle2 className="text-forest mx-auto mb-4" size={40} />
            <h1 className="font-display text-xl text-ink mb-2">
              {isBalancePayment ? "Balance paid in full" : "Room secured"}
            </h1>
            <p className="text-sm text-ink/60 mb-6">
              A receipt has been sent by SMS and email.{" "}
              {isBalancePayment ? "Your booking is now fully settled." : "Your booking is now in your dashboard."}
            </p>
            <button
              onClick={() => navigate("/dashboard")}
              className="bg-ink text-paper rounded-full px-6 py-2.5 text-sm font-medium hover:bg-rust outline-none focus-visible:ring-2 focus-visible:ring-rust"
            >
              Go to my dashboard
            </button>
          </>
        )}

        {status === "error" && (
          <>
            <XCircle className="text-danger mx-auto mb-4" size={40} />
            <h1 className="font-display text-xl text-ink mb-2">Something went wrong</h1>
            <p className="text-sm text-ink/60 mb-6">{error}</p>
            <Link
              to="/dashboard"
              className="inline-block bg-ink text-paper rounded-full px-6 py-2.5 text-sm font-medium hover:bg-rust"
            >
              Go to my dashboard
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
