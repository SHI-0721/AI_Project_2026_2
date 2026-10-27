// Run: node --experimental-vm-modules --test tests/solo-page.test.mjs
// Real component/hook logic with fake services; browser layout and real microphone remain separate checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/solo/page.tsx", import.meta.url), "utf8");
const compile = text => ts.transpileModule(text, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const names = [...source.matchAll(/const \[(\w+),\s*\w+\] = useState/g)].map(match => match[1]);
const icons = source.match(/import \{ ([^}]+) \} from "lucide-react"/)[1].split(",").map(name => name.trim());
const session = { roomId: "solo-room", token: "a".repeat(64), role: "host", language: "zh", code: "ABCDEF12" };
const ready = { id: session.roomId, code: session.code, state: "ready", deviceMode: "solo", mode: "live", hostLanguage: "zh", guestLanguage: "ko", guestStatus: "none", hostOnline: true, guestOnline: false, captions: [], startedAt: null, expiresAt: Date.now() + 600000, demoIndex: 0, generation: 0 };
const sentence = (side, id = side) => ({ id, revision: 1, sourceLanguage: "zh", text: `${id} 原文`, translation: `${id} 译文`, isFinal: true, translationState: side ? "done" : "pending", createdAt: Date.now(), edited: false, speakerSide: side, speakerId: side ? `Guest-${side}` : null, targetLanguage: side === "a" ? "ko" : side === "b" ? "zh" : null });
function text(node) { return typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : ""; }
function nodes(node, found = []) { if (node && typeof node === "object") { found.push(node); Object.values(node).forEach(child => nodes(child, found)); } return found; }
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

async function harness({ saved = false, preferred } = {}) {
  const states = [], refs = [], actions = [], timers = [], listeners = new Map(), stored = new Map();
  let stateIndex = 0, refIndex = 0, effects = [], serverRoom = { ...ready }, options, starts = 0, stops = 0, reloads = 0;
  let getRoom = async () => ({ room: serverRoom });
  const overrides = new Map();
  if (saved) { stored.set("kotoba-solo-session", JSON.stringify(session)); stored.set("kotoba-solo-room", JSON.stringify(ready)); }
  if (preferred) stored.set("kotoba-language", preferred);
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const document = { documentElement: {}, visibilityState: "visible", querySelector: () => null,
    addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener: event => listeners.delete(event) };
  const context = vm.createContext({ console, Date, URL, URLSearchParams, Promise, Math, JSON, Error, DOMException, AbortController, AbortSignal, crypto: globalThis.crypto,
    setTimeout: (callback, delay) => { timers.push({ callback, delay, active: true }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].active = false; },
    localStorage: storage, sessionStorage: storage, navigator: {}, document, location: { reload: () => reloads++ },
    fetch: async (path, init) => {
      let result;
      if (path === "/api/config") result = { speechReady: true };
      else if (String(path).startsWith("/api/room?")) result = await getRoom();
      else if (path === "/api/speech-token") result = { token: "fake", region: "koreacentral" };
      else {
        const body = JSON.parse(init.body); actions.push(body);
        if (overrides.has(body.action)) result = await overrides.get(body.action)(body);
        else {
          if (body.action === "create") serverRoom = { ...ready, hostLanguage: body.language, guestLanguage: body.otherLanguage, mode: body.mode };
          if (body.action === "start") serverRoom = { ...serverRoom, state: "running", generation: serverRoom.generation + 1 };
          if (body.action === "pause") serverRoom = { ...serverRoom, state: "paused", generation: serverRoom.generation + 1 };
          if (body.action === "caption") serverRoom = { ...serverRoom, captions: [...serverRoom.captions.filter(c => c.id !== body.id), { ...sentence(body.speakerSide, body.id), ...body }] };
          if (body.action === "end") serverRoom = { ...serverRoom, state: "ended", captions: [] };
          result = { room: serverRoom, ...(body.action === "create" ? { session } : {}) };
        }
      }
      return { ok: !result.httpStatus || result.httpStatus < 400, status: result.httpStatus ?? 200, json: async () => result.body ?? result };
    },
  });
  const modules = { react: {
    useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], value => states[i] = typeof value === "function" ? value(states[i]) : value]; },
    useRef(value) { return refs[refIndex++] ??= { current: value }; }, useEffect(effect) { effects.push(effect); }, useCallback: fn => fn,
  }, "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
    "lucide-react": Object.fromEntries(icons.map(icon => [icon, icon])),
    "@/lib/speech": { startSpeech: async value => { starts++; options = value; let stopped = false; return { stop: async () => { if (!stopped) { stopped = true; stops++; value.onStopped(); } } }; } },
  };
  const page = new vm.SourceTextModule(compile(source), { context });
  await page.link(name => {
    if (["@/lib/languages", "@/lib/ui-copy"].includes(name)) return new vm.SourceTextModule(compile(readFileSync(new URL(`../lib/${name.split("/").at(-1)}.ts`, import.meta.url), "utf8")), { context });
    const exported = modules[name]; assert.ok(exported, `Unexpected import ${name}`);
    return new vm.SyntheticModule(Object.keys(exported), function () { Object.entries(exported).forEach(([key, value]) => this.setExport(key, value)); }, { context });
  });
  await page.evaluate();
  const render = () => { stateIndex = refIndex = 0; effects = []; return page.namespace.default(); };
  const set = (name, value) => { const i = names.indexOf(name); assert.ok(i >= 0, name); states[i] = value; };
  const read = name => states[names.indexOf(name)];
  render();
  return { render, set, read, stored, actions, timers, document, listeners,
    active(room = ready) { set("session", session); set("room", room); serverRoom = room; render(); },
    effect(marker) { const effect = effects.find(fn => fn.toString().includes(marker)); assert.ok(effect, `Missing effect: ${marker}`); return effect(); },
    override: (action, fn) => overrides.set(action, fn), pollWith: fn => getRoom = fn, server: room => serverRoom = room,
    click(label, within) { const button = nodes(within ?? render()).find(n => n.type === "button" && text(n).trim() === label); assert.ok(button, `Missing button: ${label}`); button.props.onClick(); },
    get speechOptions() { return options; }, get starts() { return starts; }, get stops() { return stops; }, get reloads() { return reloads; },
  };
}

test("solo creation allows matching language preferences and rotation does not change speaker ownership", async () => {
  const app = await harness(); app.set("otherLanguage", "zh"); app.set("checking", false); app.click("进入单手机对话"); await flush();
  assert.equal(app.actions[0].deviceMode, "solo"); assert.equal(app.actions[0].language, "zh"); assert.equal(app.actions[0].otherLanguage, "zh");
  const upper = nodes(app.render()).find(n => n.props?.className?.includes("solo-panel opponent"));
  assert.ok(upper.props.className.includes("rotated"));
  app.click("旋转上半屏"); assert.equal(app.read("rotated"), false); assert.equal(app.actions.length, 1);
});

test("a restored live room pauses without starting audio and uses separate solo storage", async () => {
  const app = await harness({ saved: true, preferred: "ko" }); app.server({ ...ready, state: "running", generation: 1 });
  app.effect('localStorage.getItem("kotoba-language")'); await flush(); app.render();
  const cancel = app.effect("async function poll"); await flush();
  assert.equal(app.starts, 0); assert.equal(app.read("room").state, "paused");
  assert.ok(app.actions.some(a => a.action === "pause")); assert.ok(!app.stored.has("kotoba-session")); cancel();
  const fresh = await harness({ preferred: "ko" }); fresh.effect('localStorage.getItem("kotoba-language")'); await flush();
  assert.equal(fresh.read("language"), "ko"); assert.equal(fresh.read("otherLanguage"), "zh");
});

test("equal source languages are split by speaker, while unknown speech stays neutral and can be assigned", async () => {
  const app = await harness(); app.active({ ...ready, state: "running", captions: [sentence("a"), sentence("b"), sentence(null, "unknown")] });
  const tree = app.render(), upper = nodes(tree).find(n => n.props?.className?.includes("solo-panel opponent")), lower = nodes(tree).find(n => n.props?.className?.includes("solo-panel self")), unknown = nodes(tree).find(n => n.props?.className === "solo-unknown");
  assert.ok(text(upper).includes("a 译文")); assert.ok(!text(upper).includes("b 译文"));
  assert.ok(text(lower).includes("b 译文")); assert.ok(!text(lower).includes("unknown 原文")); assert.ok(text(unknown).includes("unknown 原文"));
  app.click("改为 B 说", unknown); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.actions[0])), { action: "edit-caption", roomId: session.roomId, id: "unknown", revision: 1, text: "unknown 原文", speakerSide: "b" });
});

test("speech starts in diarization mode and an unidentified partial is not assigned by language", async () => {
  const app = await harness(); app.active(); app.click("开始对话"); await flush();
  assert.equal(app.starts, 1); assert.equal(app.speechOptions.diarization, true); assert.deepEqual([...app.speechOptions.languages], ["zh", "ko"]);
  app.speechOptions.onCaption({ id: "partial", revision: 1, sourceLanguage: "zh", speakerSide: null, speakerId: null, text: "你好", isFinal: false }); await flush();
  const unknown = nodes(app.render()).find(n => n.props?.className === "solo-unknown"); assert.ok(unknown); assert.ok(text(unknown).includes("你好"));
  app.click("暂停"); await flush(); assert.equal(app.stops, 1); assert.equal(app.read("listening"), false); assert.equal(app.speechOptions.signal.aborted, true);
});

test("pause during an outstanding start waits for it, then prevents microphone activation", async () => {
  const app = await harness(); app.active(); let finishStart;
  app.override("start", () => new Promise(resolve => finishStart = resolve)); app.click("开始对话"); await flush();
  app.render(); app.effect('document.addEventListener("visibilitychange"');
  app.document.visibilityState = "hidden"; app.listeners.get("visibilitychange")(); await flush();
  assert.equal(app.actions.some(a => a.action === "pause"), false);
  finishStart({ room: { ...ready, state: "running", generation: 1 } }); await flush();
  assert.equal(app.starts, 0); assert.equal(app.actions.at(-1).action, "pause");
});

test("both speakers can be corrected; a revision conflict keeps the draft for explicit resubmission", async () => {
  const app = await harness(), b = { ...sentence("b"), sourceLanguage: "ko" };
  app.active({ ...ready, state: "paused", captions: [b] }); app.click("修改");
  const edit = app.read("editing"); assert.ok(edit); app.set("editing", { ...edit, text: "纠正后的原文", side: "a" });
  app.override("edit-caption", async () => ({ httpStatus: 409, body: { code: "STALE_UPDATE", error: "冲突" } }));
  app.pollWith(async () => ({ room: { ...ready, state: "paused", captions: [{ ...b, revision: 2, text: "更新原文" }] } }));
  app.click("保存并重新翻译"); await flush();
  assert.equal(app.read("editing").text, "纠正后的原文"); assert.equal(app.read("editing").revision, 2); assert.equal(app.read("editing").side, "a");
  assert.equal(app.actions[0].speakerSide, "a"); assert.equal(app.actions[0].text, "纠正后的原文");
});

test("late pre-start polls cannot roll a running solo session back", async () => {
  const app = await harness(); app.active(); let finishPoll;
  app.pollWith(() => new Promise(resolve => finishPoll = resolve)); const cancel = app.effect("async function poll");
  app.click("开始对话"); await flush(); assert.equal(app.starts, 1);
  finishPoll({ room: ready }); await flush(); assert.equal(app.read("room").generation, 1); assert.equal(app.read("room").state, "running"); cancel();
});

test("NoMatch waits for pending caption writes before deleting the partial", async () => {
  const app = await harness(); app.active(); let finishCaption;
  app.override("caption", () => new Promise(resolve => finishCaption = resolve)); app.click("开始对话"); await flush();
  app.speechOptions.onCaption({ id: "no-match", revision: 1, sourceLanguage: "zh", speakerSide: null, speakerId: null, text: "未完成", isFinal: false }); await flush();
  app.speechOptions.onCaption({ id: "no-match", revision: 2, sourceLanguage: null, speakerSide: null, speakerId: null, text: "", isFinal: true }); await flush();
  assert.equal(app.actions.some(a => a.action === "discard-caption"), false);
  finishCaption({ room: { ...ready, state: "running", generation: 1 } }); await flush();
  assert.equal(app.actions.at(-1).action, "discard-caption"); assert.equal(app.actions.at(-1).generation, 1);
});

test("tall captions align their beginning even in a rotated panel and preserve deliberate scrollback", async () => {
  const app = await harness(), panels = nodes(app.render()).filter(n => n.props?.className === "caption-scroll");
  const tall = { scrollTop: 500, scrollHeight: 840, clientHeight: 240, lastElementChild: { offsetHeight: 340, offsetTop: 400 } };
  const short = { scrollTop: 500, scrollHeight: 780, clientHeight: 240, lastElementChild: { offsetHeight: 140, offsetTop: 640 } };
  panels[0].props.ref.current = tall; panels[1].props.ref.current = short;
  app.effect("el.scrollHeight - el.scrollTop - el.clientHeight"); assert.equal(tall.scrollTop, 400); assert.equal(short.scrollTop, 780);
  tall.scrollTop = 0; app.effect("el.scrollHeight - el.scrollTop - el.clientHeight"); assert.equal(tall.scrollTop, 0);
});
