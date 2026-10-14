import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CallStack } from "./RunFlow";
import type { StackFrame } from "./stackFrames";

const frames: StackFrame[] = [
  {
    functionName: "summarize", fileName: "/app/src/summarize.ts", lineNumber: 12,
    contextLine: "  const res = await openai.chat.completions.create(req);",
    preContext: ["export async function summarize(req) {", "  log(req);", ""],
    postContext: ["  return res;", "}"],
  },
  {
    functionName: "handler", fileName: "/app/src/routes.ts", lineNumber: 40,
    contextLine: "  const summary = await summarize(req.body);", preContext: [], postContext: [],
  },
  { functionName: "run", fileName: "/app/.venv/lib/python3.12/site-packages/fastapi/routing.py", lineNumber: 301 },
];

function render(list: StackFrame[]): string {
  return renderToString(createElement(CallStack, { frames: list, callSite: { functionName: "summarize", file: "/app/src/summarize.ts", line: 12 } }));
}

describe("CallStack", () => {
  it("shows the first in-app frame's code open, the call line marked, and no call badge", () => {
    const html = render(frames);
    expect(html).not.toContain("Made this call");
    expect((html.match(/class="ck-code"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<tr class="is-call" aria-current="true"><td class="ck-code-num">12<\/td><td class="ck-code-text">  const res = await openai\.chat\.completions\.create\(req\);<\/td><\/tr>/);
    expect(html).toContain('<td class="ck-code-num">9</td>');
    expect(html).toContain('<td class="ck-code-num">14</td>');
  });

  it("makes frames with code expandable and leaves the rest as plain rows", () => {
    const html = render(frames);
    expect((html.match(/<button class="ck-callstack-row has-code" type="button" aria-expanded="true"/g) ?? []).length).toBe(1);
    expect((html.match(/<button class="ck-callstack-row has-code" type="button" aria-expanded="false"/g) ?? []).length).toBe(1);
    expect(html).toContain('<div class="ck-callstack-row"><span class="ck-callstack-fn">run');
    expect(html).toContain("summarize.ts:12");
  });

  it("keeps Show all N frames for long stacks", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ functionName: `f${i}`, fileName: `/app/src/f${i}.ts`, lineNumber: i + 1 }));
    expect(render(many)).toContain("Show all 12 frames");
  });

  it("renders plain rows when no frame has code", () => {
    const html = render([{ functionName: "a", fileName: "/app/a.ts", lineNumber: 1 }]);
    expect(html).not.toContain("ck-code");
    expect(html).not.toContain("<button class=\"ck-callstack-row");
  });
});
