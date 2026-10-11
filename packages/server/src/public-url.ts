/**
 * Where people and SDKs reach this server: PUBLIC_URL, or this machine on
 * its own port when that is unset.
 */
function localUrl(): URL {
  return new URL(`http://localhost:${process.env["PORT"] || 4100}`);
}

export function publicUrl(): URL {
  const configured = process.env["PUBLIC_URL"]?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") return url;
    } catch { /* fall back to this machine */ }
  }
  return localUrl();
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
  return publicUrl().protocol === "https:";
}
