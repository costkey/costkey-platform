import { useEffect, useRef } from "react";
import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { iapStatusMessage, oidcStartHref, signedInDestination, ssoErrorMessage, type AuthConfig } from "../authConfig";

/**
 * The sign-in panel for single sign-on servers (COSTKEY_AUTH=iap or oidc).
 * No password forms: IAP signs people in from the request itself, and OIDC
 * offers one "Continue with <provider>" button. A signed-in visitor is sent
 * on to where they were going, including the CLI login handoff.
 */
export function SsoSignIn({ config }: { config: AuthConfig | null }) {
  const { user, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const refreshed = useRef(false);

  useEffect(() => {
    if (user && !loading) navigate(signedInDestination(searchParams), { replace: true });
  }, [user, loading, navigate, searchParams]);

  // IAP signs the request in on the server. If the console's auth state was
  // read before that (or cleared), read it once more.
  useEffect(() => {
    if (config?.mode !== "iap" || user || loading || refreshed.current || config.iap?.status !== "signed_in") return;
    refreshed.current = true;
    void refresh();
  }, [config, user, loading, refresh]);

  const busy = !config || loading || Boolean(user) || (config.mode === "iap" && config.iap?.status === "signed_in");

  return (
    <>
      <h1>Welcome to CostKey</h1>
      {busy ? (
        <div className="auth-state auth-state-loading" role="status" aria-live="polite">
          <LoaderCircle size={16} className="auth-state-icon auth-spin" aria-hidden="true" />
          <span>{!config ? "Checking how this workspace signs in…" : "Signing you in…"}</span>
        </div>
      ) : config.mode === "iap" ? (
        <IapNotice config={config} />
      ) : (
        <OidcButton config={config} params={searchParams} />
      )}
    </>
  );
}

function IapNotice({ config }: { config: AuthConfig }) {
  const message = iapStatusMessage(config.iap?.status);
  return (
    <div className="auth-form-card" data-sso-mode="iap">
      <div className="auth-error" role="alert">
        <strong>{message.title}.</strong> {message.body}
      </div>
      <button className="ck-button ck-button-primary auth-submit" type="button" onClick={() => window.location.reload()}>
        Try again <ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

function OidcButton({ config, params }: { config: AuthConfig; params: URLSearchParams }) {
  const error = ssoErrorMessage(params.get("error"));
  const name = config.oidc?.name ?? "single sign-on";
  return (
    <div className="auth-form-card" data-sso-mode="oidc">
      <a className="ck-button ck-button-primary auth-submit" href={oidcStartHref(config, params)}>
        <ShieldCheck size={16} aria-hidden="true" />
        Continue with {name}
      </a>
      {!config.configured && (
        <div className="auth-error" role="alert">Single sign-on isn’t fully configured. Ask your administrator.</div>
      )}
      {error && <div className="auth-error" role="alert" aria-live="polite">{error}</div>}
    </div>
  );
}
