import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

function GitHubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await signup(email, password, name, orgName || name, inviteToken ?? undefined);
    setSubmitting(false);
    if (result) {
      if (result.joinedViaInvite) {
        navigate("/");
      } else {
        navigate("/onboarding");
      }
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8 mt-4">
          <img src="/favicon.svg" alt="CostKey" className="w-8 h-8" />
          <span className="font-mono text-lg font-semibold text-text-primary">CostKey</span>
        </div>

        <div className="bg-surface-raised border border-border rounded-sm p-7">
          <h1 className="text-lg font-semibold text-text-primary mb-1.5">Create your account</h1>
          <p className="text-sm text-text-secondary mb-6">Start tracking your AI costs in 60 seconds.</p>

          {/* GitHub button */}
          <a
            href="/auth/github"
            className="w-full flex items-center justify-center gap-2 bg-surface-overlay hover:bg-surface-hover border border-border rounded-sm px-3 py-3 text-sm text-text-primary font-medium mb-4 transition-colors"
          >
            <GitHubIcon size={16} />
            Sign up with GitHub
          </a>

          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">Your name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full bg-surface border border-border rounded-sm px-3 py-3 text-sm text-text-primary font-mono outline-none auth-input transition-all"
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">Work email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-surface border border-border rounded-sm px-3 py-3 text-sm text-text-primary font-mono outline-none auth-input transition-all"
                placeholder="jane@company.com"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full bg-surface border border-border rounded-sm px-3 py-3 text-sm text-text-primary font-mono outline-none auth-input transition-all"
                placeholder="min 8 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">Organization name</label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                className="w-full bg-surface border border-border rounded-sm px-3 py-3 text-sm text-text-primary font-mono outline-none auth-input transition-all"
                placeholder="ACME Corp (optional)"
              />
            </div>

            {error && (
              <div className="text-xs text-red font-mono bg-red-muted px-3 py-2 rounded-sm">{error}</div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-accent hover:bg-accent-hover text-black font-mono text-sm font-medium py-2.5 rounded-sm transition-colors disabled:opacity-50 cursor-pointer"
            >
              {submitting ? "Creating account..." : "Create account"}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-text-muted mt-4">
          Already have an account?{" "}
          <Link to="/login" className="text-accent hover:text-accent-hover">Sign in</Link>
        </p>
      </div>

      {/* Footer */}
      <div className="mt-12 flex items-center gap-3">
        <a href="https://costkey.dev/docs" target="_blank" rel="noopener noreferrer" className="text-[10px] font-mono text-text-muted/50 hover:text-text-muted transition-colors">Docs</a>
        <span className="text-text-muted/20">|</span>
        <a href="https://github.com/costkey-ai/costkey" target="_blank" rel="noopener noreferrer" className="text-[10px] font-mono text-text-muted/50 hover:text-text-muted transition-colors">GitHub</a>
      </div>
    </div>
  );
}
