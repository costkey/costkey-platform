/**
 * Where people and SDKs reach this server. The hosted service is
 * app.costkey.dev; a self-hosted install sets PUBLIC_URL to its own address.
 */
const HOSTED = "https://app.costkey.dev";

export function publicUrl(): URL {
  const configured = process.env["PUBLIC_URL"]?.trim();
  if (configured) {
    try { return new URL(configured); } catch { /* fall back to the hosted URL */ }
  }
  return new URL(HOSTED);
}

/** The origin with no trailing slash, for building links. */
export function publicOrigin(): string {
  return publicUrl().origin;
}

/** A project's DSN, pointing SDKs at this server. */
export function projectDsn(authKey: string, projectId: string): string {
  const url = publicUrl();
  return `${url.protocol}//${authKey}@${url.host}/${projectId}`;
}

/**
 * Session cookies are Secure when the console is served over HTTPS. A
 * self-hosted install on plain http (a LAN address, say) still signs in.
 * COSTKEY_COOKIE_SECURE=true|false overrides.
 */
export function secureCookies(): boolean {
  const override = process.env["COSTKEY_COOKIE_SECURE"];
  if (override === "true") return true;
  if (override === "false") return false;
  if (process.env["PUBLIC_URL"]?.trim()) return publicUrl().protocol === "https:";
  return process.env["NODE_ENV"] === "production";
}
