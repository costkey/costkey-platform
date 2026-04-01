import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Hexagon } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

export default function Signup() {
  const { signup, error } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await signup(email, password, name, orgName || name);
    setSubmitting(false);
    if (result) {
      navigate(`/onboarding?dsn=${encodeURIComponent(result.dsn)}&project=${result.projectId}`);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-8 h-8 bg-accent-muted border border-accent/30 rounded-sm flex items-center justify-center">
            <Hexagon size={16} className="text-accent" />
          </div>
          <span className="font-mono text-lg font-semibold text-text-primary">CostKey</span>
        </div>

        <div className="bg-surface-raised border border-border rounded-sm p-6">
          <h1 className="text-lg font-semibold text-text-primary mb-1">Create your account</h1>
          <p className="text-sm text-text-secondary mb-6">Start tracking your AI costs in 60 seconds.</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">Your name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full bg-surface border border-border rounded-sm px-3 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
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
                className="w-full bg-surface border border-border rounded-sm px-3 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
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
                className="w-full bg-surface border border-border rounded-sm px-3 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
                placeholder="min 8 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1.5">Organization name</label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                className="w-full bg-surface border border-border rounded-sm px-3 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
                placeholder="ACME Corp (optional)"
              />
            </div>

            {error && (
              <div className="text-xs text-red font-mono bg-red-muted px-3 py-2 rounded-sm">{error}</div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-accent hover:bg-accent-hover text-white font-mono text-sm font-medium py-2.5 rounded-sm transition-colors disabled:opacity-50 cursor-pointer"
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
    </div>
  );
}
