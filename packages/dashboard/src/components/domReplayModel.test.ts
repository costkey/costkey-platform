import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../api";
import { BLANK_IMAGE, describeAction, latestAt, prepareRecording, rewriteCss, timedCalls } from "./domReplayModel";

const SHA = "a".repeat(64);
const asset = (url: string, sha = SHA) => ({ type: 5, timestamp: 1500, data: { tag: "costkey.asset", payload: { url, sha256: sha, mediaType: "image/png" } } });
const href = (sha: string) => `https://console.test/api/v1/projects/p/replay-assets/${sha}`;

describe("browser replay model", () => {
  it("starts at the full snapshot, pulls out actions and assets, and keeps time order", () => {
    const prepared = prepareRecording("rec", [
      { type: 3, timestamp: 900, data: { source: 2 } }, // before any snapshot: unplayable, dropped
      { type: 5, timestamp: 1100, data: { tag: "costkey.action", payload: { name: "page.goto", url: "https://shop.test/" } } },
      { type: 4, timestamp: 1000, data: { href: "https://shop.test/", width: 1280, height: 720 } },
      { type: 2, timestamp: 1001, data: { node: { type: 0, childNodes: [] } } },
      asset("https://shop.test/logo.png"),
      { type: 3, timestamp: 2000, data: { source: 2, type: 2, x: 10, y: 20 } },
      { type: 5, timestamp: 1900, data: { tag: "costkey.action", payload: { name: "locator.click", selector: "#buy", textLength: "x" } } },
    ], href);
    expect(prepared).not.toBeNull();
    expect(prepared!.events.map((event) => event.type)).toEqual([4, 2, 3]);
    expect([prepared!.startMs, prepared!.endMs, prepared!.firstFrameAt]).toEqual([1000, 2000, 2]);
    expect(prepared!.firstUrl).toBe("https://shop.test/");
    expect(prepared!.actions).toEqual([
      { name: "page.goto", url: "https://shop.test/", at: 100 },
      { name: "locator.click", selector: "#buy", at: 900 },
    ]);
  });

  it("is unplayable without a full snapshot", () => {
    expect(prepareRecording("rec", [{ type: 4, timestamp: 1, data: {} }, { type: 3, timestamp: 2, data: {} }], href)).toBeNull();
  });

  it("points cached images and fonts at our copy and blanks everything else", () => {
    const prepared = prepareRecording("rec", [
      asset("https://shop.test/logo.png"),
      asset("https://fonts.test/a.woff2", "b".repeat(64)),
      { type: 4, timestamp: 1000, data: { href: "https://shop.test/" } },
      { type: 2, timestamp: 1001, data: { node: { type: 2, tagName: "html", attributes: {}, childNodes: [
        { type: 2, tagName: "img", attributes: { src: "https://shop.test/logo.png", srcset: "https://shop.test/logo.png 1x, https://shop.test/logo@2x.png 2x" } },
        { type: 2, tagName: "img", attributes: { src: "https://tracker.test/pixel.gif" } },
        { type: 2, tagName: "img", attributes: { src: "/relative/path.png" } },
        { type: 2, tagName: "img", attributes: { src: "data:image/png;base64,AAAA" } },
        { type: 2, tagName: "link", attributes: { rel: "stylesheet", href: "https://cdn.test/site.css" } },
        { type: 2, tagName: "a", attributes: { href: "#top" } },
        { type: 2, tagName: "style", attributes: { _cssText: "@import url(https://cdn.test/x.css); @font-face { src: url('https://fonts.test/a.woff2') } .hero { background: url(https://cdn.test/hero.jpg) }" } },
        { type: 2, tagName: "div", attributes: { style: "background-image: url(\"https://shop.test/logo.png\")" } },
      ] } } },
      { type: 3, timestamp: 1200, data: { source: 0, attributes: [{ id: 5, attributes: { src: "https://evil.test/a.png" } }], adds: [], removes: [], texts: [] } },
    ], href)!;
    const nodes = (prepared.events[1]!.data as { node: { childNodes: Array<{ attributes: Record<string, string> }> } }).node.childNodes;
    expect(nodes[0]!.attributes.src).toBe(href(SHA));
    expect(nodes[0]!.attributes.srcset).toBe(`${href(SHA)} 1x`);
    expect(nodes[1]!.attributes.src).toBe(BLANK_IMAGE);
    expect(nodes[2]!.attributes.src).toBe(BLANK_IMAGE);
    expect(nodes[3]!.attributes.src).toBe("data:image/png;base64,AAAA");
    expect(nodes[4]!.attributes.href).toBe("data:,");
    expect(nodes[5]!.attributes.href).toBe("#top");
    const css = nodes[6]!.attributes._cssText!;
    expect(css).not.toContain("@import");
    expect(css).toContain(`url("${href("b".repeat(64))}")`);
    expect(css).toContain('url("data:,")');
    expect(css).not.toContain("cdn.test");
    expect(nodes[7]!.attributes.style).toBe(`background-image: url("${href(SHA)}")`);
    const mutation = prepared.events[2]!.data as { attributes: Array<{ attributes: { src: string } }> };
    expect(mutation.attributes[0]!.attributes.src).toBe(BLANK_IMAGE);
    expect(JSON.stringify(prepared.events)).not.toMatch(/evil\.test|tracker\.test|cdn\.test/);
  });

  it("rewrites CSS without a lookup hit to blanks", () => {
    expect(rewriteCss("a { background: url( 'https://x.test/a.png' ) }", () => null)).toBe('a { background: url("data:,") }');
  });

  it("describes actions in words", () => {
    expect(describeAction({ at: 0, name: "page.goto", url: "https://shop.test/cart?x=1" })).toBe("Went to shop.test/cart");
    expect(describeAction({ at: 0, name: "locator.click", selector: "#buy" })).toBe("Clicked #buy");
    expect(describeAction({ at: 0, name: "mouse.click", x: 412.4, y: 230 })).toBe("Clicked 412, 230");
    expect(describeAction({ at: 0, name: "keyboard.press", key: "Enter" })).toBe("Pressed Enter");
    expect(describeAction({ at: 0, name: "keyboard.type", textLength: 12 })).toBe("Typed 12 characters");
    expect(describeAction({ at: 0, name: "locator.fill", selector: "#email", textLength: 9 })).toBe("Filled #email");
  });

  it("orders calls by time with the run's cost so far; failed calls cost nothing", () => {
    const call = (id: string, at: string, cost: number | null, fields: Partial<TraceEvent> = {}) =>
      ({ id, timestamp: at, model: "m", cost_usd: cost, duration_ms: 1, ...fields }) as TraceEvent;
    const calls = timedCalls([
      call("b", "2026-11-10T12:00:02Z", 0.02),
      call("a", "2026-11-10T12:00:01Z", 0.01),
      call("c", "2026-11-10T12:00:03Z", 0.5, { status_code: 500, error_type: "server_error" } as Partial<TraceEvent>),
      call("d", "2026-11-10T12:00:04Z", null),
    ]);
    expect(calls.map((item) => [item.eventId, item.callNumber, item.failed, Number(item.costSoFar.toFixed(2))])).toEqual([
      ["a", 1, false, 0.01], ["b", 2, false, 0.03], ["c", 3, true, 0.03], ["d", 4, false, 0.03],
    ]);
    expect(latestAt(calls, Date.parse("2026-11-10T12:00:02.5Z"), (item) => item.startMs)?.eventId).toBe("b");
    expect(latestAt(calls, 0, (item) => item.startMs)).toBeNull();
  });
});
