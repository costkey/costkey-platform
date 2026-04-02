interface Props {
  provider: string;
  size?: number;
  className?: string;
}

function OpenAILogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"
        fill="currentColor"
      />
    </svg>
  );
}

function AnthropicLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.565-4.21H5.696l-1.53 4.21H.603L6.569 3.52zm.637 10.065h4.822L9.632 6.758l-2.426 6.827z"
        fill="currentColor"
      />
    </svg>
  );
}

function GoogleLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.8 4.133-1.147 1.147-2.933 2.4-6.04 2.4-4.813 0-8.573-3.88-8.573-8.693s3.76-8.693 8.573-8.693c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" fill="currentColor" />
    </svg>
  );
}

function AzureLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M5.483 21.3H24L14.025 4.013l-3.038 8.347 5.836 6.938L5.483 21.3zM13.175 2.7L6.998 11.263 0 21.3h4.614l8.561-18.6z" fill="currentColor" />
    </svg>
  );
}

function GroqLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <text x="2" y="18" fontFamily="monospace" fontSize="16" fontWeight="bold" fill="currentColor">G</text>
    </svg>
  );
}

function XAILogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M2 2l8.5 10L2 22h2.5l7-8.25L18.5 22H22l-8.5-10L22 2h-2.5l-7 8.25L5.5 2H2z" fill="currentColor" />
    </svg>
  );
}

function DefaultLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "text-green",
  anthropic: "text-amber",
  google: "text-cyan",
  azure: "text-accent",
  groq: "text-violet",
  xai: "text-rose",
  openrouter: "text-violet",
  bedrock: "text-amber",
  mistral: "text-amber",
  deepseek: "text-cyan",
  cohere: "text-green",
  together: "text-accent",
  fireworks: "text-rose",
  perplexity: "text-cyan",
  cerebras: "text-violet",
};

const PROVIDER_LOGOS: Record<string, React.FC<{ size: number }>> = {
  openai: OpenAILogo,
  anthropic: AnthropicLogo,
  google: GoogleLogo,
  azure: AzureLogo,
  groq: GroqLogo,
  xai: XAILogo,
};

export default function ProviderLogo({ provider, size = 14, className = "" }: Props) {
  const Logo = PROVIDER_LOGOS[provider] ?? DefaultLogo;
  const color = PROVIDER_COLORS[provider] ?? "text-text-muted";
  return (
    <span className={`inline-flex items-center ${color} ${className}`} title={provider}>
      <Logo size={size} />
    </span>
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
