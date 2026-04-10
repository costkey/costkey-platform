import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";

export default function Invite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "signup" | "accepted" | "error">("loading");
  const [error, setError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");

  // Check if user is logged in and try to accept
  useEffect(() => {
    if (!token) { setStatus("error"); setError("Invalid invite link"); return; }

    // Try to accept the invite (works if user is already logged in)
    fetch("/api/v1/team/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          setStatus("accepted");
          setTimeout(() => navigate("/"), 2000);
        } else {
          const data = await res.json();
          if (res.status === 404) {
            // Invite not found or user needs to sign up first
            setStatus("signup");
          } else {
            setStatus("error");
            setError(data.error || "Failed to accept invite");
          }
        }
      })
      .catch(() => {
        // Not logged in — need to sign up
        setStatus("signup");
      });
  }, [token, navigate]);

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8 mt-4">
          <img src="/favicon.svg" alt="CostKey" className="w-8 h-8" />
          <span className="font-mono text-lg font-semibold text-text-primary">CostKey</span>
        </div>

        <div className="bg-surface-raised border border-border rounded-sm p-6">
          {status === "loading" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-text-secondary">Accepting invite...</p>
            </div>
          )}

          {status === "accepted" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="text-3xl">✅</div>
              <h2 className="text-lg font-semibold text-text-primary">You're in!</h2>
              <p className="text-sm text-text-secondary text-center">Invite accepted. Redirecting to dashboard...</p>
            </div>
          )}

          {status === "signup" && (
            <div className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-text-primary">You've been invited to CostKey</h2>
              <p className="text-sm text-text-secondary">Create an account to join the team. Your invite will be automatically accepted.</p>
              <Link
                to={`/signup?invite=${token}`}
                className="w-full bg-accent hover:bg-accent-hover text-white text-center py-2.5 rounded-sm text-sm font-medium transition-colors"
              >
                Create Account
              </Link>
              <p className="text-xs text-text-muted text-center">
                Already have an account? <Link to="/login" className="text-accent">Sign in</Link>
              </p>
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="text-3xl">❌</div>
              <h2 className="text-lg font-semibold text-text-primary">Invite failed</h2>
              <p className="text-sm text-text-secondary text-center">{error}</p>
              <Link to="/signup" className="text-sm text-accent">Create an account instead</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
