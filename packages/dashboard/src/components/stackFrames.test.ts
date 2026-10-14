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

describe("frame source", () => {
  const withCode = {
    functionName: "summarize", fileName: "/app/src/summarize.ts", lineNumber: 12,
    contextLine: "  const res = await openai.chat.completions.create(req);",
    preContext: ["export async function summarize(req) {", "  log(req);", ""],
    postContext: ["  return res;", "}"],
  };

  it("numbers the lines around the call and marks the call line", async () => {
    const { frameCode } = await import("./stackFrames");
    expect(frameCode(withCode)).toEqual([
      { number: 9, text: "export async function summarize(req) {", isCall: false },
      { number: 10, text: "  log(req);", isCall: false },
      { number: 11, text: "", isCall: false },
      { number: 12, text: "  const res = await openai.chat.completions.create(req);", isCall: true },
      { number: 13, text: "  return res;", isCall: false },
      { number: 14, text: "}", isCall: false },
    ]);
  });

  it("has no code when no context was recorded, and no numbers without a line", async () => {
    const { frameCode } = await import("./stackFrames");
    expect(frameCode({ functionName: "f", fileName: "/app/a.py", lineNumber: 3 })).toBeNull();
    expect(frameCode({ functionName: "f", contextLine: "x()", preContext: ["a"] })?.map((line) => line.number)).toEqual([null, null]);
    expect(frameCode({ lineNumber: 1, contextLine: "first()", preContext: ["ghost"] })?.map((line) => line.number)).toEqual([null, 1]);
  });

  it("opens the first in-app frame that has code", async () => {
    const { defaultOpenFrame } = await import("./stackFrames");
    const views = frameViews([
      { functionName: "send", fileName: "/app/.venv/lib/python3.12/site-packages/httpx/_client.py", lineNumber: 914, contextLine: "lib()" },
      { functionName: "helper", fileName: "/app/src/helper.ts", lineNumber: 3 },
      withCode,
      { ...withCode, functionName: "handler" },
    ], { functionName: "summarize" });
    expect(views.map((view) => view.isInApp)).toEqual([false, true, true, true]);
    expect(defaultOpenFrame(views)).toBe(2);
    expect(defaultOpenFrame(frameViews([{ functionName: "a", fileName: "/app/a.ts", lineNumber: 1 }], {}))).toBeNull();
  });

  it("opens the frame the call is attributed to, not just the first of your code", async () => {
    const { defaultOpenFrame } = await import("./stackFrames");
    const views = frameViews([
      { ...withCode, functionName: "stream_response", fileName: "/app/src/claude_model.py", lineNumber: 225 },
      { ...withCode, functionName: "run", fileName: "/app/src/run_loop.py", lineNumber: 251 },
    ], { functionName: "run", file: "/app/src/run_loop.py", line: 251 });
    expect(views.map((view) => view.isCallSite)).toEqual([false, true]);
    expect(defaultOpenFrame(views)).toBe(1);
  });
});
