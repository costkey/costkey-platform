import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, GitBranch, LoaderCircle, Lock, RefreshCw, UserRound } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { BrandLockup } from "../components/BrandMark";
import { AuthBrandPanel, AuthFooter, PrototypeAuthFrame } from "./Login";

type InviteErrorCode =
  | "invite_not_found"
  | "invite_revoked"
  | "invite_already_accepted"
  | "invite_expired"
  | "invite_email_mismatch"
  | "invite_race"
  | "would_orphan_org";

interface InvitePreview {
  email: string;
  role: "owner" | "admin" | "developer" | "viewer" | string;
  expiresAt: string;
  workspace: { id: string; name: string };
  inviter: { name: string };
  projects: Array<{ id: string; name: string }>;
}

const demoPreview: InvitePreview = {
  email: "alex@example.com",
  role: "viewer",
  expiresAt: "2026-09-27T23:59:59.000Z",
  workspace: { id: "northstar", name: "Northstar" },
  inviter: { name: "Jordan Lee" },
  projects: [{ id: "atlas", name: "Atlas" }],
};

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // Invitation expiry is a calendar date from the server, not a moment to
  // reinterpret in the viewer's timezone. UTC keeps 27 Sep from becoming 28
  // Sep for users east of Greenwich.
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="auth-detail-row"><span>{label}</span><strong>{children}</strong></div>;
}

function PrototypeInvite({ state, onSwitch }: { state: string | null; onSwitch: () => void }) {
  const fatal = state === "expired" || state === "removed" || state === "offline";
  if (fatal) {
    const title = state === "expired" ? "This invitation has expired" : state === "removed" ? "Workspace access was removed" : "Couldn’t load this invitation";
    const copy = state === "expired"
      ? "Ask the person who invited you to send a new one."
      : state === "removed"
        ? "This invitation no longer works. Go back to a workspace you can open."
        : "Check your connection and try again.";
    return <PrototypeAuthFrame><div className="ck-proto-auth-empty"><div className="ck-proto-empty-icon"><Lock size={18} aria-hidden="true" /></div><h2>{title}</h2><p>{copy}</p><button className="ck-button ck-button-primary" type="button" onClick={onSwitch}>{state === "offline" ? "Retry" : state === "expired" ? "Request a new invitation" : "Back to sign in"}</button></div></PrototypeAuthFrame>;
  }

  const mismatch = state === "account-mismatch";
  const accepted = state === "accepted";
  return (
    <PrototypeAuthFrame>
      <div className="ck-proto-invite-main">
        <div className="ck-proto-auth-eyebrow">Workspace invitation</div>
        <h1>{accepted ? "You’re already a member" : "You’re invited to Northstar"}</h1>
        <p>Jordan Lee invited you to explore Atlas’s spending.</p>
        <section className="ck-proto-invite-card">
          <div className="ck-proto-detail-row"><span>Workspace</span><strong>Northstar</strong></div>
          <div className="ck-proto-detail-row"><span>Project access</span><strong>Atlas</strong></div>
          <div className="ck-proto-detail-row"><span>Intended role</span><strong>Viewer</strong></div>
          <p className="ck-proto-invite-copy">You’ll see costs and usage. Prompts and code locations are hidden for Viewers.</p>
        </section>
        <div className="ck-proto-invite-notice"><b>Signed in as {mismatch ? "another.account@example.com" : "alex@example.com"}</b><br />{mismatch ? "This differs from the invited account. Switch before accepting." : "Invitation for alex@example.com · Expires 27 Sep 2026"}</div>
        <div className="ck-proto-invite-actions">
          <button className="ck-button ck-button-primary" type="button" onClick={onSwitch}>{accepted ? "Open workspace" : mismatch ? "Switch account" : "Accept invitation"}</button>
          <button className="ck-button ck-button-secondary" type="button" onClick={onSwitch}>Switch account</button>
        </div>
        <p className="ck-proto-invite-caption">This link only works for the invited email address.</p>
      </div>
    </PrototypeAuthFrame>
  );
}

export default function Invite() {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading, logout } = useAuth();
  const requestedState = searchParams.get("state");
  const design = searchParams.get("design");
  const forcedState = requestedState && ["account-mismatch", "expired", "accepted", "removed", "offline", "loading", "error"].includes(requestedState)
    ? requestedState
    : null;
  const [status, setStatus] = useState<"loading" | "preview" | "accepting" | "accepted" | "error">(() => token ? "loading" : "error");
  const [error, setError] = useState(() => token ? "" : "Invalid invitation link.");
  const [errorCode, setErrorCode] = useState<InviteErrorCode | null>(null);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [acceptChecked, setAcceptChecked] = useState(false);
  const [previewLoadError, setPreviewLoadError] = useState(false);

  const signedInEmail = user?.email?.trim().toLowerCase() ?? "";
  const invitedEmail = preview?.email.trim().toLowerCase() ?? "";
  const accountMismatch = forcedState === "account-mismatch" || Boolean(user && preview && signedInEmail !== invitedEmail);
  const alreadyAccepted = forcedState === "accepted" || errorCode === "invite_already_accepted";

  const forcedPreview = useMemo(() => {
    if (!forcedState || ["expired", "removed", "offline", "loading", "error"].includes(forcedState)) return null;
    return demoPreview;
  }, [forcedState]);

  useEffect(() => {
    if (forcedState) {
      if (forcedState === "loading") { setStatus("loading"); return; }
      if (forcedState === "expired" || forcedState === "removed" || forcedState === "offline" || forcedState === "error") {
        setStatus("error");
        setPreview(null);
        setErrorCode(forcedState === "expired" ? "invite_expired" : forcedState === "removed" ? "invite_revoked" : null);
        setError(forcedState === "expired" ? "This invitation has expired." : forcedState === "removed" ? "Workspace access was removed." : forcedState === "offline" ? "Couldn’t load the invitation. Check your connection and try again." : "This invitation could not be loaded.");
        return;
      }
      setPreview(forcedPreview);
      setStatus("preview");
      setError("");
      return;
    }
    if (!token) return;
    let alive = true;
    setStatus("loading");
    setPreviewLoadError(false);
    void fetch(`/api/v1/team/invite-preview/${encodeURIComponent(token)}`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!alive) return;
        if (response.ok && data.invitation) {
          setPreview(data.invitation as InvitePreview);
          setError("");
          setErrorCode(null);
          setStatus("preview");
          return;
        }
        setStatus("error");
        setError(data.error ?? "This invitation is unavailable.");
        setErrorCode((data.code ?? null) as InviteErrorCode | null);
      })
      .catch(() => {
        if (!alive) return;
        setStatus("error");
        setPreviewLoadError(true);
        setError("Couldn’t load the invitation. Check your connection and try again.");
      });
    return () => { alive = false; };
  }, [forcedPreview, forcedState, token]);

  async function acceptInvite(): Promise<void> {
    if (!token || !preview || !user || !acceptChecked) return;
    setStatus("accepting");
    setError("");
    setErrorCode(null);
    try {
      const response = await fetch("/api/v1/team/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setStatus("accepted");
        window.setTimeout(() => { window.location.href = "/"; }, 1500);
        return;
      }
      setStatus("error");
      setError(data.error ?? "Invitation acceptance failed.");
      setErrorCode((data.code ?? null) as InviteErrorCode | null);
    } catch {
      setStatus("preview");
      setError("Couldn’t accept the invitation. Try again.");
    }
  }

  async function signOutWrongAccount(): Promise<void> {
    try { await logout(); } finally {
      navigate(`/login?invite=${encodeURIComponent(token ?? "")}`);
    }
  }

  function retry(): void {
    if (forcedState) { window.location.reload(); return; }
    window.location.reload();
  }

  function errorActions() {
    if (previewLoadError || forcedState === "offline") {
      return <button type="button" className="ck-button ck-button-secondary" onClick={retry}><RefreshCw size={15} aria-hidden="true" /> Retry invite details</button>;
    }
    if (errorCode === "invite_email_mismatch" || accountMismatch) {
      return <div className="auth-state-actions"><p>You’re signed in with a different account than the invitation.</p><button type="button" className="ck-button ck-button-secondary" onClick={() => void signOutWrongAccount()}>Switch account</button></div>;
    }
    if (errorCode === "would_orphan_org") {
      return <Link className="ck-button ck-button-secondary" to="/settings?section=team#ownership-transfer">Open ownership transfer</Link>;
    }
    if (errorCode === "invite_already_accepted") {
      return <Link className="ck-button ck-button-primary" to="/login">Sign in <ArrowRight size={15} aria-hidden="true" /></Link>;
    }
    if (errorCode === "invite_expired" || errorCode === "invite_revoked" || forcedState === "expired" || forcedState === "removed") {
      return <div className="auth-state-actions"><p>Ask a workspace administrator to send you a new invitation.</p><Link className="ck-button ck-button-primary" to="/login">Back to sign in</Link></div>;
    }
    return <Link className="ck-button ck-button-primary" to="/signup">Create an account <ArrowRight size={15} aria-hidden="true" /></Link>;
  }

  const invite = preview ?? demoPreview;
  const displaySignedInEmail = user?.email || (forcedState === "account-mismatch" ? "another.account@example.com" : forcedState ? invite.email : "not signed in");

  if (design === "prototype") {
    return <PrototypeInvite state={requestedState} onSwitch={() => navigate("/login?design=prototype")} />;
  }

  return (
    <div className="auth-shell">
      <AuthBrandPanel />
      <main className="auth-panel">
        <div className="auth-mobile-logo">
          <Link to="/login" aria-label="CostKey home"><BrandLockup className="logo" markClassName="logo-mark" /></Link>
        </div>

        <div className="auth-panel-inner">
          {status === "loading" && (
            <div className="auth-state auth-state-loading" role="status" aria-live="polite" aria-busy="true">
              <LoaderCircle size={17} className="auth-state-icon auth-spin" aria-hidden="true" />
              <div><div className="auth-eyebrow">Workspace invitation</div><h1>Loading invitation</h1><p className="auth-lede">One moment.</p></div>
            </div>
          )}

          {status === "error" && (
            <section className="auth-state auth-state-error" role="alert" aria-live="polite">
              <div className="auth-state-icon auth-state-icon-critical"><AlertCircle size={18} aria-hidden="true" /></div>
              <div className="auth-eyebrow">Workspace invitation</div>
              <h1>{forcedState === "expired" || errorCode === "invite_expired" ? "This invitation has expired" : forcedState === "removed" || errorCode === "invite_revoked" ? "Workspace access was removed" : "Couldn’t load this invitation"}</h1>
              <p className="auth-lede">{error || "The invitation is no longer available."}</p>
              <div className="auth-actions">{errorActions()}</div>
            </section>
          )}

          {(status === "preview" || status === "accepting") && (
            <section className="auth-invite-content" aria-busy={status === "accepting"}>
              <div className="auth-eyebrow">Workspace invitation</div>
              <h1>{alreadyAccepted ? "You’re already a member" : `You’re invited to ${invite.workspace.name}`}</h1>
              <p className="auth-lede">{invite.inviter.name} invited you to see {invite.projects[0]?.name ?? invite.workspace.name}’s AI spending.</p>

              <div className="auth-context-card">
                <DetailRow label="Workspace">{invite.workspace.name}</DetailRow>
                <DetailRow label="Project access">{invite.projects.length ? invite.projects.map((project) => project.name).join(", ") : "No project access assigned"}</DetailRow>
                <DetailRow label="Intended role"><span className="auth-role-pill"><UserRound size={12} aria-hidden="true" />{roleLabel(invite.role)}</span></DetailRow>
                <p className="auth-lede auth-context-card-copy">{invite.role === "admin" ? "You’ll be able to manage this workspace, its projects and budgets." : invite.role === "developer" ? "You’ll see costs, prompts and code locations for these projects." : "You’ll see costs and usage. Prompts and code locations are hidden for Viewers."}</p>
              </div>

              <div className="auth-context-note auth-signed-in-note">
                <strong>{displaySignedInEmail === "not signed in" ? "You’re not signed in" : `Signed in as ${displaySignedInEmail}`}</strong><br />
                Invitation for {invite.email} · Expires {formatExpiry(invite.expiresAt)}
              </div>

              {error && <div className="auth-error" role="alert">{error}</div>}

              {authLoading ? (
                <div className="auth-state auth-state-loading" role="status"><LoaderCircle size={15} className="auth-spin" aria-hidden="true" /> Checking the signed-in account…</div>
              ) : alreadyAccepted ? (
                <div className="auth-actions"><Link className="ck-button ck-button-primary auth-submit" to="/">Open workspace <ArrowRight size={15} aria-hidden="true" /></Link></div>
              ) : accountMismatch ? (
                <div className="auth-mismatch-box"><p>This invitation is for <strong>{invite.email}</strong>, but you are signed in as <strong>{user?.email}</strong>.</p><button type="button" className="ck-button ck-button-secondary" onClick={() => void signOutWrongAccount()}>Switch account</button></div>
              ) : user ? (
                <div className="auth-accept-block">
                  <label className="auth-check"><input type="checkbox" checked={acceptChecked} onChange={(event) => setAcceptChecked(event.target.checked)} /><span>I understand this will add me to <strong>{invite.workspace.name}</strong> as a <strong>{roleLabel(invite.role)}</strong> with only the project scope listed above.</span></label>
                  <button type="button" className="ck-button ck-button-primary auth-submit" onClick={() => void acceptInvite()} disabled={!acceptChecked || status === "accepting"}>{status === "accepting" ? <><LoaderCircle size={15} className="auth-spin" /> Accepting invitation…</> : <>Accept invitation <ArrowRight size={15} aria-hidden="true" /></>}</button>
                </div>
              ) : (
                <div className="auth-actions">
                  <a className="ck-button ck-button-secondary auth-provider" href={`/auth/github?invite=${encodeURIComponent(token ?? "")}`}><GitBranch size={16} aria-hidden="true" /> Continue with GitHub</a>
                  <Link className="ck-button ck-button-primary" to={`/signup?invite=${encodeURIComponent(token ?? "")}`}>Create account <ArrowRight size={15} aria-hidden="true" /></Link>
                  <p className="auth-switch-copy">Already have an account? <Link to={`/login?invite=${encodeURIComponent(token ?? "")}`}>Sign in</Link></p>
                </div>
              )}
              <p className="auth-caption">This link only works for the invited email address.</p>
            </section>
          )}
        </div>

        <AuthFooter />
      </main>
    </div>
  );
}
