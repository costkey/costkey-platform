import { useState, type ReactNode } from "react";
import { GitBranch, ArrowRight, LoaderCircle } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { BrandLockup } from "../components/BrandMark";

/** Brand panel for the signed-out pages: a glimpse of what the console shows. */
export function AuthBrandPanel() {
  return (
    <section className="auth-brand" aria-label="CostKey">
      <BrandLockup className="logo auth-brand-lockup" markClassName="logo-mark auth-brand-mark" aria-label="CostKey" />
      <div className="auth-brand-copy">
        <h1>A little<br /><em>light on.</em></h1>
      </div>
      <div className="auth-preview" aria-hidden="true">
        <div className="auth-preview-card auth-preview-run">
          <div className="auth-preview-row"><span className="auth-preview-kind">Agent</span><strong>support-agent</strong><span className="auth-preview-cost">$0.042</span></div>
          {[["Plan", 4, 18, "step"], ["search_orders", 22, 16, "tool"], ["Answer", 38, 46, "step"], ["Judge", 84, 12, "judge"]].map(([label, offset, width, kind]) => (
            <div className="auth-preview-span" key={label as string}>
              <span>{label}</span>
              <i><b className={`kind-${kind}`} style={{ marginLeft: `${offset}%`, width: `${width}%` }} /></i>
            </div>
          ))}
        </div>
        <div className="auth-preview-card auth-preview-budget">
          <div className="auth-preview-row"><span>Monthly budget</span><strong>$612 of $800</strong></div>
          <i className="auth-preview-meter"><b style={{ width: "76%" }} /></i>
          <div className="auth-preview-row auth-preview-muted"><span>Alerts at 80%</span><span>Stops at 100%</span></div>
        </div>
        <div className="auth-preview-card auth-preview-spend">
          <div className="auth-preview-row"><span>Spend this month</span><strong>$612.40</strong></div>
          <svg viewBox="0 0 240 56" preserveAspectRatio="none"><path d="M0 52 L20 49 L40 47 L60 42 L80 40 L100 33 L120 30 L140 26 L160 20 L180 17 L200 12 L220 9 L240 5" /><path className="auth-preview-pace" d="M0 52 L240 14" /></svg>
        </div>
      </div>
    </section>
  );
}

export function AuthFooter() {
  return (
    <footer className="auth-panel-footer">
      <span className="auth-footer-links">
        <a href="https://costkey.dev/docs" target="_blank" rel="noopener noreferrer">Docs</a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/costkey-ai/costkey" target="_blank" rel="noopener noreferrer">GitHub</a>
      </span>
    </footer>
  );
}

/**
 * The designer prototype deliberately treats authentication as a configured
 * handoff. Keep that surface as a real React route so the shipped console can
 * be compared against the reference without pulling the prototype HTML into
 * the app or exposing a made-up provider flow.
 */
export function PrototypeAuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="ck-proto-auth-shell">
      <section className="ck-proto-auth-brand" aria-label="CostKey">
        <BrandLockup className="ck-proto-auth-lockup" markClassName="ck-proto-auth-mark" aria-label="CostKey" />
        <h1>A little<br /><em>light on.</em></h1>
        <img
          src="/assets/console/hero.png"
          className="ck-proto-auth-hero"
          alt="The observatory illustration from the supplied CostKey design language"
        />
      </section>
      <main className="ck-proto-auth-panel">
        <div className="ck-proto-auth-mobile-lockup"><BrandLockup className="ck-proto-auth-lockup" markClassName="ck-proto-auth-mark" aria-label="CostKey" /></div>
        {children}
        <div className="ck-proto-auth-caption">Synthetic design preview · No live authentication</div>
        <div className="ck-proto-auth-index"><Link to="/catalog">View every screen</Link></div>
      </main>
    </div>
  );
}

function PrototypeSignIn({ state }: { state: string | null }) {
  return (
    <PrototypeAuthFrame>
      <div className="ck-proto-auth-eyebrow">Your AI work, in sight</div>
      <h1>Welcome to CostKey</h1>
      <p>Keep building. Know what it costs.</p>
      <section className="ck-proto-auth-card">
        <div className="ck-proto-account-row">
          <span className="ck-proto-avatar">AM</span>
          <div><b>Alex Morgan</b><span>alex@example.com · Synthetic account</span></div>
        </div>
        <div className="ck-proto-divider" />
        <p className="ck-proto-card-copy">Continue through your workspace’s configured sign-in. You’ll return to the resource you opened.</p>
        <button className="ck-button ck-button-primary ck-proto-wide-button" type="button">
          <ArrowRight size={14} aria-hidden="true" /> Continue to workspace
        </button>
      </section>
      <div className="ck-proto-create-link"><Link to="/onboarding?design=prototype&step=workspace">Create a workspace</Link></div>
      <p className="ck-proto-auth-copy">Authentication is a design handoff. No password, SSO or sign-in provider is invented by this prototype.</p>
      {state === "error" && <div className="ck-proto-auth-notice" role="alert"><strong>Could not complete sign-in</strong><span>No credentials were submitted. Your intended destination has been retained.</span></div>}
      {state === "loading" && <p className="ck-proto-auth-loading">Signing you in…</p>}
    </PrototypeAuthFrame>
  );
}

export default function Login() {
  const { login, error } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const state = searchParams.get("state");
  const design = searchParams.get("design");
  const ghError = searchParams.get("error");
  const inviteToken = searchParams.get("invite");
  const safeDestination = safeReturnTo(searchParams.get("returnTo"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (design === "prototype") return <PrototypeSignIn state={state} />;

  const githubQuery = new URLSearchParams();
  if (inviteToken) githubQuery.set("invite", inviteToken);
  if (safeDestination) githubQuery.set("returnTo", safeDestination);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    const ok = await login(email, password);
    setSubmitting(false);
    if (!ok) return;

    if (searchParams.get("cli") === "1") navigate("/cli-auth");
    else if (inviteToken) navigate(`/invite/${encodeURIComponent(inviteToken)}`);
    else navigate(safeDestination ?? "/");
  };

  const authError = error ?? (ghError === "github_no_email"
    ? "GitHub didn’t share an email. Use an account with a verified email, or sign in with email."
    : ghError
      ? "Couldn’t sign in with GitHub. Try again, or use email."
      : state === "error"
        ? "Couldn’t sign you in. Try again."
        : null);
  const isLoadingPreview = state === "loading";

  return (
    <div className="auth-shell">
      <AuthBrandPanel />
      <main className="auth-panel">
        <div className="auth-mobile-logo">
          <BrandLockup className="logo" markClassName="logo-mark" aria-label="CostKey" />
        </div>

        <div className="auth-panel-inner">
          <h1>Welcome to CostKey</h1>

          {isLoadingPreview && (
            <div className="auth-state auth-state-loading" role="status" aria-live="polite">
              <LoaderCircle size={16} className="auth-state-icon auth-spin" aria-hidden="true" />
              <span>Signing you in…</span>
            </div>
          )}

          <div className="auth-form-card">
            <a
              href={githubQuery.toString() ? `/auth/github?${githubQuery.toString()}` : "/auth/github"}
              className="ck-button ck-button-secondary auth-provider"
              aria-disabled={isLoadingPreview || submitting ? "true" : undefined}
            >
              <GitBranch size={16} aria-hidden="true" />
              Continue with GitHub
            </a>

            <div className="auth-divider" aria-hidden="true"><span>or continue with email</span></div>

            <form className="auth-form" onSubmit={handleSubmit} aria-busy={submitting || isLoadingPreview}>
              <div className="auth-field">
                <label className="auth-label" htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  className="ck-input auth-input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  required
                  disabled={isLoadingPreview || submitting}
                />
              </div>
              <div className="auth-field">
                <div className="auth-label-row">
                  <label className="auth-label" htmlFor="login-password">Password</label>
                  <span className="auth-field-hint">8+ characters</span>
                </div>
                <input
                  id="login-password"
                  className="ck-input auth-input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  disabled={isLoadingPreview || submitting}
                />
              </div>

              {authError && (
                <div className="auth-error" role="alert" aria-live="polite">{authError}</div>
              )}

              <button className="ck-button ck-button-primary auth-submit" type="submit" disabled={submitting || isLoadingPreview}>
                {submitting ? <><LoaderCircle size={15} className="auth-spin" aria-hidden="true" /> Signing in…</> : <>Continue to workspace <ArrowRight size={15} aria-hidden="true" /></>}
              </button>
            </form>
          </div>

          <p className="auth-switch-copy">
            New to CostKey? <Link to={`/signup${inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ""}`}>Create a workspace</Link>
          </p>
        </div>

        <AuthFooter />
      </main>
    </div>
  );
}

function safeReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const resolved = new URL(raw, window.location.origin);
    if (resolved.origin !== window.location.origin || !resolved.pathname.startsWith("/") || resolved.pathname.startsWith("//")) return null;
    if (resolved.pathname.startsWith("/login") || resolved.pathname.startsWith("/signup") || resolved.pathname.startsWith("/auth")) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}
