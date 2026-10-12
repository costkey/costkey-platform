import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, ChevronRight, Copy, FileText, Image as ImageIcon, Music, Paperclip, Wrench } from "lucide-react";
import {
  formatBytes,
  parseCallContent,
  schemaFields,
  splitRedactions,
  type AttachmentType,
  type CallContent as CallContentModel,
  type ContentConfig,
  type ContentMessage,
  type ContentOutput,
  type ContentPart,
  type MessageRole,
  type ResponseFormat,
  type SchemaField,
} from "./callContentModel";
import "./CallContent.css";

export interface CallContentProps {
  input: unknown;
  output: unknown;
  provider?: string | null;
  model?: string | null;
  contentStatus?: string | null;
  canReadContent: boolean;
  /** Owners and admins: shows a link to turn text capture on. */
  canManageCapture?: boolean;
}

const ROLE_LABELS: Record<MessageRole, string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
  developer: "Developer",
  system: "System",
};

const FORMAT_LABELS: Record<CallContentModel["format"], string> = {
  "openai-chat": "OpenAI chat",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic messages",
  gemini: "Gemini",
  bedrock: "Bedrock Converse",
  elevenlabs: "ElevenLabs",
  embeddings: "Embeddings",
  raw: "Unrecognised format",
};

const EMPTY_NOTES: Record<string, string> = {
  redacted: "This call's prompt and response were removed for privacy.",
  too_long: "This content is too large to show here.",
};
const NOT_AVAILABLE_NOTE = "Captured text isn't available for this call";

const TEXT_LINES = 12;
const MORE_LINES = 48;
const SYSTEM_LINES = 4;
const CHARS_PER_LINE = 64;

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);
}

/** The props the inspector's Content tab passes; renders the call's prompt and response. */
export function CallContent({ input, output, provider, model, contentStatus, canReadContent, canManageCapture = false }: CallContentProps) {
  const [showRaw, setShowRaw] = useState(false);
  const content = useMemo(() => parseCallContent(input, output, { provider, model }), [input, output, provider, model]);

  if (!canReadContent || contentStatus === "restricted") {
    return <div className="ck-cc"><p className="ck-cc-note">Prompts and responses are hidden for your role.</p></div>;
  }
  if (isEmpty(input) && isEmpty(output)) {
    if (contentStatus === "metadata_only") {
      return <div className="ck-cc"><p className="ck-cc-note">
        <span>Text capture is off for this project</span>
        {canManageCapture && <Link className="ck-cc-note-link" to="/settings?section=privacy">Turn on</Link>}
      </p></div>;
    }
    const note = (contentStatus && EMPTY_NOTES[contentStatus]) || NOT_AVAILABLE_NOTE;
    return <div className="ck-cc"><p className="ck-cc-note">{note}</p></div>;
  }

  const raw = content.format === "raw";
  return <div className="ck-cc">
    <div className="ck-cc-toolbar">
      <span className="ck-cc-format">{FORMAT_LABELS[content.format]}</span>
      {!raw && <button type="button" className="ck-cc-link" aria-pressed={showRaw} onClick={() => setShowRaw((value) => !value)}>
        {showRaw ? "View structured" : "View raw JSON"}
      </button>}
    </div>
    {raw && <p className="ck-cc-note">We could not recognise this format, so here is the raw JSON.</p>}
    {raw || showRaw ? <RawView input={input} output={output} /> : <StructuredView content={content} hasInput={!isEmpty(input)} hasOutput={!isEmpty(output)} />}
  </div>;
}

function StructuredView({ content, hasInput, hasOutput }: { content: CallContentModel; hasInput: boolean; hasOutput: boolean }) {
  const requestText = useMemo(() => conversationText(content), [content]);
  return <>
    {content.redactedCount > 0 && <p className="ck-cc-note ck-cc-note--warn">{content.redactedCount === 1 ? "1 secret was redacted before storage." : `${content.redactedCount} secrets were redacted before storage.`}</p>}
    {content.system && <section className="ck-cc-section" aria-label="System prompt">
      <SectionHead title="System prompt"><CopyButton text={content.system} label="system prompt" /></SectionHead>
      <div className="ck-cc-card ck-cc-card--system"><ClampedText text={content.system} lines={SYSTEM_LINES} simple /></div>
    </section>}
    <section className="ck-cc-section" aria-label="Conversation">
      <SectionHead title="Conversation">{hasInput && <CopyButton text={requestText} label="whole request" caption="Copy request" />}</SectionHead>
      {content.messages.length > 0
        ? <ol className="ck-cc-thread">{content.messages.map((message) => <MessageCard key={message.index} message={message} />)}</ol>
        : <p className="ck-cc-note">{hasInput ? "No messages in this request." : "No request was captured."}</p>}
    </section>
    <ConfigRow config={content.config} />
    <section className="ck-cc-section" aria-label="Output">
      <SectionHead title="Output">{content.output && content.output.parts.length > 0 && <CopyButton text={partsText(content.output.parts)} label="whole response" caption="Copy response" />}</SectionHead>
      {content.output && content.output.parts.length > 0
        ? <OutputCard output={content.output} />
        : <p className="ck-cc-note">{hasOutput ? "The response had no content." : "No response was captured."}</p>}
      {content.output && <OutputMeta output={content.output} />}
    </section>
  </>;
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="ck-cc-section-head"><h3 className="ck-cc-heading">{title}</h3>{children && <div className="ck-cc-actions">{children}</div>}</div>;
}

// ── Messages ──

function MessageCard({ message }: { message: ContentMessage }) {
  const label = ROLE_LABELS[message.role];
  return <li className={`ck-cc-card ck-cc-msg ck-cc-card--${message.role}`} aria-label={`${label}, message ${message.index}`}>
    <div className="ck-cc-msg-head">
      <span className={`ck-cc-role ck-cc-role--${message.role}`}>{label}</span>
      <span className="ck-cc-index" aria-hidden="true">{`#${message.index}`}</span>
      <span className="ck-cc-msg-actions"><CopyButton text={partsText(message.parts)} label={`message ${message.index}`} /></span>
    </div>
    <Parts parts={message.parts} />
  </li>;
}

function Parts({ parts }: { parts: ContentPart[] }) {
  const attachments = parts.filter((part) => part.kind === "attachment" || part.kind === "redacted" || part.kind === "omitted");
  const blocks = parts.filter((part) => !(part.kind === "attachment" || part.kind === "redacted" || part.kind === "omitted"));
  return <div className="ck-cc-parts">
    {blocks.map((part, index) => <PartView key={index} part={part} />)}
    {attachments.length > 0 && <div className="ck-cc-chips">{attachments.map((part, index) => <PartView key={index} part={part} />)}</div>}
  </div>;
}

function PartView({ part }: { part: ContentPart }) {
  switch (part.kind) {
    case "text":
      return part.refusal
        ? <div className="ck-cc-refusal"><span className="ck-cc-tag">Refused</span><ClampedText text={part.text} /></div>
        : <ClampedText text={part.text} />;
    case "json":
      return <div className="ck-cc-json"><JsonTree value={part.value} /></div>;
    case "toolCall":
      return <ToolCallRow name={part.name} args={part.args} resultIndex={part.resultIndex} />;
    case "toolResult":
      return <div className="ck-cc-result">
        <div className="ck-cc-result-head">
          <span>Result of </span><code className="ck-cc-code">{part.name ?? "tool"}</code>
          {part.callIndex != null && <span className="ck-cc-muted">{` from #${part.callIndex}`}</span>}
          {part.isError && <span className="ck-cc-tag ck-cc-tag--error">Error</span>}
        </div>
        {part.content.length > 0 ? <Parts parts={part.content} /> : <p className="ck-cc-muted">Empty result</p>}
      </div>;
    case "attachment":
      return <AttachmentChip part={part} />;
    case "thinking":
      return <ThinkingBlock text={part.text} />;
    case "redacted":
      return <span className="ck-cc-chip ck-cc-chip--redacted">{part.label}</span>;
    case "omitted":
      return <span className="ck-cc-chip">{part.chars != null ? `Text not stored · ${part.chars.toLocaleString()} characters` : "Not stored"}</span>;
    case "vectors":
      return <p className="ck-cc-vectors">{`${part.count.toLocaleString()} ${part.count === 1 ? "vector" : "vectors"}${part.dimensions != null ? ` × ${part.dimensions.toLocaleString()} dimensions` : ""}`}</p>;
  }
}

const ATTACHMENT_LABELS: Record<AttachmentType, string> = { image: "Image", audio: "Audio", file: "File", document: "Document" };

function AttachmentChip({ part }: { part: Extract<ContentPart, { kind: "attachment" }> }) {
  const Icon = part.type === "image" ? ImageIcon : part.type === "audio" ? Music : part.type === "document" ? FileText : Paperclip;
  const bits = [ATTACHMENT_LABELS[part.type], part.name, part.mimeType, part.detail && part.detail !== part.mimeType ? part.detail : null, part.sizeBytes != null ? formatBytes(part.sizeBytes) : null].filter(Boolean);
  return <span className="ck-cc-chip ck-cc-chip--attachment"><Icon size={12} aria-hidden="true" /><span className="ck-cc-chip-text">{bits.join(" · ")}</span></span>;
}

function ToolCallRow({ name, args, resultIndex }: { name: string; args: unknown; resultIndex?: number | null }) {
  const [open, setOpen] = useState(false);
  const hasArgs = args !== null && args !== undefined && !(typeof args === "object" && Object.keys(args as object).length === 0);
  const oneLine = hasArgs ? (typeof args === "string" ? args : JSON.stringify(args)) : "";
  return <div className="ck-cc-call">
    <div className="ck-cc-call-head">
      <Wrench size={12} aria-hidden="true" className="ck-cc-call-icon" />
      <span>Called </span><code className="ck-cc-code">{name}</code>
      {resultIndex != null && <span className="ck-cc-muted">{` result in #${resultIndex}`}</span>}
    </div>
    {hasArgs && <button type="button" className="ck-cc-args" aria-expanded={open} aria-label={open ? `Hide arguments for ${name}` : `Show arguments for ${name}`} onClick={() => setOpen((value) => !value)}>
      {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      <span className="ck-cc-args-line">{open ? "Arguments" : oneLine}</span>
    </button>}
    {hasArgs && open && <pre className="ck-cc-pre ck-cc-args-pre"><RedactedText text={prettyJson(args)} /></pre>}
  </div>;
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return <div className="ck-cc-thinking">
    <button type="button" className="ck-cc-link ck-cc-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}Reasoning
    </button>
    {open && <div className="ck-cc-thinking-body"><ClampedText text={text} /></div>}
  </div>;
}

// ── Text ──

function estimateLines(text: string): number {
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
}

/** Text clamped to a number of lines with a fade. `simple` shows one Show more / Show less toggle. */
function ClampedText({ text, lines = TEXT_LINES, simple = false }: { text: string; lines?: number; simple?: boolean }) {
  const total = estimateLines(text);
  const [limit, setLimit] = useState(lines);
  const clamped = total > limit;
  const expanded = limit > lines;
  const style = clamped ? { "--ck-cc-lines": limit } as CSSProperties : undefined;
  return <div className="ck-cc-textwrap">
    <div className={`ck-cc-text${clamped ? " is-clamped" : ""}`} style={style}><RedactedText text={text} /></div>
    {(clamped || expanded) && <div className="ck-cc-more">
      {simple
        ? <button type="button" className="ck-cc-link" aria-expanded={!clamped} onClick={() => setLimit(clamped ? Number.POSITIVE_INFINITY : lines)}>{clamped ? "Show more" : "Show less"}</button>
        : <>
          {clamped && <button type="button" className="ck-cc-link" aria-expanded={false} onClick={() => setLimit(limit === lines && total > MORE_LINES ? MORE_LINES : Number.POSITIVE_INFINITY)}>Show more</button>}
          {clamped && total > MORE_LINES && <button type="button" className="ck-cc-link" onClick={() => setLimit(Number.POSITIVE_INFINITY)}>Show all</button>}
          {expanded && <button type="button" className="ck-cc-link" aria-expanded={true} onClick={() => setLimit(lines)}>Show less</button>}
        </>}
    </div>}
  </div>;
}

function RedactedText({ text }: { text: string }) {
  const segments = splitRedactions(text);
  if (segments.length === 1 && !segments[0]!.redacted) return <>{text}</>;
  return <>{segments.map((segment, index) => segment.redacted
    ? <span key={index} className="ck-cc-redacted" title="Removed by redaction">Redacted</span>
    : <span key={index}>{segment.text}</span>)}</>;
}

// ── Configuration ──

function formatSummary(format: ResponseFormat): string {
  if (format.kind === "json_schema") {
    const bits = ["JSON schema"];
    if (format.name) bits.push(format.name);
    if (format.fieldCount != null) bits.push(`${format.fieldCount} ${format.fieldCount === 1 ? "field" : "fields"}`);
    return bits.join(" · ");
  }
  return format.kind === "json" ? "JSON output" : "Text output";
}

function ConfigRow({ config }: { config: ContentConfig }) {
  const [open, setOpen] = useState<"tools" | "schema" | null>(null);
  const tools = config.tools ?? [];
  const format = config.responseFormat;
  const chips: Array<{ label: string; value: string }> = [];
  if (config.model) chips.push({ label: "Model", value: config.model });
  if (config.temperature != null) chips.push({ label: "Temperature", value: String(config.temperature) });
  if (config.topP != null) chips.push({ label: "Top p", value: String(config.topP) });
  if (config.maxTokens != null) chips.push({ label: "Max tokens", value: config.maxTokens.toLocaleString() });
  if (config.reasoningEffort) chips.push({ label: "Reasoning", value: config.reasoningEffort });
  if (config.thinkingBudget != null) chips.push({ label: "Thinking budget", value: config.thinkingBudget.toLocaleString() });
  for (const extra of config.extras ?? []) chips.push(extra);
  const hasSchema = format?.kind === "json_schema" && format.schema !== undefined;
  if (!chips.length && !tools.length && (!format || format.kind === "text")) return null;
  const toggle = (key: "tools" | "schema") => setOpen((current) => current === key ? null : key);
  return <section className="ck-cc-section" aria-label="Configuration">
    <SectionHead title="Configuration" />
    <div className="ck-cc-chips">
      {chips.map((chip) => <span key={chip.label} className="ck-cc-chip"><span className="ck-cc-chip-label">{chip.label}</span><span className="ck-cc-chip-text">{chip.value}</span></span>)}
      {tools.length > 0 && <button type="button" className="ck-cc-chip ck-cc-chip--button" aria-expanded={open === "tools"} onClick={() => toggle("tools")}>
        <Wrench size={12} aria-hidden="true" /><span className="ck-cc-chip-text">{`${tools.length} ${tools.length === 1 ? "tool" : "tools"} available`}</span>
        {open === "tools" ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>}
      {format && format.kind !== "text" && (hasSchema
        ? <button type="button" className="ck-cc-chip ck-cc-chip--button" aria-expanded={open === "schema"} onClick={() => toggle("schema")}>
          <span className="ck-cc-chip-text">{formatSummary(format)}</span>
          {open === "schema" ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        </button>
        : <span className="ck-cc-chip"><span className="ck-cc-chip-text">{formatSummary(format)}</span></span>)}
    </div>
    {open === "tools" && <ul className="ck-cc-panel ck-cc-tools">
      {tools.map((tool, index) => <li key={`${tool.name}-${index}`}><code className="ck-cc-code">{tool.name}</code>{tool.description && <span className="ck-cc-muted">{tool.description}</span>}</li>)}
    </ul>}
    {open === "schema" && hasSchema && <div className="ck-cc-panel"><SchemaTree fields={schemaFields(format.schema)} /></div>}
  </section>;
}

function SchemaTree({ fields }: { fields: SchemaField[] }) {
  if (!fields.length) return <p className="ck-cc-muted">No named fields.</p>;
  return <ul className="ck-cc-schema">
    {fields.map((field) => <li key={field.name}>
      <div className="ck-cc-schema-row">
        <code className="ck-cc-code">{field.name}</code>
        <span className="ck-cc-schema-type">{field.type}</span>
        {field.required && <span className="ck-cc-tag">required</span>}
      </div>
      {field.description && <div className="ck-cc-muted ck-cc-schema-desc">{field.description}</div>}
      {field.children.length > 0 && <SchemaTree fields={field.children} />}
    </li>)}
  </ul>;
}

// ── Output ──

function OutputCard({ output }: { output: ContentOutput }) {
  return <div className="ck-cc-card ck-cc-card--output"><Parts parts={output.parts} /></div>;
}

const USAGE_LABELS: Record<string, string> = { input: "input", output: "output", reasoning: "reasoning", cacheRead: "cached", cacheWrite: "cache write", total: "total" };

function OutputMeta({ output }: { output: ContentOutput }) {
  const usage = output.usage ?? {};
  const bits: string[] = [];
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]) {
    const value = usage[key];
    if (value == null || (value === 0 && key !== "input" && key !== "output")) continue;
    bits.push(`${value.toLocaleString()} ${USAGE_LABELS[key]}`);
  }
  const tokenText = bits.length ? `Tokens: ${bits.join(", ")}` : null;
  if (!output.finishReason && !tokenText) return null;
  return <div className="ck-cc-meta">
    {output.finishReason && <span>{`Finish reason: ${output.finishReason}`}</span>}
    {tokenText && <span>{tokenText}</span>}
  </div>;
}

// ── JSON tree ──

function previewOf(value: unknown): string {
  if (Array.isArray(value)) return value.length ? `[ ${value.length} ${value.length === 1 ? "item" : "items"} ]` : "[]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    const inner = entries.slice(0, 4).map(([key, child]) => `${key}: ${child && typeof child === "object" ? (Array.isArray(child) ? "[…]" : "{…}") : JSON.stringify(child)}`).join(", ");
    return `{ ${inner}${entries.length > 4 ? ", …" : ""} }`;
  }
  return JSON.stringify(value) ?? String(value);
}

function JsonTree({ value }: { value: unknown }) {
  if (value === null || typeof value !== "object") return <JsonLeaf value={value} />;
  return <JsonEntries value={value as object} depth={0} />;
}

function JsonEntries({ value, depth }: { value: object; depth: number }) {
  const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child] as const) : Object.entries(value);
  if (!entries.length) return <span className="ck-cc-json-muted">{Array.isArray(value) ? "[]" : "{}"}</span>;
  return <ul className="ck-cc-tree">{entries.map(([key, child]) => <JsonNode key={key} name={key} value={child} depth={depth + 1} isIndex={Array.isArray(value)} />)}</ul>;
}

function JsonNode({ name, value, depth, isIndex }: { name: string; value: unknown; depth: number; isIndex: boolean }) {
  const branch = value !== null && typeof value === "object" && Object.keys(value as object).length > 0;
  const [open, setOpen] = useState(false);
  const key = <span className={isIndex ? "ck-cc-json-index" : "ck-cc-json-key"}>{name}</span>;
  if (!branch) return <li className="ck-cc-tree-leaf">{key}<span className="ck-cc-json-colon">: </span><JsonLeaf value={value} /></li>;
  return <li>
    <button type="button" className="ck-cc-tree-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      {key}
      {!open && <span className="ck-cc-json-preview">{previewOf(value)}</span>}
    </button>
    {open && <JsonEntries value={value as object} depth={depth} />}
  </li>;
}

function JsonLeaf({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="ck-cc-json-string"><RedactedText text={JSON.stringify(value)} /></span>;
  if (typeof value === "number") return <span className="ck-cc-json-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="ck-cc-json-bool">{String(value)}</span>;
  if (value === null || value === undefined) return <span className="ck-cc-json-muted">null</span>;
  return <span className="ck-cc-json-muted">{Array.isArray(value) ? "[]" : "{}"}</span>;
}

// ── Raw ──

const BASE64_RUN = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{200,}|[A-Za-z0-9+/]{400,}={0,2}/g;

function rawDisplay(value: unknown): { full: string; shown: string; shortened: boolean } {
  const full = typeof value === "string" ? value : prettyJson(value);
  let shortened = false;
  const shown = full.replace(BASE64_RUN, (match) => {
    shortened = true;
    return `${match.slice(0, 32)}… (${formatBytes(Math.floor((match.length * 3) / 4))} of base64)`;
  });
  return { full, shown, shortened };
}

function RawView({ input, output }: { input: unknown; output: unknown }) {
  return <>
    <RawBlock title="Request" value={input} />
    <RawBlock title="Response" value={output} />
  </>;
}

function RawBlock({ title, value }: { title: string; value: unknown }) {
  const display = useMemo(() => rawDisplay(value), [value]);
  const empty = isEmpty(value);
  return <section className="ck-cc-section" aria-label={`Raw ${title.toLowerCase()}`}>
    <SectionHead title={title}>{!empty && <CopyButton text={display.full} label={`raw ${title.toLowerCase()}`} />}</SectionHead>
    {empty ? <p className="ck-cc-note">Not captured.</p> : <pre className="ck-cc-pre ck-cc-raw">{display.shown}</pre>}
    {display.shortened && <p className="ck-cc-muted ck-cc-small">Base64 data is shortened here. Copy includes all of it.</p>}
  </section>;
}

// ── Copy ──

function CopyButton({ text, label, caption = "Copy" }: { text: string; label: string; caption?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className="ck-cc-copy" aria-label={`Copy ${label}`} onClick={() => void copy()}>
    {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}<span>{copied ? "Copied" : caption}</span>
  </button>;
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function partsText(parts: ContentPart[]): string {
  return parts.map((part) => {
    switch (part.kind) {
      case "text":
      case "thinking":
        return part.text;
      case "json":
        return prettyJson(part.value);
      case "toolCall":
        return `Called ${part.name}(${part.args === undefined || part.args === null ? "" : JSON.stringify(part.args)})`;
      case "toolResult":
        return `Result of ${part.name ?? "tool"}:\n${partsText(part.content)}`;
      case "attachment":
        return `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ""}${part.sizeBytes != null ? ` ${formatBytes(part.sizeBytes)}` : ""}]`;
      case "redacted":
        return "[REDACTED]";
      case "omitted":
        return "[not stored]";
      case "vectors":
        return `${part.count} vectors${part.dimensions != null ? ` x ${part.dimensions} dimensions` : ""}`;
    }
  }).filter(Boolean).join("\n\n");
}

function conversationText(content: CallContentModel): string {
  const blocks: string[] = [];
  if (content.system) blocks.push(`System:\n${content.system}`);
  for (const message of content.messages) blocks.push(`${ROLE_LABELS[message.role]}:\n${partsText(message.parts)}`);
  return blocks.join("\n\n");
}
