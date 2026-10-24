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
  const actions = [], timers = [], requestTimeouts = [], storageWrites = [];
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
    console, Date: class extends Date { static now() { return time; } }, URL, URLSearchParams, AbortController, Promise, Math, JSON, Error, DOMException,
    AbortSignal: { timeout: milliseconds => { const controller = new AbortController(); requestTimeouts.push({ milliseconds, controller }); return controller.signal; } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay, active: true }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].active = false; }, setInterval: () => 1, clearInterval() {},
    navigator: {}, crypto: globalThis.crypto, window: {}, localStorage: storage, sessionStorage: storage,
    location: { origin: "https://example.test", search, reload: () => { reloads++; } }, history: { replaceState() {} },
    document: { documentElement: {}, visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    fetch: async (path, init) => {
      let result;
      if (path === "/api/config") result = { speechReady: true };
      else if (String(path).startsWith("/api/room?")) result = await Promise.race([getRoom(), new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))]);
      else {
        const body = JSON.parse(init.body); actions.push(body);
        if (body.action === "start") serverRoom = { ...serverRoom, state: "running", generation: serverRoom.generation + 1 };
        if (body.action === "pause") serverRoom = { ...serverRoom, state: "paused", generation: serverRoom.generation + 1 };
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
  await page.link(name => { const exports = modules[name]; assert.ok(exports, `Unexpected module: ${name}`);
    return new vm.SyntheticModule(Object.keys(exports), function () { Object.entries(exports).forEach(([key, value]) => this.setExport(key, value)); }, { context }); });
  await page.evaluate();
  const render = () => { stateIndex = refIndex = 0; effects = []; return page.namespace.default(); };
  const runEffect = marker => { const effect = effects.find(candidate => candidate.toString().includes(marker)); assert.ok(effect, `Missing effect: ${marker}`); return effect(); };
  const read = name => states[stateNames.indexOf(name)];
  const set = (name, value) => { const index = stateNames.indexOf(name); assert.ok(index >= 0); states[index] = value; };
  render();
  return { render, runEffect, read, set, actions, stored, storageWrites, requestTimeouts, timers, setServer: room => { serverRoom = room; },
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

test("the host invite defaults to the other language", async () => {
  const app = await harness();
  app.set("session", session); app.set("room", ready); app.set("origin", "https://example.test"); app.set("modal", "share");
  const invite = nodes(app.render()).find(node => node.props?.className === "invite-url");
  assert.equal(invite.props.value, "https://example.test/?join=ABCDEFGH&lang=ja");
  app.set("room", { ...ready, hostLanguage: "ja" });
  assert.equal(nodes(app.render()).find(node => node.props?.className === "invite-url").props.value.endsWith("&lang=zh"), true);
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
