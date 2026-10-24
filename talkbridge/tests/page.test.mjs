// Run: node --experimental-vm-modules --test tests/page.test.mjs
// Executes the real page component with mocked hooks/services. This is not browser or microphone QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const stateNames = [...source.matchAll(/const \[(\w+),\s*\w+\] = useState/g)].map(match => match[1]);
const iconNames = source.match(/import \{ ([^}]+) \} from "lucide-react"/)[1].split(",").map(name => name.trim());
const session = { roomId: "test-room", token: "test-token", role: "host", language: "zh", code: "ABCDEFGH" };
const ready = { id: session.roomId, code: session.code, state: "ready", mode: "live",
  hostLanguage: "zh", guestLanguage: "ja", guestStatus: "approved", hostOnline: true, guestOnline: true,
  captions: [], startedAt: null, expiresAt: Date.now() + 600000, demoIndex: 0, generation: 0 };

function text(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  return value && typeof value === "object" ? text(value.props?.children) : "";
}
function nodes(value, result = []) {
  if (value && typeof value === "object") { result.push(value); Object.values(value).forEach(child => nodes(child, result)); }
  return result;
}
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

async function harness({ saved = false } = {}) {
  let states = [], refs = [], effects = [], stateIndex = 0, refIndex = 0;
  let serverRoom = { ...ready }, starts = 0, stops = 0, speechOptions;
  let getRoom = async () => ({ room: serverRoom });
  let postCaption = async () => ({ room: serverRoom });
  const actions = [];
  const react = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(value) { return refs[refIndex++] ??= { current: value }; },
    useEffect(effect) { effects.push(effect); }, useCallback: callback => callback,
  };
  const storage = { getItem: key => key === "kotoba-session" && saved ? JSON.stringify(session) : null, setItem() {}, removeItem() {} };
  const context = vm.createContext({
    console, Date, URL, URLSearchParams, AbortSignal, AbortController, Promise, Math, JSON,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    navigator: {}, crypto: globalThis.crypto, window: {}, localStorage: storage, sessionStorage: storage,
    location: { origin: "https://example.test", search: "" }, history: { replaceState() {} },
    document: { documentElement: {}, visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    fetch: async (path, init) => {
      let result;
      if (path === "/api/config") result = { speechReady: true };
      else if (String(path).startsWith("/api/room?")) result = await getRoom();
      else {
        const body = JSON.parse(init.body); actions.push(body);
        if (body.action === "start") serverRoom = { ...serverRoom, state: "running", generation: serverRoom.generation + 1 };
        if (body.action === "pause") serverRoom = { ...serverRoom, state: "paused", generation: serverRoom.generation + 1 };
        result = body.action === "caption" ? await postCaption(body) : { room: serverRoom };
      }
      return { ok: true, json: async () => result };
    },
  });
  const modules = { react,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
    "lucide-react": Object.fromEntries(iconNames.map(name => [name, name])),
    "@/lib/speech": { startSpeech: async options => { starts++; speechOptions = options; let stopped = false;
      return { stop: async () => { if (!stopped) { stopped = true; stops++; options.onStopped(); } } }; } },
  };
  const page = new vm.SourceTextModule(compiled, { context });
  await page.link(name => { const exports = modules[name]; assert.ok(exports, `Unexpected module: ${name}`);
    return new vm.SyntheticModule(Object.keys(exports), function () { Object.entries(exports).forEach(([key, value]) => this.setExport(key, value)); }, { context }); });
  await page.evaluate();
  const render = () => { stateIndex = refIndex = 0; effects = []; return page.namespace.default(); };
  const runEffect = marker => { const effect = effects.find(candidate => candidate.toString().includes(marker)); assert.ok(effect, `Missing effect: ${marker}`); return effect(); };
  const read = name => states[stateNames.indexOf(name)];
  const set = (name, value) => { const index = stateNames.indexOf(name); assert.ok(index >= 0); states[index] = value; };
  render();
  return { render, runEffect, read, set, actions, setServer: room => { serverRoom = room; },
    pollWith: handler => { getRoom = handler; }, captionWith: handler => { postCaption = handler; },
    get starts() { return starts; }, get stops() { return stops; }, get speechOptions() { return speechOptions; },
    click(label) { const button = nodes(render()).find(node => node.type === "button" && text(node).trim() === label);
      assert.ok(button, `Missing button: ${label}`); button.props.onClick(); },
  };
}

test("restoring a live host pauses the room instead of claiming that the microphone is running", async () => {
  const app = await harness({ saved: true });
  app.setServer({ ...ready, state: "running", generation: 1 });
  app.runEffect("setOrigin(location.origin)"); await flush(); app.render();
  const stopPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.starts, 0);
  assert.equal(app.read("room").state, "paused");
  assert.ok(app.actions.some(action => action.action === "pause"));
  assert.ok(nodes(app.render()).some(node => node.type === "button" && text(node).trim() === "继续对话"));
  stopPoll();
});

test("a delayed pre-start poll cannot stop a live recognizer or roll the room generation back", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  let resolvePoll;
  app.pollWith(() => new Promise(resolve => { resolvePoll = resolve; }));
  const stopPoll = app.runEffect("async function poll");
  app.click("开始对话"); await flush(); app.render();
  assert.equal(app.starts, 1); assert.equal(app.read("room").state, "running");
  resolvePoll({ room: ready }); await flush(); app.render(); app.runEffect('room?.state !== "running"');
  assert.equal(app.read("room").generation, 1);
  assert.equal(app.read("room").state, "running"); assert.equal(app.stops, 0);
  stopPoll();
});

test("NoMatch discards the existing partial only after its outstanding write finishes", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  let finishCaption;
  app.captionWith(() => new Promise(resolve => { finishCaption = resolve; }));
  app.click("开始对话"); await flush();
  app.speechOptions.onCaption({ id: "sentence-1", revision: 1, sourceLanguage: "zh", text: "测试", isFinal: false }); await flush();
  app.speechOptions.onCaption({ id: "sentence-1", revision: 2, sourceLanguage: null, text: "", isFinal: true }); await flush();
  assert.equal(app.actions.filter(action => action.action === "discard-caption").length, 0);
  finishCaption({ room: { ...ready, state: "running", generation: 1 } }); await flush();
  const discard = app.actions.find(action => action.action === "discard-caption");
  assert.ok(discard); assert.equal(discard.id, "sentence-1"); assert.equal(discard.revision, 2); assert.equal(discard.generation, 1);
});

test("recovering from a short poll failure pauses the room after local microphone shutdown", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  assert.equal(app.starts, 1);
  app.pollWith(async () => { throw new TypeError("fetch failed"); });
  app.render(); const stopFailedPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("online"), false);
  app.render(); app.runEffect('room?.state !== "running"'); await flush();
  assert.equal(app.stops, 1);
  assert.equal(app.speechOptions.signal.aborted, true);
  stopFailedPoll();

  // The outage was shorter than the server heartbeat timeout, so the server still says running.
  app.pollWith(async () => ({ room: { ...ready, state: "running", generation: 1 } }));
  app.render(); const stopRecoveredPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("online"), true);
  assert.equal(app.read("room").state, "paused");
  assert.equal(app.starts, 1, "Recovery must not silently reactivate the microphone");
  assert.ok(nodes(app.render()).some(node => node.type === "button" && text(node).trim() === "继续对话"));
  stopRecoveredPoll();
});

test("auto-scroll keeps the start of a tall caption visible and preserves deliberate scrollback", async () => {
  const app = await harness();
  const panels = nodes(app.render()).filter(node => node.props?.className === "caption-scroll");
  assert.equal(panels.length, 2);
  const tall = { scrollTop: 600, scrollHeight: 900, clientHeight: 240,
    getBoundingClientRect: () => ({ top: 100 }),
    lastElementChild: { offsetHeight: 500, getBoundingClientRect: () => ({ top: -100 }) } };
  const short = { scrollTop: 300, scrollHeight: 650, clientHeight: 240,
    getBoundingClientRect: () => ({ top: 100 }),
    lastElementChild: { offsetHeight: 150, getBoundingClientRect: () => ({ top: 200 }) } };
  panels[0].props.ref.current = tall; panels[1].props.ref.current = short;
  app.runEffect("el.scrollHeight - el.scrollTop - el.clientHeight");
  assert.equal(tall.scrollTop, 400, "Align the long caption's beginning with the viewport top");
  assert.equal(short.scrollTop, short.scrollHeight, "A short latest caption follows the bottom");
  tall.scrollTop = 0;
  app.runEffect("el.scrollHeight - el.scrollTop - el.clientHeight");
  assert.equal(tall.scrollTop, 0, "Do not pull a reader away from older captions");
});
