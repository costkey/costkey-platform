import { BrandMark } from "./components/BrandMark";

export default function BootScreen({ fatal = false }: { fatal?: boolean }) {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "var(--ck-surface, #f6f8f8)", color: "var(--ck-ink, #17253f)", fontFamily: "var(--font-sans, system-ui)", padding: 24 }}>
      <div style={{ width: "min(360px, 100%)", textAlign: "center" }}>
        <BrandMark aria-label="CostKey" style={{ width: 28, height: 32, marginBottom: 14 }} />
        <h1 style={{ fontSize: 18, margin: 0 }}>{fatal ? "CostKey couldn’t start" : "Opening CostKey"}</h1>
        <p style={{ color: "var(--ck-secondary, #526477)", fontSize: 12, lineHeight: 1.5, margin: "9px 0 0" }}>{fatal ? "Refresh the page to retry. If this continues, check the console service status." : "Loading your workspace…"}</p>
        {!fatal && <div aria-hidden="true" style={{ height: 4, borderRadius: 99, background: "var(--ck-overlay, #edf3f5)", marginTop: 18, overflow: "hidden" }}><span style={{ display: "block", width: "42%", height: "100%", borderRadius: 99, background: "var(--ck-signal, #2d7e8d)" }} /></div>}
        {fatal && <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 18, minHeight: 34, border: "1px solid var(--ck-border-strong, #b9cbd0)", borderRadius: 7, background: "var(--ck-raised, #fff)", color: "var(--ck-ink, #17253f)", cursor: "pointer", padding: "8px 12px", fontWeight: 650 }}>Retry</button>}
      </div>
    </div>
  );
}
