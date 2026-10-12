import { describe, expect, it } from "vitest";
import { frameViews, shortenPath } from "./stackFrames";

describe("stack frames", () => {
  it("strips app roots and install prefixes", () => {
    expect(shortenPath("/app/financial_data_worker/generated_media.py")).toEqual({ short: "financial_data_worker/generated_media.py", packageName: null });
    expect(shortenPath("/app/.venv/lib/python3.12/site-packages/httpx/_client.py")).toEqual({ short: "httpx/_client.py", packageName: "httpx" });
    expect(shortenPath("/srv/node_modules/@openai/agents/dist/run.js").packageName).toBe("@openai/agents");
    expect(shortenPath("/Users/naman/Code/costkey/packages/sdk/src/index.ts").short).toBe("packages/sdk/src/index.ts");
  });

  it("marks installed frames and highlights the call site", () => {
    const views = frameViews([
      { functionName: "send", fileName: "/app/.venv/lib/python3.12/site-packages/httpx/_client.py", lineNumber: 914 },
      { functionName: "synthesize", fileName: "/app/financial_data_worker/generated_media.py", lineNumber: 155 },
      { functionName: "run", fileName: "/app/.venv/lib/python3.12/site-packages/fastapi/routing.py", lineNumber: 301 },
    ], { functionName: "synthesize", file: "financial_data_worker/generated_media.py", line: 155 });
    expect(views.map((view) => [view.functionName, view.location, view.packageName, view.isCallSite])).toEqual([
      ["send", "httpx/_client.py:914", "httpx", false],
      ["synthesize", "financial_data_worker/generated_media.py:155", null, true],
      ["run", "fastapi/routing.py:301", "fastapi", false],
    ]);
    expect(views[1].fullLocation).toBe("/app/financial_data_worker/generated_media.py:155");
  });
});
