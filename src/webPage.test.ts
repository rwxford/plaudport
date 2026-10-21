import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { pageHtml } from "./webPage.js";

class Element {
  children: Element[] = [];
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  onclick?: () => unknown;
  onsubmit?: (e: { preventDefault(): void }) => unknown;
  constructor(readonly tag = "div") {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute() {}
  addEventListener() {}
  querySelector(tag: string): Element | undefined {
    for (const child of this.children) {
      if (child.tag === tag) return child;
      const match = child.querySelector(tag);
      if (match) return match;
    }
  }
}

test("page reconnects without resubmission and retries only failed recordings", async () => {
  const nodes = new Map<string, Element>();
  const el = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const requests: { path: string; body?: { links: string } }[] = [];
  class Events {
    static current: Events;
    static CLOSED = 2;
    readyState = 0;
    handlers = new Map<string, (e: { data: string }) => void>();
    onerror?: () => void;
    constructor() { Events.current = this; }
    addEventListener(name: string, handler: (e: { data: string }) => void) { this.handlers.set(name, handler); }
    close() { this.readyState = 2; }
    emit(name: string, value: unknown) { this.handlers.get(name)!({ data: JSON.stringify(value) }); }
  }
  const html = pageHtml("abc123");
  const script = html.split("<script>")[1]!.split("</script>")[0]!;
  runInNewContext(script, {
    document: { getElementById: el, createElement: (tag: string) => new Element(tag) },
    EventSource: Events,
    fetch: async (path: string, options: { body?: string }) => {
      requests.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
      return { ok: true, json: async () => path === "/api/import" ? { jobId: "abc123" } : { set: true, expired: false, userTokenSet: true, relative: "in 1h" } };
    },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  el("links").value = "fictional-success\nfictional-failure";
  el("importForm").onsubmit!({ preventDefault() {} });
  await tick();
  const originalCards = [...el("recordings").children];
  Events.current.onerror!();
  assert.equal(requests.filter(r => r.path === "/api/import").length, 1);
  assert.equal(el("go").disabled, true);
  Events.current.emit("done", { summary: { imported: 1, failed: 1, outcomes: [
    { index: 0, url: "fictional-success", title: "Fictional success", status: "imported" },
    { index: 1, url: "fictional-failure", title: "Fictional failure", status: "failed" },
  ] } });
  assert.equal(el("retry").hidden, false);
  el("retry").onclick!();
  await tick();
  assert.equal(requests.filter(r => r.path === "/api/import")[1]?.body?.links, "fictional-failure");
  assert.equal(el("recordings").children[0], originalCards[0]);
  assert.equal(el("recordings").children[1], originalCards[1]);
  Events.current.emit("done", { summary: { archived: 1, outcomes: [{ index: 0, url: "fictional-failure", status: "archived", detail: "Only text was saved. No audio imported." }] } });
  assert.match(originalCards[1]!.querySelector("span")!.textContent, /Saved on this Mac/);
  assert.equal(el("retry").hidden, true);
});
