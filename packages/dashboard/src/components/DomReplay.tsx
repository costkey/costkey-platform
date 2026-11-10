import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FastForward, Pause, Play } from "lucide-react";
import { formatReportedAmount, type ReportingFx } from "./consoleFormatters";
import { describeAction, formatClock, latestAt, shortUrl, type PreparedRecording, type TimedCall } from "./domReplayModel";
import "./RunReplay.css";

interface ReplayerLike {
  play(offset?: number): void;
  pause(offset?: number): void;
  getCurrentTime(): number;
  setConfig(config: { speed?: number }): void;
  on(event: string, handler: (payload: unknown) => void): unknown;
  destroy(): void;
}

const SPEEDS = [1, 2, 4] as const;
/** How much faster the player runs through stretches where the agent is waiting on the model. */
const WAIT_SPEED = 8;

/**
 * Plays a browser agent's pages as video (rrweb, in a sandboxed iframe with
 * scripts off), with the run's calls and the agent's actions on the timeline.
 * The current call and what the run had cost by then follow the playhead;
 * selecting a call elsewhere jumps to its moment.
 */
export function DomReplay({ recordings, calls, selectedId, onSelectCall, currency, fx, modeSwitch, truncated }: {
  recordings: PreparedRecording[];
  calls: TimedCall[];
  selectedId: string | null;
  onSelectCall: (eventId: string) => void;
  currency: string;
  fx?: ReportingFx | null;
  modeSwitch?: ReactNode;
  truncated?: boolean;
}) {
  const [pageIndex, setPageIndex] = useState(() => pageForCall(recordings, calls, selectedId) ?? 0);
  const recording = recordings[Math.min(pageIndex, recordings.length - 1)]!;
  const duration = recording.endMs - recording.startMs;
  const [offset, setOffset] = useState(() => Math.max(recording.firstFrameAt, offsetForCall(recording, calls, selectedId) ?? 0));
  const [seek, setSeek] = useState({ offset, token: 0 });
  const [wantsPlay, setWantsPlay] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [skipWaits, setSkipWaits] = useState(true);
  const [skipping, setSkipping] = useState(false);
  const fastRef = useRef(false);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const [followed, setFollowed] = useState(selectedId);
  const [shownId, setShownId] = useState(recording.id);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const replayer = useRef<ReplayerLike | null>(null);

  function jump(to: number): void {
    const clamped = Math.max(recording.firstFrameAt, Math.min(duration, to));
    setOffset(clamped);
    setSeek((current) => ({ offset: clamped, token: current.token + 1 }));
  }

  // A new page starts from its beginning, unless a call selection put us somewhere.
  if (shownId !== recording.id) {
    setShownId(recording.id);
    setViewport(null);
    setFailed(false);
    const at = Math.max(recording.firstFrameAt, offsetForCall(recording, calls, selectedId) ?? 0);
    setOffset(at);
    setSeek((current) => ({ offset: at, token: current.token + 1 }));
  }

  // A call selected elsewhere (timeline, tree) moves the playhead to it.
  if (selectedId !== followed) {
    setFollowed(selectedId);
    const page = pageForCall(recordings, calls, selectedId);
    if (page != null && page !== pageIndex) setPageIndex(page);
    else {
      const at = offsetForCall(recording, calls, selectedId);
      if (at != null) jump(at);
    }
  }

  const playing = wantsPlay && offset < duration;
  const seekRef = useRef(seek.offset);
  useEffect(() => {
    seekRef.current = seek.offset;
  }, [seek]);

  // Build the player for this page. rrweb is loaded only for runs that have a recording.
  useEffect(() => {
    const root = stage.current;
    if (!root) return;
    let cancelled = false;
    let instance: ReplayerLike | null = null;
    void (async () => {
      try {
        const [{ Replayer }] = await Promise.all([import("@rrweb/replay"), import("@rrweb/replay/dist/style.css")]);
        if (cancelled) return;
        instance = new Replayer(recording.events as never, {
          root,
          // Waits are skipped by the player below, so the skip is visible and short gaps count too.
          skipInactive: false,
          showWarning: false,
          triggerFocus: false,
          UNSAFE_replayCanvas: false,
          mouseTail: { strokeStyle: "rgba(71, 109, 156, 0.35)", lineWidth: 3, duration: 500 },
        }) as unknown as ReplayerLike;
        instance.on("resize", (size) => {
          const { width, height } = size as { width: number; height: number };
          if (width > 0 && height > 0) setViewport({ width, height });
        });
        instance.on("finish", () => setWantsPlay(false));
        replayer.current = instance;
        instance.pause(seekRef.current);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      instance?.destroy();
      if (replayer.current === instance) replayer.current = null;
      root.replaceChildren();
    };
  }, [recording]);

  // Seeks and play/pause go to the player; while playing, the playhead follows it.
  useEffect(() => {
    const player = replayer.current;
    if (!player) return;
    if (playing) player.play(seek.offset);
    else player.pause(seek.offset);
  }, [seek, playing]);
  useEffect(() => {
    fastRef.current = false;
    replayer.current?.setConfig({ speed });
  }, [speed]);
  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    const tick = () => {
      const player = replayer.current;
      if (player) {
        const at = Math.min(duration, player.getCurrentTime());
        setOffset(at);
        // Run through waits at speed, and back to normal for the next action.
        const fast = skipWaits && recording.quiet.some((span) => at >= span.from && at < span.to);
        if (fast !== fastRef.current) {
          fastRef.current = fast;
          player.setConfig({ speed: fast ? Math.max(WAIT_SPEED, speed * 4) : speed });
          setSkipping(fast);
        }
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(handle);
      if (fastRef.current) {
        fastRef.current = false;
        replayer.current?.setConfig({ speed });
        setSkipping(false);
      }
    };
  }, [playing, duration, skipWaits, speed, recording]);

  // Fit the recorded viewport to the panel's width.
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setFrameWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = viewport && frameWidth > 0 ? Math.min(1, frameWidth / viewport.width, 520 / viewport.height) : 1;

  const now = recording.startMs + offset;
  const call = latestAt(calls, now, (item) => item.startMs);
  const waitingOn = call && now < call.endMs ? call : null;
  const action = latestAt(recording.actions, offset, (item) => item.at);
  const callMarks = useMemo(
    () => calls.filter((item) => item.startMs >= recording.startMs && item.startMs <= recording.endMs),
    [calls, recording],
  );
  const money = (value: number) => formatReportedAmount(value, currency, fx);

  function togglePlay(): void {
    if (playing) {
      setWantsPlay(false);
      jump(offset);
      return;
    }
    if (offset >= duration) jump(recording.firstFrameAt);
    setWantsPlay(true);
  }

  return <section className="ck-replay" aria-label="Run replay">
    <div className="ck-replay-head">
      <div>
        <h2 className="ck-replay-title">Replay</h2>
        <div className="ck-replay-meta">
          {recordings.length > 1 ? `Page ${pageIndex + 1} of ${recordings.length}` : "Browser"}
          {recording.firstUrl ? ` · ${shortUrl(recording.firstUrl)}` : ""}
          {truncated ? " · showing the first part of a long run" : ""}
        </div>
      </div>
      <div className="ck-replay-controls">
        {modeSwitch}
        <button className={`ck-button ck-button-quiet ck-dom-skip${skipWaits ? " is-on" : ""}`} type="button" aria-pressed={skipWaits} title="Run through the stretches where the agent is waiting on the model" onClick={() => setSkipWaits((value) => !value)}><FastForward size={13} aria-hidden="true" /> Skip waits</button>
        <button className="ck-button ck-button-quiet ck-dom-speed" type="button" aria-label={`Speed ${speed}x`} onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}>{speed}×</button>
        <button className="ck-button ck-button-secondary" type="button" aria-label={playing ? "Pause" : "Play"} disabled={failed} onClick={togglePlay}>
          {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "Pause" : "Play"}
        </button>
      </div>
    </div>
    {recordings.length > 1 && <div className="ck-dom-pages" role="tablist" aria-label="Pages">
      {recordings.map((item, at) => <button key={item.id} type="button" role="tab" aria-selected={at === pageIndex} className={`ck-dom-page${at === pageIndex ? " is-current" : ""}`} onClick={() => { setWantsPlay(false); setPageIndex(at); }}>
        {item.firstUrl ? shortUrl(item.firstUrl) : `Page ${at + 1}`}
      </button>)}
    </div>}
    <div className="ck-replay-body">
      <div className="ck-dom-frame" ref={frame}>
        {failed
          ? <div className="ck-replay-frame is-empty">This recording couldn't be played</div>
          : <div className="ck-dom-viewport" style={viewport ? { width: viewport.width * scale, height: viewport.height * scale } : undefined}>
            <div className="ck-dom-stage" ref={stage} style={{ ["--ck-dom-scale" as string]: String(scale) }} />
            {(skipping || waitingOn) && <div className="ck-dom-status" role="status">
              <span className="ck-dom-status-dot" aria-hidden="true" />
              {skipping ? "Skipping a wait" : "Waiting on"}{waitingOn ? <> <b>{waitingOn.model || "the model"}</b> · call {waitingOn.callNumber}</> : null}
            </div>}
          </div>}
      </div>
      <dl className="ck-replay-facts">
        {action && <div><dt>Agent action</dt><dd>{describeAction(action)}</dd></div>}
        {call && <div><dt>Call {call.callNumber.toLocaleString()}</dt><dd>
          <button type="button" className="ck-dom-call" onClick={() => onSelectCall(call.eventId)}>{call.model || "Unknown model"}</button>
          <span className="ck-replay-text">{call.failed ? "No charge" : call.cost == null ? "Unpriced" : money(call.cost)}</span>
        </dd></div>}
        <div><dt>Run so far</dt><dd className="ck-replay-total">{money(call?.costSoFar ?? 0)}</dd></div>
      </dl>
    </div>
    <div className="ck-dom-scrub">
      <span className="ck-dom-clock">{formatClock(offset)}</span>
      <div className="ck-dom-track">
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={50}
          value={Math.round(offset)}
          aria-label="Playback position"
          aria-valuetext={formatClock(offset)}
          onChange={(event) => jump(Number(event.currentTarget.value))}
        />
        <div className="ck-dom-marks" aria-hidden="true">
          {recording.actions.map((item, at) => <i key={`a${at}`} className="ck-dom-mark is-action" style={{ left: `${(item.at / Math.max(1, duration)) * 100}%` }} />)}
        </div>
        <div className="ck-dom-calls">
          {callMarks.map((item) => <button
            key={item.eventId}
            type="button"
            className={`ck-dom-mark is-call${item.eventId === selectedId ? " is-current" : ""}${item.failed ? " is-failed" : ""}`}
            style={{
              left: `${((item.startMs - recording.startMs) / Math.max(1, duration)) * 100}%`,
              width: `max(8px, ${((Math.min(item.endMs, recording.endMs) - item.startMs) / Math.max(1, duration)) * 100}%)`,
            }}
            aria-label={`Call ${item.callNumber}: ${item.model}`}
            title={`Call ${item.callNumber} · ${item.model}`}
            onClick={() => { onSelectCall(item.eventId); jump(item.startMs - recording.startMs); }}
          />)}
        </div>
      </div>
      <span className="ck-dom-clock">{formatClock(duration)}</span>
    </div>
  </section>;
}

function offsetForCall(recording: PreparedRecording, calls: TimedCall[], eventId: string | null): number | null {
  if (!eventId) return null;
  const call = calls.find((item) => item.eventId === eventId);
  if (!call || call.startMs < recording.startMs - 1000 || call.startMs > recording.endMs + 1000) return null;
  return Math.max(0, Math.min(recording.endMs - recording.startMs, call.startMs - recording.startMs));
}

function pageForCall(recordings: PreparedRecording[], calls: TimedCall[], eventId: string | null): number | null {
  if (!eventId) return null;
  const call = calls.find((item) => item.eventId === eventId);
  if (!call) return null;
  const at = recordings.findIndex((item) => call.startMs >= item.startMs - 1000 && call.startMs <= item.endMs + 1000);
  return at >= 0 ? at : null;
}
