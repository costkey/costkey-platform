import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";

type InviteErrorCode =
  | "invite_not_found"
  | "invite_revoked"
  | "invite_already_accepted"
  | "invite_expired"
  | "invite_email_mismatch"
  | "invite_race"
  | "would_orphan_org";

export default function Invite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "signup" | "accepted" | "error">("loading");
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<InviteErrorCode | null>(null);

  useEffect(() => {
    if (!token) { setStatus("error"); setError("Invalid invite link"); return; }

    // Try to accept the invite — succeeds if the user is already logged in as
    // the invited email. If 401 (not logged in), fall through to signup.
    fetch("/api/v1/team/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          setStatus("accepted");
          // Hard reload so AuthContext picks up the new orgId from the cookie/JWT
          setTimeout(() => { window.location.href = "/"; }, 1500);
          return;
        }

        const data = await res.json().catch(() => ({}));
        const code = (data.code ?? null) as InviteErrorCode | null;

        // Not authenticated → route to signup with the token pre-filled
        if (res.status === 401) {
          setStatus("signup");
          return;
        }

        // Invite not found AND user is logged in — either bad link or already
        // consumed. Show error with a signup fallback.
        if (code === "invite_not_found" || res.status === 404) {
          setStatus("error");
          setError(data.error ?? "This invite is invalid");
          setErrorCode(code);
          return;
        }

        setStatus("error");
        setError(data.error ?? "Failed to accept invite");
        setErrorCode(code);
      })
      .catch(() => {
        // Network error — let the user try signup as a fallback
        setStatus("signup");
      });
  }, [token, navigate]);

  const errorActions = () => {
    switch (errorCode) {
      case "invite_email_mismatch":
        return (
          <div className="flex flex-col gap-2 text-center">
            <p className="text-xs text-text-muted">
              You're signed in with a different email than the one the invite was sent to.
            </p>
            <Link to="/logout" className="text-sm text-accent">Sign out and try again</Link>
          </div>
        );
      case "would_orphan_org":
        return (
          <p className="text-xs text-text-muted text-center">
            Go to Settings → Team and transfer ownership to another member before joining a new org.
          </p>
        );
      case "invite_expired":
      case "invite_revoked":
        return (
          <p className="text-xs text-text-muted text-center">
            Ask an admin of the inviting organization to send you a new invite.
          </p>
        );
      case "invite_already_accepted":
        return (
          <Link to="/login" className="text-sm text-accent">Sign in</Link>
        );
      default:
        return (
          <Link to="/signup" className="text-sm text-accent">Create an account instead</Link>
        );
    }
  };

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
              <a
                href={`/auth/github?invite=${encodeURIComponent(token ?? "")}`}
                className="w-full flex items-center justify-center gap-2 bg-surface-overlay hover:bg-surface-hover border border-border rounded-sm px-3 py-2.5 text-sm text-text-primary font-medium transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
                </svg>
                Continue with GitHub
              </a>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <Link
                to={`/signup?invite=${token}`}
                className="w-full bg-accent hover:bg-accent-hover text-black text-center py-2.5 rounded-sm text-sm font-medium transition-colors"
              >
                Create Account with Email
              </Link>
              <p className="text-xs text-text-muted text-center">
                Already have an account? <Link to={`/login?invite=${token}`} className="text-accent">Sign in</Link>
              </p>
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="text-3xl">❌</div>
              <h2 className="text-lg font-semibold text-text-primary">Invite unavailable</h2>
              <p className="text-sm text-text-secondary text-center">{error}</p>
              {errorActions()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
