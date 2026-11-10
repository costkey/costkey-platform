import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { frameUrl, getTraceReplay, replayAssetUrl, type TraceEvent, type TraceReplay } from "../api";
import { formatDuration } from "../utils";
import { formatReportedAmount, type ReportingFx } from "./consoleFormatters";
import { actionTitle, buildReplay, type ReplayStep } from "./replayModel";
import { AddToDataset } from "./AddToDataset";
import { DomReplay } from "./DomReplay";
import { prepareRecording, timedCalls, type PreparedRecording } from "./domReplayModel";
import "./RunReplay.css";

const STEP_MS = 1200;

type ReplayMode = "browser" | "steps";

/**
 * A run's replay, shown only when there's something to replay: the browser
 * recording from @costkey/replay (video of each page), and/or the screenshots
 * a computer-use or browser agent sent to the model (one step per call).
 * When a run has both, a switch picks between them.
 */
export function RunReplay({ projectId, traceId, events, selectedId, onSelectCall, currency, fx }: {
  projectId: string;
  traceId: string;
  events: TraceEvent[];
  selectedId: string | null;
  onSelectCall: (eventId: string) => void;
  currency: string;
  fx?: ReportingFx | null;
}) {
  const steps = useMemo(() => buildReplay(events), [events]);
  const replay = useTraceReplay(projectId, traceId);
  const recordings = useMemo(() => (replay?.recordings ?? [])
    .map((recording) => prepareRecording(recording.id, recording.events, (sha) => replayAssetUrl(projectId, sha)))
    .filter((recording): recording is PreparedRecording => recording !== null), [replay, projectId]);
  const calls = useMemo(() => timedCalls(events), [events]);
  const [chosen, setChosen] = useState<ReplayMode | null>(null);

  if (recordings.length === 0 && steps.length === 0) return null;
  const mode: ReplayMode = recordings.length === 0 ? "steps" : steps.length === 0 ? "browser" : chosen ?? "browser";
  const modeSwitch = recordings.length > 0 && steps.length > 0
    ? <div className="ck-replay-modes" role="group" aria-label="Replay view">
      <button type="button" aria-pressed={mode === "browser"} className={mode === "browser" ? "is-on" : ""} onClick={() => setChosen("browser")}>Browser</button>
      <button type="button" aria-pressed={mode === "steps"} className={mode === "steps" ? "is-on" : ""} onClick={() => setChosen("steps")}>Screenshots</button>
    </div>
    : null;
  return mode === "browser"
    ? <DomReplay recordings={recordings} calls={calls} selectedId={selectedId} onSelectCall={onSelectCall} currency={currency} fx={fx} modeSwitch={modeSwitch} truncated={replay?.truncated} />
    : <StepReplay projectId={projectId} steps={steps} callCount={events.length} selectedId={selectedId} onSelectCall={onSelectCall} currency={currency} fx={fx} modeSwitch={modeSwitch} />;
}

/** The run's browser recordings, loaded once per run (not polled: they can be large). */
function useTraceReplay(projectId: string, traceId: string): TraceReplay | null {
  const key = `${projectId}:${traceId}`;
  const [loaded, setLoaded] = useState<{ key: string; replay: TraceReplay | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTraceReplay(projectId, traceId)
      .then((replay) => { if (!cancelled) setLoaded({ key, replay }); })
      .catch(() => { if (!cancelled) setLoaded({ key, replay: null }); });
    return () => { cancelled = true; };
  }, [key, projectId, traceId]);
  return loaded?.key === key ? loaded.replay : null;
}

/**
 * Steps through the screenshots an agent sent to the model, one per call,
 * beside what each call chose and cost. Selecting a step selects its call;
 * selecting a call elsewhere moves the replay to it.
 */
function StepReplay({ projectId, steps, callCount, selectedId, onSelectCall, currency, fx, modeSwitch }: {
  projectId: string;
  steps: ReplayStep[];
  callCount: number;
  selectedId: string | null;
  onSelectCall: (eventId: string) => void;
  currency: string;
  fx?: ReportingFx | null;
  modeSwitch?: ReactNode;
}) {
  const [index, setIndex] = useState(() => Math.max(0, steps.findIndex((step) => step.eventId === selectedId)));
  const [wantsPlay, setWantsPlay] = useState(false);
  const [followed, setFollowed] = useState(selectedId);
  const filmstrip = useRef<HTMLOListElement>(null);

  // A call selected elsewhere (timeline, tree) moves the replay to its step.
  if (selectedId !== followed) {
    setFollowed(selectedId);
    const at = steps.findIndex((step) => step.eventId === selectedId);
    if (at >= 0 && at !== index) setIndex(at);
  }

  // Playback stops by itself on the last step.
  const atEnd = index >= steps.length - 1;
  const playing = wantsPlay && !atEnd;
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setIndex((value) => Math.min(value + 1, steps.length - 1)), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, index, steps.length]);
  const setPlaying = (value: boolean) => setWantsPlay(value);

  useEffect(() => {
    const thumb = filmstrip.current?.children[index] as HTMLElement | undefined;
    thumb?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [index]);

  if (steps.length === 0) return null;
  const step = steps[Math.min(index, steps.length - 1)]!;
  const money = (value: number) => formatReportedAmount(value, currency, fx);

  function go(next: number, select = true): void {
    const clamped = Math.max(0, Math.min(steps.length - 1, next));
    setIndex(clamped);
    if (select) onSelectCall(steps[clamped]!.eventId);
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "ArrowRight") { event.preventDefault(); setPlaying(false); go(index + 1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); setPlaying(false); go(index - 1); }
  }

  return <section className="ck-replay" aria-label="Run replay" tabIndex={0} onKeyDown={onKeyDown}>
    <div className="ck-replay-head">
      <div>
        <h2 className="ck-replay-title">Replay</h2>
        <div className="ck-replay-meta">Step {(index + 1).toLocaleString()} of {steps.length.toLocaleString()} · call {step.callNumber.toLocaleString()} of {callCount.toLocaleString()}</div>
      </div>
      <div className="ck-replay-controls">
        {modeSwitch}
        <button className="ck-button ck-button-quiet" type="button" aria-label="Previous step" disabled={index === 0} onClick={() => { setPlaying(false); go(index - 1); }}><ChevronLeft size={15} /></button>
        <button className="ck-button ck-button-secondary" type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => {
          if (playing) { setPlaying(false); return; }
          if (atEnd) setIndex(0);
          setPlaying(true);
        }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "Pause" : "Play"}</button>
        <button className="ck-button ck-button-quiet" type="button" aria-label="Next step" disabled={index >= steps.length - 1} onClick={() => { setPlaying(false); go(index + 1); }}><ChevronRight size={15} /></button>
      </div>
    </div>
    <div className="ck-replay-body">
      <ReplayFrame key={step.eventId} projectId={projectId} step={step} />
      <dl className="ck-replay-facts">
        {step.action && <div><dt>Action</dt><dd>{actionTitle(step.action.label)}{step.action.x != null && step.action.y != null ? ` at ${Math.round(step.action.x)}, ${Math.round(step.action.y)}` : ""}{step.action.text ? <span className="ck-replay-text">“{step.action.text}”</span> : null}</dd></div>}
        <div><dt>Model</dt><dd>{step.model || "Unknown model"}</dd></div>
        <div><dt>This call</dt><dd>{step.failed ? "No charge" : step.cost == null ? "Unpriced" : money(step.cost)} · {formatDuration(step.durationMs)}</dd></div>
        <div><dt>Run so far</dt><dd className="ck-replay-total">{money(step.costSoFar)}</dd></div>
        <div><AddToDataset projectId={projectId} eventId={step.eventId} compact /></div>
      </dl>
    </div>
    <ol className="ck-replay-strip" ref={filmstrip} aria-label="Steps">
      {steps.map((item, at) => <li key={item.eventId}>
        <button type="button" className={`ck-replay-thumb${at === index ? " is-current" : ""}${item.failed ? " is-failed" : ""}`} aria-current={at === index ? "step" : undefined} aria-label={`Step ${at + 1}`} onClick={() => { setPlaying(false); go(at); }}>
          {item.frame.omitted ? <span className="ck-replay-thumb-empty" /> : <img src={frameUrl(projectId, item.frame.sha256)} alt="" loading="lazy" decoding="async" />}
        </button>
      </li>)}
    </ol>
  </section>;
}

function ReplayFrame({ projectId, step }: { projectId: string; step: ReplayStep }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [missing, setMissing] = useState(false);
  if (step.frame.omitted) {
    return <div className="ck-replay-frame is-empty">Screenshot over 2 MB, so it wasn't uploaded</div>;
  }
  if (missing) {
    return <div className="ck-replay-frame is-empty">Screenshot no longer stored</div>;
  }
  const { action } = step;
  const marker = size && action?.x != null && action.y != null && action.x <= size.width && action.y <= size.height
    ? { left: `${(action.x / size.width) * 100}%`, top: `${(action.y / size.height) * 100}%` }
    : null;
  return <div className="ck-replay-frame">
    <div className="ck-replay-canvas">
      <img
        src={frameUrl(projectId, step.frame.sha256)}
        alt={`What the model saw before call ${step.callNumber}`}
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setMissing(true)}
      />
      {marker && <span className="ck-replay-marker" style={marker} aria-hidden="true" />}
    </div>
  </div>;
}
