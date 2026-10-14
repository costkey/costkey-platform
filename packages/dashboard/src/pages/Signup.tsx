import { appUrl } from "../basePath";
import { useState } from "react";
import { ArrowRight, GitBranch, LoaderCircle } from "lucide-react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { useAuthConfig } from "../authConfig";
import { BrandLockup } from "../components/BrandMark";
import { AuthBrandPanel, AuthFooter } from "./Login";

export default function Signup() {
  const { signup, error } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get("invite");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const authConfig = useAuthConfig();

  // Single sign-on servers have no signup: the first sign-in creates the account.
  if (authConfig && authConfig.mode !== "password") {
    const query = searchParams.get("cli") === "1" ? "?cli=1" : "";
    return <Navigate to={`/login${query}`} replace />;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    const result = await signup(email, password, name, orgName || name, inviteToken ?? undefined);
    setSubmitting(false);
    if (!result) return;

    if (searchParams.get("cli") === "1") navigate("/cli-auth");
    else if (result.joinedViaInvite) navigate("/");
    else navigate("/onboarding");
  };

  const githubHref = inviteToken
    ? appUrl(`/auth/github?invite=${encodeURIComponent(inviteToken)}`)
    : appUrl("/auth/github");

  return (
    <div className="auth-shell">
      <AuthBrandPanel />
      <main className="auth-panel">
        <div className="auth-mobile-logo">
          <a href={appUrl("/login")} aria-label="CostKey home"><BrandLockup className="logo" markClassName="logo-mark" /></a>
        </div>

        <div className="auth-panel-inner">
          <div className="auth-eyebrow">Start with a clear view</div>
          <h1>{inviteToken ? "Create your account" : "Create a workspace"}</h1>
          <p className="auth-lede">Track the cost of your AI work from the first call.</p>

          {inviteToken && (
            <div className="auth-context-note">
              You’re joining an existing workspace. Your invitation sets what you can see.
            </div>
          )}

          <div className="auth-form-card">
            <a href={githubHref} className="ck-button ck-button-secondary auth-provider">
              <GitBranch size={16} aria-hidden="true" />
              Continue with GitHub
            </a>
            <div className="auth-divider" aria-hidden="true"><span>or use email</span></div>

            <form className="auth-form" onSubmit={handleSubmit} aria-busy={submitting}>
              <div className="auth-field">
                <label className="auth-label" htmlFor="signup-name">Your name</label>
                <input id="signup-name" className="ck-input auth-input" type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Jane Doe" autoComplete="name" required disabled={submitting} />
              </div>
              <div className="auth-field">
                <label className="auth-label" htmlFor="signup-email">Work email</label>
                <input id="signup-email" className="ck-input auth-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="jane@company.com" autoComplete="email" required disabled={submitting} />
              </div>
              <div className="auth-field">
                <div className="auth-label-row">
                  <label className="auth-label" htmlFor="signup-password">Password</label>
                  <span className="auth-field-hint">At least 8 characters</span>
                </div>
                <input id="signup-password" className="ck-input auth-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Create a password" autoComplete="new-password" minLength={8} required disabled={submitting} />
              </div>
              <div className="auth-field">
                <label className="auth-label" htmlFor="signup-org">Workspace name <span className="auth-optional">(optional)</span></label>
                <input id="signup-org" className="ck-input auth-input" type="text" value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder="Acme AI" autoComplete="organization" disabled={submitting} />
              </div>

              {error && <div className="auth-error" role="alert" aria-live="polite">{error}</div>}

              <button className="ck-button ck-button-primary auth-submit" type="submit" disabled={submitting}>
                {submitting ? <><LoaderCircle size={15} className="auth-spin" aria-hidden="true" /> Creating account…</> : <>Create workspace <ArrowRight size={15} aria-hidden="true" /></>}
              </button>
            </form>
          </div>

          <p className="auth-switch-copy">Already have an account? <Link to={`/login${inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ""}`}>Sign in</Link></p>
          <p className="auth-caption">New workspaces record cost and usage only. Storing prompts is your choice.</p>
        </div>
        <AuthFooter />
      </main>
    </div>
  );
}
