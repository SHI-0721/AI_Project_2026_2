// Run: node --experimental-vm-modules --test tests/meeting-page.test.mjs
// Real component logic with mocked capture/SDK/network. Not browser permission or actual meeting acceptance.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../app/meeting/page.tsx", import.meta.url), "utf8");
const compile = value => ts.transpileModule(value, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const names = [...source.matchAll(/const \[(\w+),\s*\w+\] = useState/g)].map(match => match[1]);
const icons = source.match(/import \{ ([^}]+) \} from "lucide-react"/)[1].split(",").map(value => value.trim());
const voice = { name: "Local English", lang: "en-US", localService: true };
function text(node) { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : ""; }
function nodes(node, result = []) { if (node && typeof node === "object") { result.push(node); Object.values(node).forEach(value => nodes(value, result)); } return result; }
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function deferred() { return Promise.withResolvers(); }

async function harness() {
  const states = [], refs = [], actions = [], events = [], captures = [], options = [], listeners = new Map(), timers = [], spoken = [], copied = [], overrides = new Map();
  let stateIndex = 0, refIndex = 0, effects = [], room = null, count = 0, stops = 0, now = Date.now();
  let choose = async capture => capture, close = async () => {}, poll = async () => ({ room });
  const makeCapture = () => {
    const ended = new AbortController();
    const capture = { stream: { kind: "test-audio-stream" }, ended: ended.signal, stopped: false, stop() { if (!this.stopped) { this.stopped = true; events.push("capture-stop"); ended.abort(); } } };
    captures.push(capture); return capture;
  };
  const context = vm.createContext({ console, Date: class extends Date { static now() { return now; } }, URL, Promise, Math, JSON, Error, DOMException, AbortController, AbortSignal, crypto: globalThis.crypto,
    setTimeout: (callback, delay) => { timers.push({ callback, delay, active: true }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].active = false; },
    setInterval: (callback, delay) => { timers.push({ callback, delay, active: true }); return timers.length; }, clearInterval: id => { if (timers[id - 1]) timers[id - 1].active = false; },
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    navigator: { clipboard: { writeText: async value => copied.push(value) } },
    speechSynthesis: { getVoices: () => [voice], addEventListener() {}, removeEventListener() {}, cancel: () => events.push("tts-cancel"), speak: utterance => { events.push("tts-speak"); spoken.push(utterance); } },
    SpeechSynthesisUtterance: class { constructor(value) { this.text = value; } },
    fetch: async (path, init) => {
      events.push(`fetch:${path}`); let result;
      if (path === "/api/config") result = { speechReady: true };
      else if (String(path).startsWith("/api/room?")) result = await poll();
      else if (path === "/api/speech-token") result = overrides.has("token") ? await overrides.get("token")() : { token: "fake", region: "koreacentral" };
      else {
        const body = JSON.parse(init.body); actions.push(body);
        if (overrides.has(body.action)) result = await overrides.get(body.action)(body);
        else {
          if (body.action === "create") { count++; room = { id: `meeting-${count}`, code: "ABCDEF12", mode: "live", deviceMode: "solo", state: "ready", hostLanguage: body.language, guestLanguage: body.otherLanguage, guestStatus: "none", captions: [], generation: 0, startedAt: null, expiresAt: now + 1800000 }; }
          if (body.action === "start") room = { ...room, state: "running", generation: room.generation + 1, startedAt: now };
          if (body.action === "pause") room = { ...room, state: "paused", generation: room.generation + 1, captions: room.captions.filter(c => c.isFinal) };
          if (body.action === "end") room = { ...room, state: "ended", generation: room.generation + 1, captions: [] };
          if (body.action === "caption") {
            const targetLanguage = body.speakerSide === "a" ? room.guestLanguage : room.hostLanguage;
            room = { ...room, captions: [...room.captions.filter(c => c.id !== body.id), { ...body, translation: `${body.text} translated`, translationState: "done", targetLanguage, createdAt: now, edited: false }] };
          }
          if (body.action === "discard-caption") room = { ...room, captions: room.captions.filter(c => c.id !== body.id) };
          result = { room, ...(body.action === "create" ? { session: { roomId: room.id, role: "host", token: `fake-token-${count}`, language: body.language, code: room.code } } : {}) };
        }
      }
      return { ok: !result.httpStatus || result.httpStatus < 400, status: result.httpStatus ?? 200, json: async () => result.body ?? result };
    },
  });
  const modules = { react: {
    useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], value => states[i] = typeof value === "function" ? value(states[i]) : value]; },
    useRef(value) { return refs[refIndex++] ??= { current: value }; }, useEffect(effect) { effects.push(effect); },
  }, "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
    "lucide-react": Object.fromEntries(icons.map(name => [name, name])), "./meeting.css": {}, "next/link": { default: "a" },
    "@/lib/audio-capture": { captureAudio: (source, signal) => { events.push("capture"); const capture = makeCapture(); capture.source = source; capture.signal = signal; return choose(capture); } },
    "@/lib/speech": { startSpeech: async value => { events.push("speech-start"); options.push(value); await value.getToken(); let stopped = false; return { stop: async () => { if (!stopped) { stopped = true; stops++; events.push("speech-stop"); await close(); value.onStopped(); } } }; } },
  };
  const page = new vm.SourceTextModule(compile(source), { context });
  await page.link(name => {
    if (name === "@/lib/languages") return new vm.SourceTextModule(compile(readFileSync(new URL("../lib/languages.ts", import.meta.url), "utf8")), { context });
    const exported = modules[name]; assert.ok(exported, name);
    return new vm.SyntheticModule(Object.keys(exported), function () { Object.entries(exported).forEach(([key, value]) => this.setExport(key, value)); }, { context });
  });
  await page.evaluate();
  const render = () => { stateIndex = refIndex = 0; effects = []; return page.namespace.default(); };
  const set = (name, value) => { const i = names.indexOf(name); assert.ok(i >= 0, name); states[i] = value; };
  const read = name => states[names.indexOf(name)];
  const click = label => { const button = nodes(render()).find(n => n.type === "button" && (text(n).trim() === label || n.props?.["aria-label"] === label)); assert.ok(button, `Missing button: ${label}`); button.props.onClick(); };
  render(); set("configured", true); set("voices", [voice]);
  return { render, read, set, click, actions, events, captures, options, spoken, copied, listeners, timers,
    get stops() { return stops; }, get room() { return room; }, server: value => room = value,
    choose: fn => choose = fn, close: fn => close = fn, override: (name, fn) => overrides.set(name, fn), poll: fn => poll = fn,
    effect(marker) { const effect = effects.find(fn => fn.toString().includes(marker)); assert.ok(effect, `Missing effect ${marker}`); return effect(); },
    select(label, value) { const group = nodes(render()).find(n => n.type === "label" && text(n).startsWith(label)); nodes(group).find(n => n.type === "select").props.onChange({ target: { value } }); },
    advance: value => now += value,
    caption: async (value = {}) => { options.at(-1).onCaption({ id: "sentence", revision: 1, text: "Hello", sourceLanguage: "en", isFinal: true, ...value }); await flush(); },
  };
}

test("display capture starts synchronously before any API, then fixed-language recognition uses the selected stream", async () => {
  const app = await harness(), picked = deferred(); app.choose(() => picked.promise); app.click("开始收音");
  assert.equal(app.events[1], "capture"); assert.equal(app.actions.length, 0);
  picked.resolve(app.captures[0]); await flush();
  assert.equal(app.read("status"), "listening"); assert.equal(app.captures[0].source, "display");
  assert.equal(app.options[0].capture, app.captures[0]); assert.equal(app.options[0].sourceLanguage, "en"); assert.equal(app.options[0].diarization, false);
  assert.equal(app.actions[0].deviceMode, "solo"); assert.equal(app.actions[0].language, "en"); assert.equal(app.actions[0].otherLanguage, "zh");
});

test("canceling a pending permission dialog releases a late stream without creating a room", async () => {
  const app = await harness(), picked = deferred(); app.choose(() => picked.promise); app.click("开始收音"); app.click("取消连接");
  assert.equal(app.captures[0].signal.aborted, true); picked.resolve(app.captures[0]); await flush();
  assert.equal(app.captures[0].stopped, true); assert.equal(app.actions.length, 0); assert.equal(app.options.length, 0); assert.equal(app.read("status"), "paused");
});

test("permission cancellation and no-audio failures are visible without pretending to listen", async () => {
  for (const error of [new DOMException("denied", "NotAllowedError"), new Error("所选窗口没有共享音频，请选择标签页并勾选共享音频。")]) {
    const app = await harness(); app.choose(async () => { throw error; }); app.click("开始收音"); await flush();
    assert.equal(app.read("status"), "paused"); assert.match(app.read("error"), /共享|音频/); assert.equal(app.options.length, 0); assert.equal(app.actions.length, 0);
  }
});

test("partial and final updates replace one row and copy uses the final translation", async () => {
  const app = await harness(); app.click("开始收音"); await flush();
  await app.caption({ text: "Hel", isFinal: false }); await app.caption({ text: "Hello", revision: 2, isFinal: false }); await app.caption({ text: "Hello world", revision: 3 });
  assert.equal(app.read("rows").length, 1); assert.equal(app.read("rows")[0].text, "Hello world"); assert.equal(app.read("rows")[0].isFinal, true);
  app.click("复制此句译文"); await flush(); assert.equal(app.copied[0], "Hello world translated");
});

test("reversing the language pair reuses the room with the other speaker side and stops prior capture", async () => {
  const app = await harness(); app.click("开始收音"); await flush(); await app.caption();
  app.click("我发言中文 → 英语 · 麦克风"); await flush(); assert.equal(app.captures[0].stopped, true);
  app.click("继续收音"); await flush(); await app.caption({ id: "reply", text: "你好", sourceLanguage: "zh" });
  assert.equal(app.actions.filter(a => a.action === "create").length, 1); assert.equal(app.captures[1].source, "microphone");
  assert.equal(app.options[1].sourceLanguage, "zh"); assert.equal(app.actions.at(-1).speakerSide, "b"); assert.equal(app.read("rows").at(-1).targetLanguage, "en");
});

test("changing en-zh to en-en creates an exact same-language room instead of translating to the old target", async () => {
  const app = await harness(); app.click("开始收音"); await flush(); app.select("译文语言", "en"); await flush(); app.click("继续收音"); await flush();
  assert.equal(app.actions.filter(a => a.action === "create").length, 2); assert.equal(app.room.hostLanguage, "en"); assert.equal(app.room.guestLanguage, "en");
});

test("English playback waits for full recognizer close, pauses the room, and never resumes capture automatically", async () => {
  const app = await harness(); app.set("sourceLanguage", "zh"); app.set("targetLanguage", "en"); app.click("开始收音"); await flush(); await app.caption({ text: "你好", sourceLanguage: "zh" });
  const closed = deferred(); app.close(() => closed.promise); app.click("本机播放英文译文"); await flush();
  assert.equal(app.captures[0].stopped, true); assert.equal(app.spoken.length, 0); assert.equal(app.read("status"), "paused");
  closed.resolve(); await flush(); assert.equal(app.spoken.length, 1); assert.equal(app.spoken[0].voice.localService, true); assert.equal(app.room.state, "paused");
  app.spoken[0].onend(); assert.equal(app.options.length, 1); assert.equal(app.read("speaking"), false);
});

test("a delayed playback request cannot speak after the user starts another capture", async () => {
  const app = await harness(); app.set("sourceLanguage", "zh"); app.set("targetLanguage", "en"); app.click("开始收音"); await flush(); await app.caption();
  const closed = deferred(); app.close(() => closed.promise); app.click("本机播放英文译文"); await flush(); app.click("继续收音"); await flush();
  closed.resolve(); await flush(); assert.equal(app.spoken.length, 0); assert.equal(app.options.length, 2); assert.equal(app.read("status"), "listening");
});

test("stop removes unresolved partials, preserves confirmed history, and ignores late partial responses", async () => {
  const app = await harness(); app.click("开始收音"); await flush(); await app.caption({ id: "final" });
  const held = deferred(); app.override("caption", () => held.promise); await app.caption({ id: "draft", text: "unfinished", isFinal: false });
  app.click("停止"); await flush(); assert.equal(app.read("rows").length, 1); assert.equal(app.read("rows")[0].id, "final");
  held.resolve({ room: { ...app.room, state: "running", captions: [{ id: "draft", revision: 1, text: "unfinished", sourceLanguage: "en", isFinal: false, translationState: "pending", translation: "" }] } }); await flush();
  assert.equal(app.read("rows").length, 1); assert.equal(app.read("status"), "stopped");
});

test("NoMatch tombstones prevent a delayed partial from reappearing before or after discard", async () => {
  const app = await harness(); app.click("开始收音"); await flush(); const held = deferred(); let body;
  app.override("caption", value => { body = value; return held.promise; }); await app.caption({ text: "unfinished", isFinal: false });
  await app.caption({ text: "", revision: 2 }); assert.equal(app.read("rows").length, 0);
  const stale = { ...app.room, captions: [{ ...body, translationState: "pending", translation: "" }] }; app.server(stale); held.resolve({ room: stale }); await flush();
  assert.equal(app.read("rows").length, 0); assert.equal(app.actions.at(-1).action, "discard-caption");
});

test("network loss stops capture, while changing browser tabs does not install a visibility pause", async () => {
  const app = await harness(); const cleanup = app.effect("updateVoices"); await flush(); app.click("开始收音"); await flush(); app.render();
  assert.equal(app.listeners.has("visibilitychange"), false); app.poll(async () => { throw new TypeError("network"); });
  const stopPoll = app.effect("async function poll"); await flush(); assert.equal(app.captures[0].stopped, true); assert.equal(app.read("status"), "paused"); assert.match(app.read("error"), /网络/);
  stopPoll(); cleanup();
});

test("pagehide and unmount release capture; no native English voice gives an actionable message", async () => {
  const app = await harness(); const cleanup = app.effect("updateVoices"); await flush(); app.set("sourceLanguage", "zh"); app.set("targetLanguage", "en"); app.click("开始收音"); await flush(); await app.caption();
  app.set("voices", []); app.click("本机播放英文译文"); await flush(); assert.match(app.read("error"), /安装英语语音/); assert.equal(app.spoken.length, 0);
  app.listeners.get("pagehide")(); await flush(); assert.equal(app.captures[0].stopped, true); assert.equal(app.read("status"), "paused"); cleanup();
});

test("the room's actual expiry drives the remaining-time warning and active layout preserves transcript space", async () => {
  const app = await harness(); app.click("开始收音"); await flush(); app.set("now", app.room.expiresAt - 59000);
  const tree = app.render(); assert.match(tree.props.className, /meeting-active/); assert.match(text(tree), /00:59/); assert.ok(nodes(tree).some(n => n.props?.className?.includes("near-limit"))); assert.match(text(tree), /400 条/);
});
