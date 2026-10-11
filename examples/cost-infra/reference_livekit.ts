import {
  recordLiveKitUsage,
  type LiveKitSessionUsageUpdatedEvent,
  type LiveKitUsageComponent,
} from "costkey";

/**
 * LiveKit Agents emits this shape from
 * `voice.AgentSessionEventTypes.SessionUsageUpdated`. The adapter is
 * structural, so applications do not need to add a runtime LiveKit dependency
 * to CostKey. See the official Node event and model-usage references before
 * wiring a concrete AgentSession.
 */
export type LiveKitSessionLike = {
  on(
    event: string | symbol,
    listener: (event: LiveKitSessionUsageUpdatedEvent) => void,
  ): unknown;
};

export function attachLiveKitUsage(
  session: LiveKitSessionLike,
  identity: {
    sessionId: string;
    executionId?: string;
    traceId?: string;
  },
  selection: {
    components?: readonly LiveKitUsageComponent[];
    excludeComponents?: readonly LiveKitUsageComponent[];
  } = { components: ["stt", "llm", "tts"] },
): void {
  let revision = 0;
  session.on("session_usage_updated", (event) => {
    void recordLiveKitUsage(event, {
      sessionId: identity.sessionId,
      executionId: identity.executionId,
      traceId: identity.traceId,
      revision: ++revision,
      expectedComponents: ["stt", "llm", "tts"],
      ...selection,
    });
  });
}

// If automatic HTTP capture owns the LLM request charges, select only the
// session's speech components instead:
// attachLiveKitUsage(session, identity, { excludeComponents: ["llm"] });

// If a session snapshot is the verified source of charge for a provider call,
// mark that overlapping call as manual so fetch capture does not duplicate it:
// await CostKey.withContext({ costkeyCapture: "manual" }, () => existingCall());

/** A credential-free, documented Node.js modelUsage fixture for local tests. */
export const LIVEKIT_SESSION_USAGE_FIXTURE: LiveKitSessionUsageUpdatedEvent = {
  type: "session_usage_updated",
  createdAt: 1_757_745_600_000,
  usage: {
    modelUsage: [
      {
        type: "llm_usage",
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        type: "stt_usage",
        provider: "deepgram",
        model: "nova-3",
        inputTokens: 20,
        outputTokens: 4,
        audioDurationMs: 1_250,
      },
      {
        type: "tts_usage",
        provider: "elevenlabs",
        model: "turbo",
        charactersCount: 30,
        audioDurationMs: 2_000,
      },
    ],
  },
};
