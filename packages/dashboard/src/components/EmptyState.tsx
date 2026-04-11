import { useState } from "react";
import { Copy, Check, Terminal } from "lucide-react";

interface Props {
  tab: "overview" | "traces" | "call-sites" | "events";
}

const TAB_LABELS: Record<string, string> = {
  overview: "cost overview",
  traces: "traces",
  "call-sites": "call sites",
  events: "events",
};

export default function EmptyState({ tab }: Props) {
  const [copied, setCopied] = useState<"py" | "ts" | null>(null);
  const [lang, setLang] = useState<"py" | "ts">("py");

  const pySnippet = `pip install costkey

import costkey
costkey.init(dsn="your-dsn-here")`;

  const tsSnippet = `npm install costkey

import { CostKey } from 'costkey'
CostKey.init({ dsn: 'your-dsn-here' })`;

  function copy(text: string, key: "py" | "ts") {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  const snippet = lang === "py" ? pySnippet : tsSnippet;

  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-full max-w-md text-center">
        <div className="w-12 h-12 rounded-lg bg-accent-muted border border-accent/20 flex items-center justify-center mx-auto mb-5">
          <Terminal size={22} className="text-accent" />
        </div>

        <h2 className="text-lg font-semibold text-text-primary mb-1.5">
          No {TAB_LABELS[tab]} yet
        </h2>
        <p className="text-sm text-text-secondary mb-6">
          Get started in 30 seconds. Add CostKey to your app and your AI calls will appear here automatically.
        </p>

        <div className="text-left">
          <div className="flex gap-0">
            <button
              onClick={() => setLang("py")}
              className={`px-4 py-2 text-xs font-mono border border-border rounded-tl-sm cursor-pointer transition-colors ${
                lang === "py" ? "bg-surface-overlay text-accent border-b-surface-overlay" : "bg-surface text-text-muted hover:text-text-secondary"
              }`}
            >Python</button>
            <button
              onClick={() => setLang("ts")}
              className={`px-4 py-2 text-xs font-mono border border-border rounded-tr-sm cursor-pointer transition-colors ${
                lang === "ts" ? "bg-surface-overlay text-accent border-b-surface-overlay" : "bg-surface text-text-muted hover:text-text-secondary"
              }`}
            >TypeScript</button>
          </div>

          <div className="relative bg-surface-overlay border border-border border-t-0 rounded-b-sm p-4">
            <pre className="font-mono text-xs text-text-primary leading-relaxed whitespace-pre">
              {snippet}
            </pre>
            <button
              onClick={() => copy(snippet, lang)}
              aria-label="Copy code snippet"
              className="absolute top-3 right-3 text-text-muted hover:text-accent transition-colors cursor-pointer"
            >
              {copied === lang ? <Check size={14} className="text-green" /> : <Copy size={14} />}
            </button>
          </div>
        </div>

        <p className="text-xs text-text-muted mt-5">
          That's it. Your AI calls will appear here automatically.{" "}
          <a href="https://costkey.dev/docs" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">
            Read the docs
          </a>
        </p>
      </div>
    </div>
  );
}
