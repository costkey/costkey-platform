/**
 * Acceptance catalog derived from docs/PRD.md.
 *
 * The catalog deliberately starts every item as INCOMPLETE. A passing local
 * fixture probe is useful evidence, but it is not representative supported
 * provider, deployed, notification, or device proof and must not promote an
 * item to complete by itself.
 */

export type ProofLevel =
  | "local-fixture"
  | "local-http"
  | "real-provider"
  | "deployed"
  | "device-or-browser";

export type EvidenceStatus = "INCOMPLETE";

export interface CatalogItem {
  id: string;
  title: string;
  contract: string;
  proof: ProofLevel[];
  localProbe: string;
  status: EvidenceStatus;
}

const item = (
  id: string,
  title: string,
  contract: string,
  proof: ProofLevel[],
  localProbe: string,
): CatalogItem => ({ id, title, contract, proof, localProbe, status: "INCOMPLETE" });

export const CAPABILITIES: CatalogItem[] = [
  item(
    "F01",
    "Workspace, setup and connection health",
    "A supported application produces an inspectable call before taxonomy, source maps, or customer labels are configured; quiet, rejected, and disconnected states remain distinct.",
    ["local-http", "real-provider", "deployed"],
    "health, DSN ingest, first-call inspection, and attribution guidance",
  ),
  item(
    "F02",
    "Trace and call inspection",
    "A user can follow a trace to its contributing call and pricing basis; unknown prices, attempts, context, and restricted content are represented truthfully.",
    ["local-http", "real-provider", "deployed"],
    "trace/event list and detail shape, attempt identity, and viewer redaction",
  ),
  item(
    "F03",
    "Business and code cost attribution",
    "Feature, function, customer, provider, and model views reconcile to one charge cohort without multiplying shared code or hiding unassigned work.",
    ["local-fixture", "local-http", "real-provider"],
    "same-charge multi-lens totals and unassigned/labelled event fixture",
  ),
  item(
    "F04",
    "Overview and ongoing reporting",
    "Scoped spend, average/unit cost, projection, trend, contributors, and material changes use one explicit scope and comparable periods.",
    ["local-fixture", "local-http", "device-or-browser"],
    "overview/summary/trend response consistency and post-retention daily aggregate storage",
  ),
  item(
    "F05",
    "Findings and cost-change investigation",
    "Findings expose comparison cohort, sample sufficiency, supporting traces, factual evidence, chronology, and next actions without fabricated causes or savings.",
    ["local-fixture", "local-http"],
    "findings endpoint and low-sample/attempt-change fixture",
  ),
  item(
    "F06",
    "Scoped spending policies",
    "Monitor and enforce modes are explicit; all applicable policies must allow; unknown required price/decision refuses; in-flight and late charges remain visible.",
    ["local-fixture", "local-http", "deployed"],
    "policy CRUD, admission/refusal response, concurrency, and decision history",
  ),
  item(
    "F07",
    "Grouped jobs, experiments and evaluation costs",
    "Stable groups contain fresh execution receipts, member traces, lifecycle/accounting state, phases, and late associated costs without console setup.",
    ["local-fixture", "local-http", "real-provider", "deployed"],
    "execution/group/late-scoring route probes and fixture identity",
  ),
  item(
    "F08",
    "Voice and other usage components",
    "STT, LLM, TTS, and other native units are counted once under one conversation; cumulative updates and missing components remain explicit.",
    ["local-fixture", "local-http", "real-provider", "deployed"],
    "TypeScript/Python SDK explicit usage through /events and cumulative/delta component probes",
  ),
  item(
    "F09",
    "Forecasting and comparisons",
    "Forecasts state units, assumptions, pricing basis, excluded/incomplete costs, sample sufficiency, and stale edits; calculation performs no paid model request.",
    ["local-fixture", "local-http"],
    "forecast availability, chosen-scale baseline, and scenario/export probes",
  ),
  item(
    "F10",
    "Credits and effective prices",
    "Consumption remains visible regardless of credits; manual credits and effective-price overrides are dated, permissioned, scoped, and auditable.",
    ["local-fixture", "local-http"],
    "credits CRUD and eligible/expired/provider-scoped cash estimate probes",
  ),
  item(
    "F11",
    "Notifications, collaboration and exports",
    "Notifications and links preserve exact scope and permission; CSV/JSON exports respect filters and content restrictions; delivery is proven separately.",
    ["local-http", "deployed", "device-or-browser"],
    "role-safe links, export route/content checks, and no-delivery-credential guard",
  ),
  item(
    "F12",
    "Membership, privacy and subscription",
    "Owner/Admin/Developer/Viewer permissions, metadata-only defaults, explicit capture/retention, and subscription controls are enforced beyond UI hiding.",
    ["local-fixture", "local-http", "deployed", "device-or-browser"],
    "four-role project/content/member/policy checks, settings/privacy transitions, and retention fence",
  ),
  item(
    "DX01",
    "Keep the setup small",
    "Install/init with a DSN observes existing calls asynchronously without provider credential migration or mandatory code upload; support and overhead are measurable.",
    ["local-http", "real-provider", "deployed"],
    "DSN-only ingest and non-blocking HTTP boundary probe",
  ),
  item(
    "DX02",
    "Automatic capture versus supplied meaning",
    "Captured provider identity/usage/timing is distinct from caller-supplied business context, execution boundary, and negotiated prices; absent labels are not invented.",
    ["local-fixture", "local-http", "real-provider"],
    "labelled/unlabelled event shape and attribution-health probes",
  ),
  item(
    "DX03",
    "Target public SDK surface",
    "Initialization, context, trace, grouped execution, explicit usage, context handoff, flush, and shutdown contracts are implemented compatibly before publication.",
    ["local-fixture", "local-http", "real-provider"],
    "SDK wire-envelope and additive endpoint probes; package contract remains separate",
  ),
  item(
    "DX04",
    "Ordinary application example",
    "The documented Python/TypeScript boundary inherits context into an existing function while calls remain observable when optional labels are absent.",
    ["local-fixture", "real-provider"],
    "context inheritance and unlabelled DSN ingest fixtures",
  ),
  item(
    "DX05",
    "Grouped work example",
    "A stable group name creates a fresh execution identity per invocation and member traces without dashboard setup; the runner owns scheduling and lifecycle.",
    ["local-fixture", "local-http", "deployed"],
    "group/execution identity route probes",
  ),
  item(
    "DX06",
    "Experiments and evals use the same mechanism",
    "Generation, scoring, configuration, dataset, case, phase, and delayed updates join one execution receipt without CostKey authoring the evaluator.",
    ["local-fixture", "local-http", "deployed"],
    "phase/case/late-update explicit usage probes",
  ),
  item(
    "DX07",
    "Distributed context and identity",
    "Trusted service/queue propagation is explicit; concurrent traces and retry attempts remain distinct; rerun creates a new execution identity.",
    ["local-fixture", "local-http", "real-provider"],
    "trace concurrency, attempt linkage, and context-carrier route probes",
  ),
  item(
    "DX08",
    "Explicit usage reporting",
    "Unique caller event/charge/component identities, native units, reported/estimated amounts, and cumulative versus delta semantics deduplicate and reconcile.",
    ["local-fixture", "local-http", "real-provider"],
    "Python/TypeScript recordUsage duplicate delivery, cumulative revision, and unknown-price probes",
  ),
  item(
    "DX09",
    "Enforcement developer contract",
    "Installing the SDK never blocks; supported pre-call enforcement returns typed refusal reasons and reset guidance without provider-style retries or invisible local rules.",
    ["local-fixture", "local-http", "deployed"],
    "policy admission/refusal and unavailable-decision probes",
  ),
  item(
    "DX10",
    "Developer documentation and diagnostics",
    "Python/TypeScript HTTP, worker, handoff, grouped, eval, and voice recipes identify automatic versus supplied data and provide redacted diagnostics/deep links.",
    ["local-fixture", "local-http", "real-provider"],
    "diagnostics, capability, deep-link, and redaction probes",
  ),
];

export interface AcceptanceScenario {
  id: string;
  title: string;
  requiredResult: string;
  coverage: string;
  localProbe: string;
  proof: ProofLevel[];
  status: EvidenceStatus;
}

const SCENARIO_PROOF: Record<string, ProofLevel[]> = {
  AC01: ["local-http", "real-provider", "deployed"],
  AC02: ["local-http", "real-provider", "deployed"],
  AC03: ["local-fixture", "local-http", "real-provider"],
  AC04: ["local-fixture", "local-http", "real-provider"],
  AC05: ["local-fixture", "local-http"],
  AC06: ["local-http", "deployed"],
  AC07: ["local-http", "deployed"],
  AC08: ["local-http", "deployed"],
  AC09: ["local-http", "deployed"],
  AC10: ["local-fixture", "local-http", "deployed"],
  AC11: ["local-fixture", "local-http", "deployed"],
  AC12: ["local-fixture", "local-http", "real-provider", "deployed"],
  AC13: ["local-fixture", "local-http"],
  AC14: ["local-fixture", "local-http"],
  AC15: ["local-http", "deployed", "device-or-browser"],
  AC16: ["local-http"],
  AC17: ["local-fixture", "local-http", "deployed"],
  AC18: ["local-http", "deployed"],
  AC19: ["local-fixture", "local-http", "deployed"],
  AC20: ["local-http", "deployed"],
};

const scenario = (
  id: string,
  title: string,
  requiredResult: string,
  coverage: string,
  localProbe: string,
): AcceptanceScenario => ({ id, title, requiredResult, coverage, localProbe, proof: SCENARIO_PROOF[id] ?? ["local-http"], status: "INCOMPLETE" });

export const ACCEPTANCE_SCENARIOS: AcceptanceScenario[] = [
  scenario("AC01", "Existing app initializes with DSN and no labels", "Call/cost appears; no provider migration or mandatory code upload.", "F01, DX01", "DSN ingest without business labels and project-scoped event identity"),
  scenario("AC02", "One request crosses Python/TS and providers", "Connected operation, no merged concurrent requests, correct elapsed timing.", "F02, DX07, AC03", "trace identity/elapsed fields, separate event rows, and cross-project ID isolation"),
  scenario("AC03", "Same function contributes to two features", "Feature/function/provider totals reconcile without duplicates.", "F03, A01", "same-charge multi-context rows and aggregate reconciliation"),
  scenario("AC04", "Model fallback and retry raise cost", "Visible attempts/returned model; evidence points to underlying calls.", "F02, F05", "attempt/model/request-model fixture"),
  scenario("AC05", "One child is unpriced", "Known subtotal is partial, child inspectable, automatic forecast not overstated.", "F02, F09, A02", "known plus NULL-cost child and coverage response"),
  scenario("AC06", "Source maps missing", "Cost/usage remains useful; specific source guidance replaces reinstall instruction.", "F01, DX02", "bundled stack frame and health hint"),
  scenario("AC07", "Concurrent work shares an allowance", "Admission respects shared scope; refusing policy and reason are recorded.", "F06, DX09", "parallel admission requests and durable decisions"),
  scenario("AC08", "Required price/decision unavailable under enforcement", "Explicit refusal/fallback; no silent allow or provider-cost-burning retry.", "F06, A05", "unknown-price enforcement probe"),
  scenario("AC09", "Work already in flight when next call is refused", "UI/email distinguish refusal, live work, and late settlement.", "F06, F11", "lifecycle/decision/late-charge fixture"),
  scenario("AC10", "Nightly grouped work repeats", "Stable group, separate fresh execution, automatic history without console creation.", "F07, DX05", "two execution IDs for one group"),
  scenario("AC11", "Judge/scoring service reports late", "Execution linkage and receipt update; scoring/retry subsets are not double counted.", "F07, DX06", "late phase usage update"),
  scenario("AC12", "Voice usage arrives as cumulative totals", "STT/LLM/TTS counted once, native units retained, missing components visible.", "F08, DX08", "cumulative revision and partial-component fixture"),
  scenario("AC13", "Forecast 50,000 operations", "Reproducible baseline mean x volume, clear units/assumptions, no paid model execution.", "F09", "forecast route with deterministic priced cohort"),
  scenario("AC14", "Credits cover some eligible usage", "Consumption unchanged; qualified cash estimate excludes ineligible/expired balances.", "F10", "credit eligibility/expiry fixture"),
  scenario("AC15", "Member follows notification/shared link", "Exact scope/resource preserved; permissions hold and no payload leakage.", "F11, F12", "role-safe deep-link and export probes"),
  scenario("AC16", "Quiet, disconnected and rejected-ingest situations", "Distinct truthful health messages; no false Offline from inactivity.", "F01, F04", "health statuses plus rejected ingest"),
  scenario("AC17", "Delivery duplicated, delayed or retried", "Costs reconcile once; actual provider attempts stay separate.", "A01-A03", "duplicate event and attempt identity checks"),
  scenario("AC18", "Full filtered export and expired content", "Matching dataset is correct; permission/retention limits remain intact.", "F11, F12", "Filter/pagination dataset, canonical export, and post-retention aggregate preservation"),
  scenario("AC19", "New cost/mode/capture behavior reaches existing users", "Existing settings respected; intentional changes and impact communicated.", "F12, DX03", "fixture settings preservation and capability response"),
  scenario("AC20", "User leaves console for a week", "Scoped digest/findings/policy messages arrive according to preferences.", "F04, F11", "notification preference/delivery capability probe; no external send"),
];

export const FAILURE_PATHS = [
  {
    id: "FP01",
    title: "Duplicate or delayed telemetry",
    given: "A client retries the same envelope after an ambiguous timeout.",
    when: "The same event ID is delivered twice, with a distinct retry attempt ID available.",
    then: "One charge is retained, the real attempts remain distinct, and a late update does not double the total.",
    recovery: "Idempotent delivery/reconciliation owns recovery; no customer retry is treated as a second billable event.",
    proof: "Automated local HTTP + PostgreSQL fixture; real provider/deployed proof still required.",
  },
  {
    id: "FP02",
    title: "Unknown required price under enforcement",
    given: "An enforced monetary policy covers a supported call whose required price is unknown.",
    when: "Admission cannot calculate a bounded allowance decision.",
    then: "The call is refused with a typed reason and safe fallback path; it is not silently allowed or retried as a provider failure.",
    recovery: "Policy admission owns refusal; the application owns user-facing fallback and may retry only after an explicit safe decision.",
    proof: "Automated local HTTP when endpoint exists; current local harness records missing contract as incomplete.",
  },
  {
    id: "FP03",
    title: "In-flight work and late settlement",
    given: "A matching execution has already started when a later call hits an allowance.",
    when: "The later admission is refused while the running work and a delayed charge remain possible.",
    then: "Refusal, live lifecycle state, and late settlement are separate durable outcomes; no process termination or refund is inferred.",
    recovery: "Lifecycle/settlement reconciliation owns late updates and preserves accounting partiality.",
    proof: "Automated local HTTP fixture + deployed worker proof required for completion.",
  },
  {
    id: "FP04",
    title: "Role, deep-link, and export privacy boundary",
    given: "A Viewer follows a valid trace link or requests a filtered export containing a captured body.",
    when: "The resource belongs to an accessible project but content/source privileges are absent.",
    then: "Aggregate metadata remains available, body/source data is absent in HTTP and export responses, and cross-org resources are rejected.",
    recovery: "Authorization and export serializers enforce the boundary; link possession never grants access.",
    proof: "Automated local HTTP + PostgreSQL fixture; browser/email delivery proof remains separate.",
  },
  {
    id: "FP05",
    title: "Delivery capability disabled in local acceptance",
    given: "A notification or webhook path is configured in the product but no external credentials are available.",
    when: "The local harness runs against an isolated database/server.",
    then: "No outbound recipient/provider request is made; capability is recorded as unverified rather than simulated as delivered.",
    recovery: "Local fixture uses an explicit disabled-delivery boundary; deployed delivery evidence is required before claiming AC20/F11.",
    proof: "Local process/env guard and logs only; never equivalent to real delivery proof.",
  },
] as const;

export const ALL_CATALOG_IDS = [
  ...CAPABILITIES.map((entry) => entry.id),
  ...ACCEPTANCE_SCENARIOS.map((entry) => entry.id),
];
