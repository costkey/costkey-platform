interface Props {
  provider: string;
  size?: number;
  className?: string;
}

export default function ProviderLogo({ provider, size = 18, className = "" }: Props) {
  const src = `/logos/${provider}.svg`;
  return (
    <img
      src={src}
      alt={provider}
      width={size}
      height={size}
      className={`inline-block ${className}`}
      style={{ opacity: 1 }}
      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

export function ProviderDot({ provider, className = "" }: { provider: string; className?: string }) {
  const bgColors: Record<string, string> = {
    openai: "bg-green",
    anthropic: "bg-amber",
    google: "bg-cyan",
    azure: "bg-accent",
    groq: "bg-violet",
    xai: "bg-rose",
    openrouter: "bg-violet",
    bedrock: "bg-amber",
    mistral: "bg-amber",
    deepseek: "bg-cyan",
    cohere: "bg-green",
    together: "bg-accent",
    fireworks: "bg-rose",
    perplexity: "bg-cyan",
    cerebras: "bg-violet",
  };
  return (
    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${bgColors[provider] ?? "bg-text-muted"} ${className}`} />
  );
}
