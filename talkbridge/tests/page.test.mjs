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
async function flush() { for (let index = 0; index < 50; index++) await Promise.resolve(); }

async function harness({ saved = false, search = "", cached = null } = {}) {
  let states = [], refs = [], effects = [], stateIndex = 0, refIndex = 0;
  let serverRoom = { ...ready }, starts = 0, stops = 0, speechOptions, reloads = 0, stateWrites = 0;
  let time = Date.now();
  let getRoom = async () => ({ room: serverRoom });
  let postCaption = async () => ({ room: serverRoom });
  const actions = [], timers = [], requestTimeouts = [], storageWrites = [], documentEvents = new Map();
  const postActions = new Map();
  const react = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { stateWrites++; states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(value) { return refs[refIndex++] ??= { current: value }; },
    useEffect(effect) { effects.push(effect); }, useCallback: callback => callback,
  };
  const stored = new Map();
  if (saved) stored.set("kotoba-session", JSON.stringify(saved === true ? session : saved));
  if (cached) stored.set("kotoba-room", JSON.stringify(cached));
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { storageWrites.push(key); stored.set(key, value); }, removeItem: key => stored.delete(key) };
  const context = vm.createContext({
    console, Date: class extends Date { static now() { return time; } }, performance: { now: () => time }, URL, URLSearchParams, AbortController, Promise, Math, JSON, Error, DOMException,
    AbortSignal: { timeout: milliseconds => { const controller = new AbortController(); requestTimeouts.push({ milliseconds, controller }); return controller.signal; } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay, active: true }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].active = false; }, setInterval: () => 1, clearInterval() {},
    navigator: {}, crypto: globalThis.crypto, window: {}, localStorage: storage, sessionStorage: storage,
    location: { origin: "https://example.test", search, reload: () => { reloads++; } }, history: { replaceState() {} },
    document: { documentElement: {}, visibilityState: "visible", addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name) },
    fetch: async (path, init) => {
      let result;
      if (path === "/api/config") result = { speechReady: true };
      else if (String(path).startsWith("/api/room?")) result = await Promise.race([getRoom(), new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))]);
      else {
        const body = JSON.parse(init.body); actions.push(body);
        if (serverRoom.deviceMode === "remote" && ["start", "pause"].includes(body.action)) {
          const role = states[stateNames.indexOf("session")]?.role ?? "host", field = role === "host" ? "hostListening" : "guestListening", other = role === "host" ? "guestListening" : "hostListening", generationField = role === "host" ? "hostCaptureGeneration" : "guestCaptureGeneration";
          serverRoom = { ...serverRoom, [field]: body.action === "start", [generationField]: serverRoom[generationField] + 1, state: body.action === "start" || serverRoom[other] ? "running" : "paused" };
        } else {
          if (body.action === "start") serverRoom = { ...serverRoom, state: "running", generation: serverRoom.generation + 1 };
          if (body.action === "pause") serverRoom = { ...serverRoom, state: "paused", generation: serverRoom.generation + 1 };
        }
        result = postActions.has(body.action) ? await postActions.get(body.action)(body) : body.action === "caption" ? await postCaption(body) : body.action === "leave" ? { left: true } : { room: serverRoom };
      }
      return { ok: !result?.httpStatus || result.httpStatus < 400, status: result?.httpStatus ?? 200, json: async () => result?.body ?? result };
    },
  });
  const modules = { react,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
    "lucide-react": Object.fromEntries(iconNames.map(name => [name, name])),
    "@/lib/speech": { startSpeech: async options => { starts++; speechOptions = options; let stopped = false;
      return { stop: async () => { if (!stopped) { stopped = true; stops++; options.onStopped(); } } }; } },
  };
  const page = new vm.SourceTextModule(compiled, { context });
  await page.link(name => {
    if (["@/lib/languages", "@/lib/ui-copy"].includes(name)) {
      const moduleSource = readFileSync(new URL(`../lib/${name.split("/").at(-1)}.ts`, import.meta.url), "utf8");
      return new vm.SourceTextModule(ts.transpileModule(moduleSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, { context });
    }
    const exports = modules[name]; assert.ok(exports, `Unexpected module: ${name}`);
    return new vm.SyntheticModule(Object.keys(exports), function () { Object.entries(exports).forEach(([key, value]) => this.setExport(key, value)); }, { context }); });
  await page.evaluate();
  const render = () => { stateIndex = refIndex = 0; effects = []; return page.namespace.default(); };
  const runEffect = marker => { const effect = effects.find(candidate => candidate.toString().includes(marker)); assert.ok(effect, `Missing effect: ${marker}`); return effect(); };
  const read = name => states[stateNames.indexOf(name)];
  const set = (name, value) => { const index = stateNames.indexOf(name); assert.ok(index >= 0); states[index] = value; };
  render();
  return { render, runEffect, read, set, actions, stored, storageWrites, requestTimeouts, timers, document: context.document, documentEvents, setServer: room => { serverRoom = room; },
    pollWith: handler => { getRoom = handler; }, captionWith: handler => { postCaption = handler; },
    actionWith: (name, handler) => postActions.set(name, handler),
    advance: milliseconds => { time += milliseconds; },
    get starts() { return starts; }, get stops() { return stops; }, get speechOptions() { return speechOptions; },
    get reloads() { return reloads; }, get stateWrites() { return stateWrites; },
    button(label) { const button = nodes(render()).find(node => node.type === "button" && text(node).trim() === label);
      assert.ok(button, `Missing button: ${label}`); return button; },
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

test("an invitation refresh restores the same guest and its cached subtitles without joining twice", async () => {
  const guest = { ...session, role: "guest", language: "ja" };
  const caption = { id: "kept", revision: 2, sourceLanguage: "zh", text: "保留原文", translation: "原文を保持", isFinal: true, translationState: "done", createdAt: 1 };
  const app = await harness({ saved: guest, search: "?join=abcdefgh&lang=zh", cached: { ...ready, captions: [caption] } });
  app.runEffect("setOrigin(location.origin)"); await flush();
  assert.equal(app.read("session").token, guest.token);
  assert.equal(app.read("language"), "ja", "Saved participant language wins over the link default");
  assert.equal(app.read("joinOpen"), false);
  assert.equal(app.read("recovering"), true);
  assert.equal(app.read("room").captions[0].text, caption.text);
  assert.equal(nodes(app.render()).some(node => node.type === "button" && text(node).trim() === "会話に参加"), false);
  const stopPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("recovering"), false);
  assert.equal(app.actions.some(action => action.action === "join"), false);
  assert.equal(app.starts, 0);
  stopPoll();
});

test("a different invitation uses its language default without inheriting the old room", async () => {
  const app = await harness({ saved: true, search: "?join=ZZZZ9999&lang=ja", cached: ready });
  app.runEffect("setOrigin(location.origin)"); await flush();
  assert.equal(app.read("session"), null); assert.equal(app.read("room"), null);
  assert.equal(app.read("language"), "ja"); assert.equal(app.read("code"), "ZZZZ9999");
  assert.equal(app.read("joinOpen"), true);
});

test("the host invite carries the host language without forcing a guest pair", async () => {
  const app = await harness();
  app.set("session", session); app.set("room", ready); app.set("origin", "https://example.test"); app.set("modal", "share");
  const invite = nodes(app.render()).find(node => node.props?.className === "invite-url");
  assert.equal(invite.props.value, "https://example.test/?join=ABCDEFGH&host=zh");
  app.set("room", { ...ready, hostLanguage: "ja" });
  assert.equal(nodes(app.render()).find(node => node.props?.className === "invite-url").props.value.endsWith("&host=ja"), true);
});

test("refresh stays usable while busy, stops audio immediately, and retains the session and subtitles", async () => {
  const cached = { ...ready, captions: [{ id: "kept", text: "原文" }] };
  const app = await harness({ saved: true, cached }); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush(); app.set("busy", true);
  assert.notEqual(app.button("刷新恢复").props.disabled, true);
  app.click("刷新恢复");
  assert.equal(app.speechOptions.signal.aborted, true); assert.equal(app.stops, 1); assert.equal(app.reloads, 1);
  assert.equal(app.stored.get("kotoba-session"), JSON.stringify(session));
  assert.equal(app.stored.get("kotoba-room"), JSON.stringify(cached));
  assert.equal(app.actions.some(action => ["leave", "end"].includes(action.action)), false);
});

test("refresh aborts a pending start before it can open a microphone", async () => {
  const app = await harness({ saved: true }); app.set("session", session); app.set("room", ready); app.render();
  let finishStart;
  app.actionWith("start", () => new Promise(resolve => { finishStart = resolve; }));
  app.click("开始对话"); await flush();
  assert.equal(app.read("busy"), true); app.click("刷新恢复");
  finishStart({ room: { ...ready, state: "running", generation: 1 } }); await flush();
  assert.equal(app.starts, 0); assert.equal(app.reloads, 1);
});

test("the existing 15 second timeout leaves recovery controls and the guest session intact", async () => {
  const app = await harness({ saved: { ...session, role: "guest", language: "zh" }, search: "?join=ABCDEFGH", cached: ready });
  app.runEffect("setOrigin(location.origin)"); await flush(); app.render();
  app.pollWith(() => new Promise(() => {})); const stopPoll = app.runEffect("async function poll"); await flush();
  assert.ok(app.requestTimeouts.every(request => request.milliseconds === 15000));
  app.requestTimeouts.at(-1).controller.abort(new DOMException("timed out", "TimeoutError")); await flush();
  assert.equal(app.read("online"), false); assert.equal(app.read("recovering"), true);
  assert.ok(app.read("session")); assert.ok(app.stored.has("kotoba-session")); assert.ok(app.read("room"));
  assert.notEqual(app.button("刷新恢复").props.disabled, true);
  assert.notEqual(app.button("退出当前会话").props.disabled, true);
  stopPoll();
  app.pollWith(async () => ({ room: ready })); app.render(); const stopRecovered = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("online"), true); assert.equal(app.read("recovering"), false); assert.equal(app.starts, 0);
  stopRecovered();
});

test("guest exit releases its slot and clears local data only after a successful leave", async () => {
  const guest = { ...session, role: "guest", language: "zh" };
  const app = await harness({ saved: guest, cached: ready }); app.set("session", guest); app.set("room", ready); app.render();
  app.actionWith("leave", async () => { throw new TypeError("fetch failed"); });
  app.click("退出当前会话"); assert.match(text(app.render()), /清除双方本轮字幕/);
  app.click("退出并清除字幕"); await flush();
  assert.ok(app.read("session")); assert.ok(app.stored.has("kotoba-session")); assert.ok(app.read("room"));
  app.actionWith("leave", async () => ({ left: true }));
  app.click("退出当前会话"); app.click("退出并清除字幕"); await flush();
  assert.equal(app.read("session"), null); assert.equal(app.read("room"), null); assert.equal(app.stored.has("kotoba-session"), false);
  assert.equal(app.actions.filter(action => action.action === "leave").length, 2);
  assert.equal(app.actions.some(action => action.action === "end"), false);
});

test("only a revoked room token makes a 403 session locally invalid", async () => {
  for (const code of ["UNAUTHORIZED", "AWAITING_APPROVAL"]) {
    const app = await harness({ saved: true }); app.set("session", session); app.set("room", ready); app.render();
    app.pollWith(async () => ({ httpStatus: 403, body: { error: "Forbidden", code } }));
    const stopPoll = app.runEffect("async function poll"); await flush();
    assert.equal(app.read("sessionInvalid"), code === "UNAUTHORIZED");
    assert.ok(app.stored.has("kotoba-session"), "Even an invalid session is retained until the participant chooses to leave");
    stopPoll();
  }
});

test("late partial responses and lower revisions cannot overwrite a confirmed translation", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  let finishPartial;
  const partial = { id: "sentence", revision: 1, sourceLanguage: "zh", text: "明天", translation: "", isFinal: false, translationState: "pending", createdAt: 1 };
  const final = { ...partial, revision: 2, text: "明天见", translation: "また明日", isFinal: true, translationState: "done" };
  app.captionWith(body => body.isFinal ? Promise.resolve({ room: { ...ready, state: "running", generation: 1, captions: [final] } }) : new Promise(resolve => { finishPartial = resolve; }));
  app.speechOptions.onCaption(partial); await flush();
  app.speechOptions.onCaption(final); await flush();
  assert.equal(app.read("room").captions[0].translation, final.translation, "Final is sent immediately, even inside the partial throttle");
  finishPartial({ room: { ...ready, state: "running", generation: 1, captions: [partial] } }); await flush();
  assert.equal(app.read("room").captions[0].revision, 2);
  app.pollWith(async () => ({ room: { ...ready, state: "running", generation: 1, captions: [partial] } }));
  app.render(); const stopPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("room").captions[0].translation, final.translation);
  assert.equal(app.timers.at(-1).delay, 600); stopPoll();
});

test("volume updates do not set page state and unchanged snapshots are not rewritten to storage", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  const meter = nodes(app.render()).find(node => node.props?.className === "volume-bars");
  const levels = []; meter.props.ref.current = { style: { setProperty: (key, value) => levels.push([key, value]) } };
  const writes = app.stateWrites;
  for (let index = 0; index < 100; index++) app.speechOptions.onLevel(index / 100);
  assert.equal(app.stateWrites, writes); assert.equal(levels.length, 100); assert.equal(levels.at(-1)[0], "--mic-level");
  app.runEffect('JSON.stringify(room)'); app.runEffect('JSON.stringify(room)');
  assert.equal(app.storageWrites.filter(key => key === "kotoba-room").length, 1);
});

test("one reconnect after a speech failure starts a new recognizer without losing confirmed captions", async () => {
  const caption = { id: "saved", revision: 2, sourceLanguage: "zh", text: "已经说完", translation: "話し終わりました", isFinal: true, translationState: "done", createdAt: 1 };
  const app = await harness({ saved: true }); app.set("session", session); app.set("room", { ...ready, captions: [caption] }); app.setServer({ ...ready, captions: [caption] }); app.render();
  app.click("开始对话"); await flush(); const oldSpeech = app.speechOptions;
  app.actionWith("pause", async () => { throw new TypeError("offline during pause"); });
  oldSpeech.onError("speech connection lost"); await flush();
  assert.equal(app.read("listening"), false); assert.equal(app.stops, 1);
  assert.match(text(app.render()), /收音已停止/); assert.notEqual(app.button("重新连接").props.disabled, true);
  app.actionWith("pause", async () => ({ room: { ...ready, state: "paused", generation: 2, captions: [caption] } }));
  app.click("重新连接"); await flush();
  assert.equal(app.starts, 2); assert.equal(app.read("listening"), true);
  assert.equal(app.read("room").captions[0].text, caption.text); assert.equal(app.read("session").token, session.token);
  oldSpeech.onError("stale error"); oldSpeech.onStopped(); await flush();
  assert.equal(app.read("listening"), true); assert.equal(app.stops, 1, "Old callbacks cannot stop the replacement microphone");
});

test("overlapping reconnect clicks serialize startup and ignore the earlier delayed start", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  let firstStart; let calls = 0;
  app.actionWith("start", async () => {
    if (++calls === 1) return new Promise(resolve => { firstStart = resolve; });
    return { room: { ...ready, state: "running", generation: 3 } };
  });
  app.click("开始对话"); await flush(); app.click("重新连接"); await flush(); app.click("重新连接"); await flush();
  assert.equal(app.starts, 0); assert.equal(calls, 1);
  firstStart({ room: { ...ready, state: "running", generation: 1 } }); await flush(); await flush();
  assert.equal(calls, 2, "Only the latest queued retry reaches the server start action");
  assert.equal(app.starts, 1); assert.equal(app.read("listening"), true);
  assert.equal(app.actions.filter(action => action.action === "pause").length, 1);
});

test("reconnect waits for a delayed error pause so it cannot stop the replacement recognizer", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  let finishPause; let calls = 0;
  app.actionWith("pause", async () => {
    if (++calls === 1) return new Promise(resolve => { finishPause = resolve; });
    return { room: { ...ready, state: "paused", generation: 2 } };
  });
  app.speechOptions.onError("speech stopped"); await flush(); app.click("重新连接"); await flush();
  assert.equal(app.starts, 1); assert.equal(calls, 1);
  finishPause({ room: { ...ready, state: "paused", generation: 2 } }); await flush();
  assert.equal(app.starts, 2); assert.equal(app.read("listening"), true); assert.equal(calls, 2);
});

test("guest reconnect only refreshes its current room, and idle polling uses 1500 ms", async () => {
  const guest = { ...session, role: "guest", language: "zh" };
  const app = await harness({ saved: guest }); app.set("session", guest); app.set("room", ready); app.set("online", false); app.render();
  app.click("重新连接"); await flush();
  assert.equal(app.starts, 0); assert.equal(app.actions.length, 0); assert.equal(app.read("online"), true);
  assert.equal(app.read("session").token, guest.token);
  app.render(); const stopPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.timers.at(-1).delay, 1500); stopPoll();
});

test("partial updates use the 700 ms throttle and final captions bypass it", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  const partial = { id: "sentence", sourceLanguage: "zh", text: "测试字幕", isFinal: false };
  app.speechOptions.onCaption({ ...partial, revision: 1 }); await flush();
  app.advance(699); app.speechOptions.onCaption({ ...partial, revision: 2 }); await flush();
  assert.equal(app.actions.filter(action => action.action === "caption").length, 1);
  app.advance(1); app.speechOptions.onCaption({ ...partial, revision: 3 }); await flush();
  app.speechOptions.onCaption({ ...partial, revision: 4, isFinal: true }); await flush();
  assert.deepEqual(app.actions.filter(action => action.action === "caption").map(action => action.revision), [1, 3, 4]);
});

const editableCaption = { id: "own-final", revision: 4, sourceLanguage: "zh", text: "星期四见", translation: "목요일에 만나요", isFinal: true, translationState: "done", edited: false, createdAt: 1 };
function enterEdit(app, value) {
  const textarea = nodes(app.render()).find(node => node.type === "textarea");
  assert.ok(textarea); textarea.props.onChange({ target: { value } });
}

test("Korean invitation excludes the host language but leaves both other languages available", async () => {
  const app = await harness({ search: "?join=ABCDEF01&host=ko" });
  app.runEffect("setOrigin(location.origin)"); await flush();
  assert.equal(app.read("inviteHost"), "ko"); assert.equal(app.read("language"), "zh");
  const options = nodes(app.render()).find(node => node.props?.className === "language-options").props.children;
  assert.equal(options.filter(node => node.props.disabled).length, 1);
  assert.equal(text(options.find(node => node.props.disabled)), "한한국어");
  options.find(node => text(node).includes("日本語")).props.onClick(); assert.equal(app.read("language"), "ja");
});

test("Korean UI, session restore, and recognition use the selected room pair", async () => {
  const koreanSession = { ...session, language: "ko" };
  const koreanRoom = { ...ready, hostLanguage: "ko", guestLanguage: "ja" };
  const app = await harness({ saved: koreanSession, cached: koreanRoom });
  app.setServer(koreanRoom); app.runEffect("setOrigin(location.origin)"); await flush(); app.render();
  assert.equal(app.read("language"), "ko"); assert.match(text(app.render()), /다시 연결/); assert.match(text(app.render()), /日本語 → 한국어/);
  app.set("recovering", false); app.click("대화 시작"); await flush();
  assert.deepEqual([...app.speechOptions.languages], ["ko", "ja"]); assert.equal(app.speechOptions.uiLanguage, "ko");
});

test("only own completed captions expose correction and retry; pending text hides obsolete translation", async () => {
  const app = await harness(); app.set("session", session); app.set("room", { ...ready, captions: [
    editableCaption,
    { ...editableCaption, id: "other", sourceLanguage: "ja", translationState: "pending", translation: "obsolete translation" },
    { ...editableCaption, id: "partial", isFinal: false },
  ] });
  const buttons = nodes(app.render()).filter(node => node.type === "button" && text(node) === "修改");
  assert.equal(buttons.length, 1); assert.doesNotMatch(text(app.render()), /obsolete translation/);
  app.set("room", { ...ready, state: "ended", captions: [editableCaption] });
  assert.equal(nodes(app.render()).filter(node => node.type === "button" && text(node) === "修改").length, 0);
});

test("unchanged corrections make no request and blank input stays in the editor", async () => {
  const app = await harness(); app.set("session", session); app.set("room", { ...ready, captions: [editableCaption] });
  app.click("修改"); app.click("保存并重新翻译"); await flush();
  assert.equal(app.read("modal"), null); assert.equal(app.actions.length, 0);
  app.click("修改"); enterEdit(app, "   ");
  assert.equal(app.button("保存并重新翻译").props.disabled, true);
  app.click("保存并重新翻译"); await flush();
  assert.equal(app.read("modal"), "edit"); assert.match(app.read("editError"), /1–1000/); assert.equal(app.actions.length, 0);
});

test("correction drafts survive new captions and failed saves, then send one trimmed revisioned update", async () => {
  const app = await harness(); app.set("session", session); app.set("room", { ...ready, captions: [editableCaption] });
  app.click("修改"); enterEdit(app, "  星期五见  ");
  app.set("room", { ...ready, captions: [editableCaption, { ...editableCaption, id: "new" }] }); app.render();
  assert.equal(app.read("editing").text, "  星期五见  ");
  app.actionWith("edit-caption", async () => ({ httpStatus: 503, body: { error: "暂时失败" } }));
  app.click("保存并重新翻译"); await flush();
  assert.equal(app.read("modal"), "edit"); assert.equal(app.read("editing").text, "  星期五见  "); assert.equal(app.read("editError"), "暂时失败");
  const corrected = { ...editableCaption, text: "星期五见", revision: 5, edited: true, translation: "금요일에 만나요" };
  app.actionWith("edit-caption", async () => ({ room: { ...ready, captions: [corrected] } }));
  app.click("保存并重新翻译"); await flush();
  assert.equal(app.actions.at(-1).revision, 4); assert.equal(app.actions.at(-1).text, "星期五见");
  assert.equal(app.read("modal"), null); assert.match(text(app.render()), /已修改/); assert.equal(app.read("room").captions[0].revision, 5);
});

test("retry only sends the failed caption revision and no correction occurs after the room ends", async () => {
  const app = await harness(); const failed = { ...editableCaption, translation: "", translationState: "error" };
  app.set("session", session); app.set("room", { ...ready, captions: [failed] });
  app.click("重试翻译"); await flush(); assert.equal(app.actions[0].action, "retry-translation"); assert.equal(app.actions[0].revision, 4);
  app.set("room", { ...ready, captions: [failed] }); app.click("修改"); enterEdit(app, "星期五见");
  app.set("room", { ...ready, state: "ended", captions: [] });
  assert.equal(app.button("保存并重新翻译").props.disabled, true);
  app.click("保存并重新翻译"); await flush(); assert.equal(app.actions.length, 1); assert.match(app.read("editError"), /不可修改/);
});

test("delayed old translation cannot replace a corrected caption and editor does not submit on IME keys", async () => {
  const corrected = { ...editableCaption, revision: 5, text: "星期五见", edited: true, translationState: "pending", translation: "" };
  const app = await harness(); app.set("session", session); app.set("room", { ...ready, captions: [corrected] });
  app.pollWith(async () => ({ room: { ...ready, captions: [editableCaption] } })); app.render();
  const stopPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("room").captions[0].revision, 5); assert.equal(app.read("room").captions[0].text, corrected.text);
  app.click("修改"); const textarea = nodes(app.render()).find(node => node.type === "textarea");
  assert.equal(textarea.props.onKeyDown, undefined); assert.equal(nodes(app.render()).filter(node => node.type === "form").length, 0);
  stopPoll();
});


test("revision conflict keeps the draft and refreshes its base for an explicit second save", async () => {
  const app = await harness(); app.set("session", session); app.set("room", { ...ready, captions: [editableCaption] });
  const newer = { ...editableCaption, text: "星期六见", revision: 5, edited: true };
  app.pollWith(async () => ({ room: { ...ready, captions: [newer] } }));
  app.click("修改"); enterEdit(app, "星期五见");
  app.actionWith("edit-caption", async () => ({ httpStatus: 409, body: { error: "字幕已更新", code: "STALE_UPDATE" } }));
  app.click("保存并重新翻译"); await flush();
  assert.equal(app.read("editing").text, "星期五见"); assert.equal(app.read("editing").original, "星期六见"); assert.equal(app.read("editing").revision, 5);
  assert.match(app.read("editError"), /再次点击保存/); assert.equal(app.actions.length, 1);
  app.actionWith("edit-caption", async () => ({ room: { ...ready, captions: [{ ...newer, text: "星期五见", revision: 6 }] } }));
  app.click("保存并重新翻译"); await flush();
  assert.equal(app.actions.at(-1).revision, 5); assert.equal(app.read("modal"), null);
});

test("recognized source renders before translation completes without caching or editing the local draft", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  let finish;
  app.captionWith(() => new Promise(resolve => { finish = resolve; }));
  const caption = { id: "instant", revision: 1, sourceLanguage: "zh", text: "不用等待译文才看到原文", isFinal: true };
  app.speechOptions.onCaption(caption); await flush();
  assert.match(text(app.render()), /不用等待译文才看到原文/);
  assert.match(text(app.render()), /本机识别 · 同步中/);
  assert.equal(nodes(app.render()).filter(n => n.type === "button" && text(n) === "修改").length, 0);
  assert.equal(app.read("room").captions.length, 0);
  app.runEffect("JSON.stringify(room)");
  assert.equal(JSON.parse(app.stored.get("kotoba-room")).captions.length, 0);
  const confirmed = { ...caption, translation: "翻訳", translationState: "done", edited: false, createdAt: 1 };
  finish({ room: { ...ready, state: "running", generation: 1, captions: [confirmed] }, timing: { translationMs: 123, translationReused: false } }); await flush();
  assert.equal(app.read("localCaptions").length, 0);
  assert.match(text(app.render()), /翻訳/); assert.ok(app.button("修改"));
});

test("NoMatch and failed saves clear local drafts while an older failure keeps a newer draft", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  let rejectOld, finishNew;
  app.captionWith(body => body.revision === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : new Promise(resolve => { finishNew = resolve; }));
  const partial = { id: "draft", sourceLanguage: "zh", text: "旧原文", isFinal: false };
  app.speechOptions.onCaption({ ...partial, revision: 1 }); await flush();
  app.advance(700); app.speechOptions.onCaption({ ...partial, text: "较新原文", revision: 2 }); await flush();
  rejectOld(new Error("upload failed")); await flush();
  assert.match(text(app.render()), /较新原文/);
  app.speechOptions.onCaption({ ...partial, text: "", sourceLanguage: null, revision: 3, isFinal: true }); await flush();
  assert.equal(app.read("localCaptions").length, 0); assert.doesNotMatch(text(app.render()), /较新原文/);
  finishNew({ room: { ...ready, state: "running", generation: 1 } }); await flush();
  app.captionWith(async () => { throw new Error("upload failed"); });
  app.speechOptions.onCaption({ ...partial, id: "failed", revision: 1 }); await flush();
  assert.equal(app.read("localCaptions").length, 0);
});

test("corrected final captions beat late speech callbacks and pause removes transient source", async () => {
  const app = await harness(); const corrected = { ...editableCaption, edited: true };
  app.set("session", session); app.set("room", { ...ready, captions: [corrected] }); app.setServer({ ...ready, captions: [corrected] }); app.render();
  app.click("开始对话"); await flush(); app.render();
  app.speechOptions.onCaption({ ...corrected, text: "不应覆盖", revision: 99 }); await flush();
  assert.equal(app.actions.filter(a => a.action === "caption").length, 0);
  assert.doesNotMatch(text(app.render()), /不应覆盖/);
  app.captionWith(() => new Promise(() => {}));
  app.speechOptions.onCaption({ id: "next", revision: 1, sourceLanguage: "zh", text: "本机草稿", isFinal: false }); await flush();
  assert.match(text(app.render()), /本机草稿/);
  app.click("暂停"); await flush();
  assert.equal(app.read("localCaptions").length, 0);
  assert.equal(app.read("room").captions[0].text, corrected.text);
});

test("speech health warns without restarting and stale callbacks cannot revive the warning", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush(); const old = app.speechOptions;
  old.onHealth("stalled"); app.render();
  assert.match(text(app.render()), /也可能是环境噪声/); assert.equal(app.starts, 1); assert.equal(app.stops, 0);
  old.onHealth("ok"); assert.doesNotMatch(text(app.render()), /也可能是环境噪声/);
  old.onHealth("stalled"); app.click("暂停"); await flush();
  old.onHealth("stalled"); old.onTiming({ languageWaitMs: 999 });
  assert.equal(app.read("speechHealth"), "ok"); assert.equal(app.read("diagnostics").languageMs, null);
  app.set("speechHealth", "stalled"); app.set("listening", true); app.set("room", { ...ready, state: "running" }); app.set("session", { ...session, role: "guest" });
  assert.doesNotMatch(text(app.render()), /也可能是环境噪声/);
});

test("diagnostics report separate local intervals, reject invalid samples, and label reuse", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush();
  app.speechOptions.onTiming({ languageWaitMs: 245.2 });
  app.captionWith(async () => { app.advance(380); return { room: { ...ready, state: "running", generation: 1 }, timing: { translationMs: 125, translationReused: false } }; });
  app.speechOptions.onCaption({ id: "metric", revision: 1, sourceLanguage: "zh", text: "计时", isFinal: true }); await flush();
  assert.equal(app.read("diagnostics").languageMs, 245); assert.equal(app.read("diagnostics").translationMs, 125); assert.equal(app.read("diagnostics").requestMs, 380);
  app.click("显示设置"); assert.match(text(app.render()), /不能相加作为端到端延迟/);
  app.speechOptions.onTiming({ languageWaitMs: Infinity }); assert.equal(app.read("diagnostics").languageMs, null);
  app.captionWith(async () => ({ room: { ...ready, state: "running", generation: 1 }, timing: { translationMs: null, translationReused: true } }));
  app.speechOptions.onCaption({ id: "reuse", revision: 1, sourceLanguage: "zh", text: "复用", isFinal: true }); await flush();
  assert.match(text(app.render()), /复用已有译文/);
  app.pollWith(async () => { app.advance(55); return { room: { ...ready, state: "running", generation: 1 } }; });
  app.render(); const stop = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("diagnostics").syncMs, 55); stop();
  app.set("session", { ...session, role: "guest" }); assert.doesNotMatch(text(app.render()), /复用已有译文/); assert.match(text(app.render()), /55 ms/);
});

test("late caption timings after reconnect do not replace the new session measurements", async () => {
  const app = await harness(); app.set("session", session); app.set("room", ready); app.render();
  app.click("开始对话"); await flush(); let finish;
  app.captionWith(() => new Promise(resolve => { finish = resolve; }));
  app.speechOptions.onCaption({ id: "old", revision: 1, sourceLanguage: "zh", text: "旧连接", isFinal: true }); await flush();
  app.click("重新连接"); await flush(); app.speechOptions.onTiming({ languageWaitMs: 100 });
  finish({ room: { ...ready, state: "running", generation: 1 }, timing: { translationMs: 999, translationReused: false } }); await flush();
  assert.equal(app.read("diagnostics").languageMs, 100); assert.equal(app.read("diagnostics").translationMs, null); assert.equal(app.read("localCaptions").length, 0);
});

const remoteReady = { ...ready, deviceMode: "remote", hostListening: false, guestListening: false, hostCaptureGeneration: 0, guestCaptureGeneration: 0 };
const remoteGuest = { ...session, role: "guest", language: "ja", token: "guest-token" };
function setRemote(app, current = session, next = remoteReady) { app.set("session", current); app.set("language", current.language); app.set("room", next); app.setServer(next); app.render(); }

test("remote creation is live-only and invitation hints do not override the server's room mode", async () => {
  const app = await harness(); app.set("checking", false); app.set("configured", true); app.click("远程双人");
  assert.equal(app.read("mode"), "live"); assert.ok(!nodes(app.render()).some(n => n.type === "button" && text(n) === "演示模式"));
  app.actionWith("create", async body => ({ session, room: { ...remoteReady, mode: body.mode } })); app.click("创建对话"); await flush();
  assert.equal(app.actions[0].deviceMode, "remote"); assert.equal(app.actions[0].mode, "live");
  app.set("origin", "https://example.test"); app.set("modal", "share");
  const invite = nodes(app.render()).find(n => n.type === "input" && n.props.className === "invite-url").props.value;
  assert.match(invite, /&device=remote$/);
  const joining = await harness({ search: "?join=ABCDEF01&host=zh&device=remote" }); joining.runEffect("setOrigin(location.origin)"); await flush();
  assert.equal(joining.read("deviceMode"), "remote"); assert.match(text(joining.render()), /離れた2人/);
  joining.set("room", { ...ready, deviceMode: "paired" }); joining.set("session", remoteGuest);
  assert.doesNotMatch(text(joining.render()), /自分のマイクをオン/);
});

test("both remote participants start only their microphone with fixed own language and scoped caption/token IDs", async () => {
  for (const current of [session, remoteGuest]) {
    const app = await harness(); setRemote(app, current);
    app.click(current.role === "host" ? "开启我的麦克风" : "自分のマイクをオン"); await flush();
    assert.equal(app.starts, 1); assert.equal(app.speechOptions.sourceLanguage, current.language);
    assert.equal(app.actions[0].captureGeneration, 0); assert.equal(app.actions[0].generation, remoteReady.generation);
    await app.speechOptions.getToken(); const tokenRequest = app.actions.at(-1);
    assert.equal(tokenRequest.captureGeneration, 1); assert.equal(tokenRequest.generation, 0);
    app.speechOptions.onCaption({ id: "sdk-sentence", revision: 1, text: "test", sourceLanguage: current.language, isFinal: true }); await flush();
    const caption = app.actions.find(a => a.action === "caption");
    assert.equal(caption.id, `${current.role === "host" ? "h" : "g"}-1-sdk-sentence`); assert.equal(caption.captureGeneration, 1);
    assert.equal(caption.speakerSide, current.role === "host" ? "a" : "b"); assert.equal(caption.sourceLanguage, current.language);
    assert.equal(app.read("room").generation, 0, "one microphone start does not advance the whole conversation");
  }
});

test("remote pause stops only the local stream while partner captions continue to arrive", async () => {
  const app = await harness(); setRemote(app, session, { ...remoteReady, state: "running", guestListening: true, guestCaptureGeneration: 3 });
  app.click("开启我的麦克风"); await flush(); app.render(); app.click("暂停我的麦克风"); await flush();
  assert.equal(app.stops, 1); assert.equal(app.read("room").hostListening, false); assert.equal(app.read("room").guestListening, true);
  assert.equal(app.read("room").guestCaptureGeneration, 3); assert.equal(app.read("room").state, "running");
  const pausing = app.actions.find(a => a.action === "pause"); assert.equal(pausing.captureGeneration, 1); assert.equal(pausing.generation, 0);
  const incoming = { ...editableCaption, id: "g-3-new", sourceLanguage: "ja", text: "こんにちは", translation: "你好" };
  app.pollWith(async () => ({ room: { ...app.read("room"), captions: [incoming] } })); app.render(); const stopPoll = app.runEffect("async function poll"); await flush();
  assert.match(text(app.render()), /你好/); assert.equal(app.button("开启我的麦克风").props.disabled, false); stopPoll();
});

test("the partner's capture changes do not stop local recognition, while a stale local capture does", async () => {
  const app = await harness(); setRemote(app); app.click("开启我的麦克风"); await flush();
  const started = app.read("room");
  app.pollWith(async () => ({ room: { ...started, guestListening: true, guestCaptureGeneration: 5 } })); app.render(); const stopPoll = app.runEffect("async function poll"); await flush();
  app.render(); app.runEffect('room?.state !== "running"'); assert.equal(app.stops, 0); assert.equal(app.read("listening"), true); stopPoll();
  app.set("room", { ...started, hostCaptureGeneration: 2 }); app.render(); app.runEffect('room?.state !== "running"');
  assert.equal(app.stops, 1); assert.equal(app.speechOptions.signal.aborted, true);
});

test("restoring a remote guest pauses only that guest and never opens audio automatically", async () => {
  const both = { ...remoteReady, state: "running", hostListening: true, guestListening: true, hostCaptureGeneration: 3, guestCaptureGeneration: 4 };
  const app = await harness({ saved: remoteGuest, cached: both }); app.setServer(both); app.runEffect("setOrigin(location.origin)"); await flush(); app.render();
  const stopPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.starts, 0); assert.equal(app.read("room").guestListening, false); assert.equal(app.read("room").hostListening, true);
  assert.equal(app.actions[0].action, "pause"); assert.equal(app.actions[0].captureGeneration, 4); assert.equal(app.read("room").hostCaptureGeneration, 3);
  assert.ok(app.button("自分のマイクをオン")); stopPoll();
});

test("capture generations beat request order so stale polls cannot roll back remote starts", async () => {
  const app = await harness(); setRemote(app); let finishStart;
  app.actionWith("start", () => new Promise(resolve => { finishStart = resolve; })); app.click("开启我的麦克风"); await flush();
  app.pollWith(async () => ({ room: remoteReady })); app.render(); const stopPoll = app.runEffect("async function poll"); await flush();
  const started = { ...remoteReady, state: "running", hostListening: true, hostCaptureGeneration: 1 };
  finishStart({ room: started }); await flush(); assert.equal(app.read("room").hostCaptureGeneration, 1); assert.equal(app.starts, 1); stopPoll();
  app.render(); const nextPoll = app.runEffect("async function poll"); await flush();
  assert.equal(app.read("room").hostCaptureGeneration, 1); assert.equal(app.read("room").state, "running"); nextPoll();
});

test("backgrounding during remote startup waits for its request, then pauses only that stream", async () => {
  const app = await harness(); setRemote(app, session, { ...remoteReady, state: "running", guestListening: true, guestCaptureGeneration: 2 }); let finishStart;
  app.actionWith("start", () => new Promise(resolve => { finishStart = resolve; })); app.click("开启我的麦克风"); await flush();
  app.render(); app.runEffect('document.addEventListener("visibilitychange"'); app.document.visibilityState = "hidden"; app.documentEvents.get("visibilitychange")(); await flush();
  assert.equal(app.actions.filter(a => a.action === "pause").length, 0);
  finishStart({ room: { ...remoteReady, state: "running", hostListening: true, guestListening: true, hostCaptureGeneration: 1, guestCaptureGeneration: 2 } }); await flush();
  assert.equal(app.starts, 0); assert.equal(app.actions.at(-1).action, "pause"); assert.equal(app.actions.at(-1).captureGeneration, 1);
  assert.equal(app.read("room").guestListening, true); assert.equal(app.read("room").hostListening, false);
});

test("remote NoMatch discards the scoped sentence after its write without touching the peer", async () => {
  const app = await harness(); setRemote(app, remoteGuest); let finishCaption;
  app.captionWith(() => new Promise(resolve => { finishCaption = resolve; })); app.click("自分のマイクをオン"); await flush();
  app.speechOptions.onCaption({ id: "partial", revision: 1, sourceLanguage: "ja", text: "はい", isFinal: false }); await flush();
  app.speechOptions.onCaption({ id: "partial", revision: 2, sourceLanguage: null, text: "", isFinal: true }); await flush();
  assert.equal(app.actions.some(a => a.action === "discard-caption"), false);
  finishCaption({ room: app.read("room") }); await flush();
  const discard = app.actions.find(a => a.action === "discard-caption"); assert.equal(discard.id, "g-1-partial"); assert.equal(discard.captureGeneration, 1); assert.equal(discard.generation, 0);
});

test("a late restore poll cannot pause a remote microphone explicitly reconnected in the meantime", async () => {
  const both = { ...remoteReady, state: "running", hostListening: true, guestListening: true, hostCaptureGeneration: 3, guestCaptureGeneration: 4 };
  const app = await harness({ saved: remoteGuest, cached: both }); app.setServer(both);
  app.runEffect("setOrigin(location.origin)"); await flush(); app.render();
  let resolvePoll, reads = 0;
  app.pollWith(() => ++reads === 1 ? new Promise(resolve => { resolvePoll = resolve; }) : Promise.resolve({ room: both }));
  const stopPoll = app.runEffect("async function poll");
  app.click("再接続"); await flush(); assert.equal(app.starts, 1); assert.equal(app.actions.filter(a => a.action === "pause").length, 1);
  resolvePoll({ room: both }); await flush(); app.render(); app.runEffect('room?.state !== "running"');
  assert.equal(app.actions.filter(a => a.action === "pause").length, 1); assert.equal(app.read("room").guestCaptureGeneration, 6); assert.equal(app.stops, 0); stopPoll();
});
