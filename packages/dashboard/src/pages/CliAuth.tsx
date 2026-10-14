import { appUrl } from "../basePath";
import { useState, useEffect } from "react";
import { useAuth } from "../contexts/useAuth";
import { BrandMark } from "../components/BrandMark";
import { Check, Loader2, X } from "lucide-react";

/**
 * CLI Auth page — shown after login when ?cli=1 is in the URL.
 * Fetches a long-lived CLI token from the server and redirects it
 * to the CLI's localhost callback server.
 */
export default function CliAuth() {
  const { user } = useAuth();
  const [status, setStatus] = useState<"sending" | "success" | "error">("sending");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;

    const sendToken = async () => {
      try {
        // Ask server for a CLI token (uses the ck_cli_port/ck_cli_state cookies)
        const res = await fetch(appUrl("/auth/cli-token"), {
          method: "POST",
          credentials: "include",
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError((data as Record<string, string>).error ?? "Couldn’t connect the CLI");
          setStatus("error");
          return;
        }

        const { token, port, state } = (await res.json()) as {
          token: string; port: string; state: string;
        };

        // Rebuild the URL from a numeric port so a malformed server response
        // cannot turn the loopback callback into a remote token exfiltration.
        if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
          throw new Error("Invalid CLI callback port");
        }
        const callbackUrl = new URL("http://localhost/");
        callbackUrl.port = String(Number(port));
        callbackUrl.pathname = "/callback";
        const callbackRes = await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, state }),
        });

        if (callbackRes.ok) {
          setStatus("success");
        } else {
          setError("Couldn’t reach the CLI. Make sure costkey is still running in your terminal, then try again.");
          setStatus("error");
        }
      } catch {
        setError("Couldn’t reach the CLI. Make sure costkey is still running in your terminal, then try again.");
        setStatus("error");
      }
    };

    void sendToken();
  }, [user]);

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <BrandMark className="auth-lockup-mark" aria-label="CostKey" />
          <span className="font-mono text-lg font-semibold text-text-primary">CostKey</span>
        </div>

        <div className="bg-surface-raised border border-border rounded-sm p-8">
          {status === "sending" && (
            <>
              <Loader2 size={32} className="text-accent animate-spin mx-auto mb-4" />
              <h1 className="text-lg font-semibold text-text-primary mb-2">Connecting to your terminal…</h1>
              <p className="text-sm text-text-secondary">One moment.</p>
            </>
          )}

          {status === "success" && (
            <>
              <div className="w-14 h-14 rounded-full bg-green-muted border border-green/30 flex items-center justify-center mx-auto mb-4">
                <Check size={28} className="text-green" />
              </div>
              <h1 className="text-lg font-semibold text-text-primary mb-2">CLI connected!</h1>
              <p className="text-sm text-text-secondary">You can close this tab and return to your terminal.</p>
            </>
          )}

          {status === "error" && (
            <>
              <div className="w-14 h-14 rounded-full bg-red-muted border border-red/30 flex items-center justify-center mx-auto mb-4">
                <X size={28} className="text-red" />
              </div>
              <h1 className="text-lg font-semibold text-text-primary mb-2">Connection failed</h1>
              <p className="text-sm text-text-secondary">{error}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
