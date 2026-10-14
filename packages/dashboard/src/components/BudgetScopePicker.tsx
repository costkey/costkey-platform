import { useEffect, useId, useState } from "react";
import { getScopeNames, type ScopeNameKind, type ScopeNames } from "../budgetsApi";
import { PrototypeIcon } from "./PrototypeIcon";
import { DIMENSION_LABEL, SCOPE_DIMENSIONS, type BudgetDimension } from "./budgetModel";
import "./Budgets.css";

const GROUPS: Array<{ kind: ScopeNameKind; label: string }> = [
  { kind: "agent", label: "Agents" },
  { kind: "workflow", label: "Workflows" },
  { kind: "feature", label: "Features" },
  { kind: "model", label: "Models" },
  { kind: "customer", label: "Customers" },
];
const CUSTOM = "__custom__";
const PROJECT = "project";
const EMPTY: ScopeNames = { agent: [], workflow: [], feature: [], model: [], customer: [] };

function parseValues(text: string): string[] {
  return [...new Set(text.split(",").map((value) => value.trim()).filter(Boolean))];
}

function isNameKind(dimension: string): dimension is ScopeNameKind {
  return GROUPS.some((group) => group.kind === dimension);
}

function optionValue(dimension: string, name: string): string {
  return `${dimension}\u0000${name}`;
}

/**
 * "What it covers": the whole project, or one agent, workflow, feature, model
 * or customer seen in this project over the last 90 days. "Type a name" keeps
 * free text for anything else, several names, or a * pattern.
 */
export function BudgetScopePicker({ projectId, dimension, value, onChange }: { projectId: string | null; dimension: string; value: string; onChange: (dimension: string, value: string) => void }) {
  const id = useId();
  const [names, setNames] = useState<ScopeNames>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const values = parseValues(value);
  // Several names, a pattern or a dimension without a list start in free text.
  const [custom, setCustom] = useState(() => dimension !== PROJECT && (!isNameKind(dimension) || values.length !== 1 || /[*?]/.test(value)));

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getScopeNames(projectId)
      .then((result) => { if (!cancelled) { setNames(result); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [projectId]);

  // An existing budget opened in the editor arrives after the first render.
  useEffect(() => {
    if (dimension !== PROJECT && (!isNameKind(dimension) || parseValues(value).length > 1 || /[*?]/.test(value))) setCustom(true);
  }, [dimension, value]);

  const selected = custom ? CUSTOM : dimension === PROJECT || values.length === 0 ? PROJECT : optionValue(dimension, values[0]);
  // The current name always shows, even before names load or when it has gone quiet.
  const groupNames = (kind: ScopeNameKind): string[] => {
    const list = names[kind];
    return !custom && dimension === kind && values.length === 1 && !list.includes(values[0]) ? [values[0], ...list] : list;
  };
  const choose = (next: string): void => {
    if (next === CUSTOM) { setCustom(true); if (dimension === PROJECT) onChange("feature", ""); return; }
    setCustom(false);
    if (next === PROJECT) { onChange(PROJECT, ""); return; }
    const [kind, name] = next.split("\u0000");
    onChange(kind, name);
  };
  const customDimensions = SCOPE_DIMENSIONS.filter((item) => item !== PROJECT);
  const suggestions = isNameKind(dimension) ? names[dimension].filter((name) => !values.includes(name)) : [];
  const prefix = value.includes(",") ? `${value.slice(0, value.lastIndexOf(",") + 1).trimEnd()} ` : "";
  const nothingSeen = loaded && GROUPS.every((group) => names[group.kind].length === 0);

  return <>
    <label className="ck-form-field">
      <span>Covers</span>
      <span className="ck-form-select-wrap">
        <select className="ck-select" name="covers" value={selected} onChange={(event) => choose(event.target.value)}>
          <option value={PROJECT}>Whole project</option>
          {GROUPS.map((group) => {
            const list = groupNames(group.kind);
            return list.length > 0 && <optgroup key={group.kind} label={group.label}>{list.map((name) => <option key={name} value={optionValue(group.kind, name)}>{name}</option>)}</optgroup>;
          })}
          <optgroup label="Something else"><option value={CUSTOM}>Type a name</option></optgroup>
        </select>
        <PrototypeIcon name="down" size={14} />
      </span>
      {!loaded && projectId && <small>Loading names from this project.</small>}
      {nothingSeen && !custom && <small>No agents, workflows or features seen in the last 90 days. Type a name instead.</small>}
    </label>
    {custom && <div className="ck-form-grid prototype-policy-two-col ck-budget-scope-custom">
      <label className="ck-form-field">
        <span>Type</span>
        <span className="ck-form-select-wrap">
          <select className="ck-select" name="dimension" value={dimension === PROJECT ? "feature" : dimension} onChange={(event) => onChange(event.target.value, value)}>
            {customDimensions.map((item) => <option key={item} value={item}>{DIMENSION_LABEL[item as BudgetDimension]}</option>)}
          </select>
          <PrototypeIcon name="down" size={14} />
        </span>
      </label>
      <label className="ck-form-field">
        <span>Names</span>
        <input className="ck-input" name="scope" value={value} onChange={(event) => onChange(dimension === PROJECT ? "feature" : dimension, event.target.value)} list={suggestions.length > 0 ? `${id}-names` : undefined} autoComplete="off" placeholder="e.g. search, answer" />
        <small>Exact names, separated by commas. Use * to match a pattern.</small>
        {suggestions.length > 0 && <datalist id={`${id}-names`}>{suggestions.map((name) => <option key={name} value={`${prefix}${name}`} />)}</datalist>}
      </label>
    </div>}
  </>;
}
