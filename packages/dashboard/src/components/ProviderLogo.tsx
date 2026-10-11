import { appUrl } from "../basePath";
import { providerName } from "./consoleFormatters";

/** Providers with a logo in /public/providers, by the id the SDKs record. */
const LOGOS = new Set([
  "ai21", "alibaba", "anthropic", "assemblyai", "azure", "baseten", "bedrock", "cerebras", "cloudflare", "cohere",
  "deepgram", "deepinfra", "deepseek", "elevenlabs", "exa", "featherless", "firecrawl", "fireworks", "friendli",
  "google", "groq", "huggingface", "hyperbolic", "jina", "lambda", "livekit", "minimax", "mistral", "moonshot",
  "nebius", "novita", "nvidia", "ollama", "openai", "openrouter", "perplexity", "qwen", "sambanova", "tavily",
  "together", "upstage", "vercel", "vertex", "voyage", "xai", "zai",
]);

const ALIASES: Record<string, string> = { gemini: "google", "google-vertex": "vertex", vertexai: "vertex", "azure-openai": "azure", "aws-bedrock": "bedrock", dashscope: "alibaba", "x-ai": "xai", grok: "xai" };

export function providerId(value: string | null | undefined): string {
  const id = String(value ?? "").trim().toLowerCase();
  return ALIASES[id] ?? id;
}

/** A provider's logo, or a lettermark when we don't have one. */
export function ProviderLogo({ provider, size = 16 }: { provider: string | null | undefined; size?: number }) {
  const id = providerId(provider);
  if (!id) return null;
  if (LOGOS.has(id)) {
    return <img className="ck-provider-logo" src={appUrl(`/providers/${id}.svg`)} alt="" width={size} height={size} loading="lazy" />;
  }
  return <span className="ck-provider-logo ck-provider-letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }} aria-hidden="true">{providerName(id).charAt(0)}</span>;
}

/** Logo and name for one provider, or several ("anthropic,openai"). */
export function ProviderLabel({ provider, size = 14 }: { provider: string | null | undefined; size?: number }) {
  const ids = String(provider ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (ids.length === 0) return <>—</>;
  return <span className="ck-provider-label">{ids.map((id, index) => <span key={id} className="ck-provider-item"><ProviderLogo provider={id} size={size} />{providerName(id)}{index < ids.length - 1 ? "," : ""}</span>)}</span>;
}
