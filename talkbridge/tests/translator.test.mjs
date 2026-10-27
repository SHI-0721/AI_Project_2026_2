// Run: node --experimental-vm-modules --test tests/translator.test.mjs
// Runs the real API handler and SQL with an in-memory database and a fake Azure response; no credentials/network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../lib/server.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const schema = readdirSync(new URL("../drizzle/", import.meta.url)).filter(file => file.endsWith(".sql")).sort()
  .map(file => readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8")).join("\n");
const languages = ts.transpileModule(readFileSync(new URL("../lib/languages.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
function linkServer(name, context, env) {
  if (name === "./languages") return new vm.SourceTextModule(languages, { context });
  assert.equal(name, "cloudflare:workers");
  return new vm.SyntheticModule(["env"], function () { this.setExport("env", env); }, { context });
}

test("live captions omit the Global header, retain regional authentication, and save translated text", async () => {
  for (const [region, sourceLanguage, original, translated] of [
    ["global", "zh", "你好", "こんにちは"], ["koreacentral", "ja", "ありがとう", "谢谢"],
  ]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(schema);
      const now = Date.now(), token = "a".repeat(64), tokenHash = createHash("sha256").update(token).digest("hex");
      database.prepare(`INSERT INTO rooms (id,code,host_token_hash,host_language,guest_language,guest_token_hash,mode,state,
        guest_status,created_at,expires_at,host_seen_at,guest_seen_at,generation)
        VALUES ('test-room','1234ABCD',?,'zh','ja','fake-guest-hash','live','running','approved',?,?,?,?,3)`)
        .run(tokenHash, now, now + 60000, now, now);
      const env = { AZURE_SPEECH_KEY: "fake-speech-key", AZURE_SPEECH_REGION: "koreacentral",
        AZURE_TRANSLATOR_KEY: "fake-translator-key", AZURE_TRANSLATOR_REGION: region,
        DB: { prepare(sql) { return { bind(...values) {
          const query = database.prepare(sql);
          return { first: async () => query.get(...values), all: async () => ({ results: query.all(...values) }),
            run: async () => ({ meta: query.run(...values) }) };
        } }; } },
      };
      const calls = [];
      const context = vm.createContext({ Response, URL, crypto: globalThis.crypto, TextEncoder, TextDecoder, performance,
        AbortSignal, fetch: async (url, init) => {
          calls.push({ url, init });
          return Response.json([{ translations: [{ text: translated }] }]);
        } });
      const server = new vm.SourceTextModule(compiled, { context });
      await server.link(name => linkServer(name, context, env));
      await server.evaluate();
      assert.equal(server.namespace.speechReady(), true);
      const response = await server.namespace.postRoom(new Request("https://example.test/api/room", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "caption", roomId: "test-room", generation: 3, id: "sentence-1",
          revision: 1, sourceLanguage, text: original, isFinal: true }),
      }));
      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      const headers = new Headers(calls[0].init.headers);
      assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "fake-translator-key");
      assert.equal(headers.get("Ocp-Apim-Subscription-Region"), region === "global" ? null : region);
      assert.deepEqual(JSON.parse(calls[0].init.body), [{ Text: original }]);
      const url = new URL(calls[0].url);
      assert.equal(url.origin, "https://api.cognitive.microsofttranslator.com");
      assert.equal(url.searchParams.get("from"), sourceLanguage === "zh" ? "zh-Hans" : "ja");
      assert.equal(url.searchParams.get("to"), sourceLanguage === "zh" ? "ja" : "zh-Hans");
      const caption = (await response.json()).room.captions[0];
      assert.equal(caption.translation, translated);
      assert.equal(caption.translationState, "done");
      assert.equal(caption.text, original);
      assert.equal(caption.isFinal, true);
    } finally { database.close(); }
  }
});

async function fixture(translate = async (text) => text + " translated", pair = ["zh", "ja"], issueToken = async () => "fake-speech-token") {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  let now = Date.now();
  let roomReadHold;
  const hostToken = "a".repeat(64), guestToken = "b".repeat(64);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  database.prepare(`INSERT INTO rooms (id,code,host_token_hash,guest_token_hash,host_language,guest_language,
    mode,state,guest_status,created_at,expires_at,host_seen_at,guest_seen_at,generation)
    VALUES ('test-room','1234ABCD',?,?,?,?,'live','running','approved',?,?,?,?,3)`)
    .run(digest(hostToken), digest(guestToken), ...pair, now, now + 60000, now, now);
  const prepare = (sql) => ({ bind(...values) {
    const query = database.prepare(sql), run = () => ({ meta: query.run(...values) });
    return { first: async () => {
      const row = query.get(...values);
      if (sql === "SELECT * FROM rooms WHERE id=?" && roomReadHold) {
        const hold = roomReadHold;
        roomReadHold = undefined;
        hold.started.resolve();
        await hold.released.promise;
      }
      return row;
    }, all: async () => ({ results: query.all(...values) }), run, _run: run };
  } });
  const env = { AZURE_SPEECH_KEY: "fake-speech-key", AZURE_SPEECH_REGION: "koreacentral",
    AZURE_TRANSLATOR_KEY: "fake-translator-key", AZURE_TRANSLATOR_REGION: "global",
    DB: { prepare, batch: async (statements) => {
      database.exec("BEGIN");
      try { const result = statements.map(item => item._run()); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    } },
  };
  const calls = [];
  const context = vm.createContext({ Response, URL, crypto: globalThis.crypto, TextEncoder, TextDecoder, performance: { now: () => now },
    Date: class extends Date { static now() { return now; } }, AbortSignal,
    fetch: async (url, init) => {
      if (url.includes("/sts/v1.0/issueToken")) return new Response(await issueToken());
      const text = JSON.parse(init.body)[0].Text;
      calls.push(text);
      return Response.json([{ translations: [{ text: await translate(text, new URL(url)) }] }]);
    } });
  const server = new vm.SourceTextModule(compiled, { context });
  await server.link(name => linkServer(name, context, env));
  await server.evaluate();
  const send = async (action, data = {}, token = hostToken) => {
    const response = await server.namespace.route(() => server.namespace.postRoom(new Request("https://example.test/api/room", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, roomId: "test-room", ...data }),
    })));
    return { status: response.status, ...await response.json() };
  };
  const caption = (text, revision, isFinal = false, generation = 3, id = "sentence-1") => send("caption", {
    id, generation, revision, sourceLanguage: "zh", text, isFinal,
  });
  const read = async (token = hostToken, roomId = "test-room") => {
    const response = await server.namespace.route(() => server.namespace.getRoom(new Request(`https://example.test/api/room?roomId=${roomId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })));
    return { status: response.status, ...await response.json() };
  };
  const speechToken = async (data = {}, token = hostToken) => {
    const response = await server.namespace.route(() => server.namespace.speechToken(new Request("https://example.test/api/speech-token", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ roomId: "test-room", ...data }),
    })));
    return { status: response.status, ...await response.json() };
  };
  return { database, calls, send, caption, read, speechToken, hostToken, guestToken, tick: (ms) => { now += ms; },
    holdNextRoomRead: () => {
      const started = Promise.withResolvers(), released = Promise.withResolvers();
      roomReadHold = { started, released };
      return { started: started.promise, release: released.resolve };
    },
  };
}

test("700 ms partial cadence keeps final translation immediate and never attaches an old translation to new text", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.caption("第一段", 1)).room.captions[0].translation, "第一段 translated");
    f.tick(600);
    const waiting = await f.caption("第一段加字", 2);
    assert.equal(f.calls.length, 1);
    assert.equal(waiting.room.captions[0].translation, "");
    assert.equal(waiting.room.captions[0].translationState, "pending");
    f.tick(101);
    assert.equal((await f.caption("第三个版本", 3)).room.captions[0].translation, "第三个版本 translated");
    assert.equal(f.calls.length, 2, "a partial at 701 ms is translated rather than waiting 1500 ms");
    const final = await f.caption("最终句子", 4, true);
    assert.equal(f.calls.length, 3, "final bypasses the partial throttle");
    assert.equal(final.room.captions[0].translation, "最终句子 translated");
    const late = await f.caption("不能覆盖最终句子", 5);
    assert.equal(late.room.captions[0].text, "最终句子");
    assert.equal(f.calls.length, 3);
  } finally { f.database.close(); }
});

test("late translator responses cannot overwrite a newer revision or a replacement guest's conversation", async () => {
  const older = Promise.withResolvers(), olderStarted = Promise.withResolvers();
  const previousConversation = Promise.withResolvers(), previousStarted = Promise.withResolvers();
  const f = await fixture(async text => {
    if (text === "旧版本") { olderStarted.resolve(); return older.promise; }
    if (text === "上一轮") { previousStarted.resolve(); return previousConversation.promise; }
    return text + " translated";
  });
  try {
    const oldRequest = f.caption("旧版本", 1);
    await olderStarted.promise;
    f.tick(701);
    const newer = await f.caption("新版本", 2);
    assert.equal(newer.room.captions[0].translation, "新版本 translated");
    older.resolve("过期译文");
    const afterOld = await oldRequest;
    assert.equal(afterOld.room.captions[0].text, "新版本");
    assert.equal(afterOld.room.captions[0].translation, "新版本 translated");

    f.tick(701);
    const previousRequest = f.caption("上一轮", 1, false, 3, "sentence-2");
    await previousStarted.promise;
    assert.equal((await f.send("leave", {}, f.guestToken)).left, true);
    assert.equal((await f.read(f.guestToken)).status, 403);
    const joined = await f.send("join", { code: "1234ABCD", language: "ja" });
    assert.equal(joined.room.state, "ready");
    assert.equal(joined.room.guestStatus, "approved");
    assert.equal(joined.room.captions.length, 0);
    const started = await f.send("start");
    const newGeneration = started.room.generation;
    await f.caption("新一轮", 1, true, newGeneration, "sentence-2");
    previousConversation.resolve("上一轮迟到译文");
    const afterPrevious = await previousRequest;
    assert.equal(afterPrevious.room.captions[0].text, "新一轮");
    assert.equal(afterPrevious.room.captions[0].translation, "新一轮 translated");
    assert.equal((await f.caption("上一轮迟到字幕", 2, true, 3)).code, "INVALID_CAPTION");
  } finally { f.database.close(); }
});

test("legacy pending guests upgrade on authenticated read; direct joins retain capacity and role checks", async () => {
  const f = await fixture();
  try {
    f.database.prepare("UPDATE rooms SET state='waiting',guest_status='pending' WHERE id='test-room'").run();
    const upgraded = await f.read(f.guestToken);
    assert.equal(upgraded.room.guestStatus, "approved");
    assert.equal(upgraded.room.state, "ready");
    assert.equal(upgraded.room.generation, 4);
    assert.equal((await f.send("start", {}, f.guestToken)).code, "HOST_ONLY");
    assert.equal((await f.send("leave")).code, "GUEST_ONLY");
    assert.equal((await f.send("leave", {}, f.guestToken)).left, true);
    const raced = await Promise.all([0, 1].map(() => f.send("join", { code: "1234ABCD", language: "ja" })));
    assert.equal(raced.filter(result => result.status === 200).length, 1);
    assert.equal(raced.filter(result => result.code === "ROOM_FULL").length, 1);
    const guest = raced.find(result => result.status === 200).session;
    assert.equal((await f.send("approve", {}, guest.token)).code, "HOST_ONLY");
    assert.equal((await f.read(f.guestToken)).status, 403);
    assert.equal((await f.read(guest.token)).room.state, "ready");
    assert.equal((await f.send("end", {}, guest.token)).room.state, "ended");
    assert.equal((await f.send("join", { code: "1234ABCD", language: "ja" })).status, 404);
  } finally { f.database.close(); }
});

test("a revoked guest's in-flight poll, pause, and end cannot read or change the replacement conversation", async () => {
  for (const operation of ["read", "pause", "end"]) {
    const f = await fixture();
    try {
      const hold = f.holdNextRoomRead();
      const oldRequest = operation === "read" ? f.read(f.guestToken) : f.send(operation, {}, f.guestToken);
      await hold.started;
      assert.equal((await f.send("leave", {}, f.guestToken)).left, true);
      const joined = await f.send("join", { code: "1234ABCD", language: "ja" });
      const started = await f.send("start");
      await f.caption("新参与者的对话", 1, true, started.room.generation);
      hold.release();
      const revoked = await oldRequest;
      assert.equal(revoked.status, 403, operation);
      assert.equal(revoked.code, "UNAUTHORIZED", operation);
      assert.equal(revoked.room, undefined, "a revoked request never receives the new snapshot");
      const current = await f.read(joined.session.token);
      assert.equal(current.room.state, "running", operation);
      assert.equal(current.room.captions[0].text, "新参与者的对话", operation);
    } finally { f.database.close(); }
  }
});

test("all six room pairs translate in both directions and reject languages outside the chosen pair", async () => {
  const codes = { zh: "zh-Hans", ja: "ja", ko: "ko", en: "en" };
  for (const pair of [["zh", "ja"], ["zh", "ko"], ["ja", "ko"], ["en", "zh"], ["en", "ja"], ["en", "ko"]]) {
    const directions = [];
    const f = await fixture(async (text, url) => { directions.push([url.searchParams.get("from"), url.searchParams.get("to")]); return text + " translated"; }, pair);
    try {
      for (const [index, sourceLanguage] of pair.entries()) {
        const result = await f.send("caption", { id: "pair-" + index, revision: 1, generation: 3, sourceLanguage, text: "테스트", isFinal: true });
        assert.equal(result.status, 200);
        assert.equal(result.room.captions[index].translationState, "done");
      }
      assert.deepEqual(directions, [[codes[pair[0]], codes[pair[1]]], [codes[pair[1]], codes[pair[0]]]]);
      const rejected = await f.send("caption", { id: "outside", revision: 1, generation: 3, sourceLanguage: Object.keys(codes).find(code => !pair.includes(code)), text: "test", isFinal: true });
      assert.equal(rejected.code, "INVALID_LANGUAGE");
      assert.ok(rejected.errorKo);
      assert.ok(rejected.errorEn);
      assert.equal(f.calls.length, 2);
    } finally { f.database.close(); }
  }
});

test("corrections validate ownership, final status, text and revisions, and preserve shared identity", async () => {
  const f = await fixture(undefined, ["zh", "ko"]);
  try {
    await f.caption("星期四见", 1);
    assert.equal((await f.send("edit-caption", { id: "sentence-1", revision: 1, text: "星期五见" })).code, "INVALID_CAPTION");
    await f.caption("星期四见", 2, true);
    assert.equal((await f.send("edit-caption", { id: "sentence-1", revision: 2, text: "星期五见" }, f.guestToken)).code, "CAPTION_OWNER_ONLY");
    for (const text of ["", "   ", "x".repeat(1001), null]) {
      assert.equal((await f.send("edit-caption", { id: "sentence-1", revision: 2, text })).code, "INVALID_CAPTION");
    }
    assert.equal((await f.send("edit-caption", { id: "sentence-1", revision: 1, text: "星期五见" })).code, "STALE_UPDATE");
    const count = f.calls.length;
    const same = await f.send("edit-caption", { id: "sentence-1", revision: 2, text: "  星期四见  " });
    assert.equal(same.room.captions[0].revision, 2);
    assert.equal(f.calls.length, count, "unchanged text does not invoke translation");
    const corrected = await f.send("edit-caption", { id: "sentence-1", revision: 2, text: "星期五见" });
    assert.equal(corrected.room.captions.length, 1);
    assert.equal(corrected.room.captions[0].id, "sentence-1");
    assert.equal(corrected.room.captions[0].revision, 3);
    assert.equal(corrected.room.captions[0].edited, true);
    assert.equal(corrected.room.captions[0].translation, "星期五见 translated");
    assert.deepEqual((await f.read(f.guestToken)).room.captions, corrected.room.captions);
    await f.caption("迟到的语音结果", 9, true);
    assert.equal((await f.read()).room.captions[0].text, "星期五见");
    await f.send("caption", { id: "korean", revision: 1, generation: 3, sourceLanguage: "ko", text: "세 시에 만나요", isFinal: true });
    await f.send("pause");
    const korean = await f.send("edit-caption", { id: "korean", revision: 1, text: "네 시에 만나요" }, f.guestToken);
    assert.equal(korean.room.captions.find(c => c.id === "korean").translation, "네 시에 만나요 translated");
    assert.equal(korean.room.state, "paused");
    await f.send("end");
    assert.equal((await f.send("edit-caption", { id: "sentence-1", revision: 3, text: "结束后" })).code, "ROOM_ENDED");
    assert.equal((await f.read()).room.captions.length, 0);
  } finally { f.database.close(); }
});

test("a pending correction clears the old translation and older responses cannot overwrite subsequent edits", async () => {
  const held = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await fixture(async text => {
    if (text === "第一次修正") { started.resolve(); return held.promise; }
    return text + " translated";
  });
  try {
    await f.caption("原文", 1, true);
    const editing = f.send("edit-caption", { id: "sentence-1", revision: 1, text: "第一次修正" });
    await started.promise;
    const pending = (await f.read(f.guestToken)).room.captions[0];
    assert.equal(pending.text, "第一次修正");
    assert.equal(pending.translation, "");
    assert.equal(pending.translationState, "pending");
    assert.equal(pending.revision, 2);
    assert.equal((await f.send("edit-caption", { id: "sentence-1", revision: 1, text: "过期编辑" })).code, "STALE_UPDATE");
    await f.send("edit-caption", { id: "sentence-1", revision: 2, text: "第二次修正" });
    held.resolve("旧译文");
    const finished = await editing;
    assert.equal(finished.room.captions[0].text, "第二次修正");
    assert.equal(finished.room.captions[0].translation, "第二次修正 translated");
    assert.equal(finished.room.captions[0].revision, 3);
  } finally { f.database.close(); }
});

test("failed corrections keep the new original and support an authorized retry", async () => {
  let fail = true;
  const f = await fixture(async text => { if (text === "修正文本" && fail) throw new Error("provider failure"); return text + " translated"; });
  try {
    await f.caption("原文", 1, true);
    assert.equal((await f.send("retry-translation", { id: "sentence-1", revision: 1 })).code, "INVALID_STATE");
    const failed = await f.send("edit-caption", { id: "sentence-1", revision: 1, text: "修正文本" });
    const caption = failed.room.captions[0];
    assert.equal(caption.text, "修正文本");
    assert.equal(caption.translation, "");
    assert.equal(caption.translationState, "error");
    assert.equal((await f.send("retry-translation", { id: "sentence-1", revision: 2 }, f.guestToken)).code, "CAPTION_OWNER_ONLY");
    fail = false;
    const retried = await f.send("retry-translation", { id: "sentence-1", revision: 2 });
    assert.equal(retried.room.captions[0].translationState, "done");
    assert.equal(retried.room.captions[0].translation, "修正文本 translated");
    assert.equal(retried.room.captions[0].edited, true);
    assert.equal(retried.room.captions[0].revision, 3);
  } finally { f.database.close(); }
});

test("correction responses remain safe across pause/resume, leave/rejoin and stale participant requests", async () => {
  for (const transition of ["pause-resume", "replace-guest"]) {
    const held = Promise.withResolvers(), started = Promise.withResolvers();
    const f = await fixture(async text => { if (text === "修正中") { started.resolve(); return held.promise; } return text + " translated"; });
    try {
      await f.caption("原文", 1, true);
      const editing = f.send("edit-caption", { id: "sentence-1", revision: 1, text: "修正中" });
      await started.promise;
      if (transition === "pause-resume") {
        await f.send("pause"); await f.send("start");
      } else {
        await f.send("leave", {}, f.guestToken);
        await f.send("join", { code: "1234ABCD", language: "ja" });
        const room = (await f.send("start")).room;
        await f.caption("新会话", 2, true, room.generation);
      }
      held.resolve("修正译文");
      const result = await editing;
      assert.equal(result.room.captions[0].text, transition === "pause-resume" ? "修正中" : "新会话");
      assert.equal(result.room.captions[0].translation, transition === "pause-resume" ? "修正译文" : "新会话 translated");
    } finally { f.database.close(); }
  }
  const f = await fixture();
  try {
    await f.send("caption", { id: "guest-line", revision: 1, generation: 3, sourceLanguage: "ja", text: "古い発言", isFinal: true });
    const hold = f.holdNextRoomRead();
    const oldRequest = f.send("edit-caption", { id: "guest-line", revision: 1, text: "遅い修正" }, f.guestToken);
    await hold.started;
    await f.send("leave", {}, f.guestToken);
    const joined = await f.send("join", { code: "1234ABCD", language: "ja" });
    const room = (await f.send("start")).room;
    await f.send("caption", { id: "guest-line", revision: 1, generation: room.generation, sourceLanguage: "ja", text: "新しい発言", isFinal: true });
    hold.release();
    assert.equal((await oldRequest).code, "STALE_UPDATE");
    assert.equal((await f.read(joined.session.token)).room.captions[0].text, "新しい発言");
  } finally { f.database.close(); }
});

test("Korean demo pairs support corrections without calling a real translation service", async () => {
  const f = await fixture(undefined, ["ja", "ko"]);
  try {
    f.database.prepare("UPDATE rooms SET mode='demo' WHERE id='test-room'").run();
    await f.send("demo-next", { expectedDemoIndex: 0 });
    const final = await f.send("demo-next", { expectedDemoIndex: 1 });
    assert.equal(final.room.captions[0].sourceLanguage, "ko");
    assert.match(final.room.captions[0].text, /안녕하세요/);
    assert.match(final.room.captions[0].translation, /こんにちは/);
    const corrected = await f.send("edit-caption", { id: "demo-0", revision: 2, text: "다시 만나서 반갑습니다." }, f.guestToken);
    assert.equal(corrected.room.captions[0].edited, true);
    assert.match(corrected.room.captions[0].translation, /デモ/);
    assert.deepEqual(corrected.timing, { translationMs: null, translationReused: false });
    assert.equal(f.calls.length, 0);
  } finally { f.database.close(); }
});

test("unchanged partial and final text reuse only the same sentence's successful translation in all three languages", async () => {
  for (const [sourceLanguage, targetLanguage, text] of [["zh", "ja", "星期五见"], ["ja", "ko", "金曜日に会いましょう"], ["ko", "zh", "금요일에 만나요"]]) {
    const f = await fixture(undefined, [sourceLanguage, targetLanguage]);
    const send = (revision, isFinal, id = "same-text") => f.send("caption", { id, revision, isFinal, sourceLanguage, text, generation: 3 });
    try {
      const initial = await send(1, false);
      assert.equal(initial.timing.translationReused, false);
      for (const [revision, isFinal] of [[2, false], [3, true]]) {
        const next = await send(revision, isFinal);
        assert.deepEqual(next.timing, { translationMs: null, translationReused: true });
        assert.equal(next.room.captions[0].revision, revision);
        assert.equal(next.room.captions[0].isFinal, isFinal);
        assert.equal(next.room.captions[0].translation, text + " translated");
        assert.equal(f.calls.length, 1, "identical final does not make another provider request");
      }
      await send(1, true, "different-sentence");
      assert.equal(f.calls.length, 2, "do not reuse translations across sentence identities");
      const stale = await send(2, false);
      assert.equal(stale.timing, undefined);
      assert.equal(f.calls.length, 2);
      await f.send("edit-caption", { id: "same-text", revision: 3, text: text + "!" });
      const afterEdit = await send(99, true);
      assert.equal(afterEdit.room.captions.find(c => c.id === "same-text").text, text + "!");
      assert.equal(afterEdit.timing, undefined);
    } finally { f.database.close(); }
  }
});

test("changed text, changed source, failed or pending translations never count as reused", async () => {
  let fail = false;
  const f = await fixture(async text => { if (fail) throw new Error("PRIVATE_PROVIDER_ERROR"); return text + " translated"; });
  try {
    await f.caption("原文", 1);
    const pending = await f.caption("新原文", 2);
    assert.equal(pending.room.captions[0].translationState, "pending");
    const reverted = await f.caption("原文", 3, true);
    assert.equal(reverted.timing.translationReused, false);
    assert.equal(f.calls.length, 2, "a previously seen but superseded text has no cache entry");

    await f.caption("123", 1, true, 3, "source-change-final");
    f.tick(701);
    await f.caption("123", 1, false, 3, "source-change");
    const changedSource = await f.send("caption", { id: "source-change", revision: 2, generation: 3, sourceLanguage: "ja", text: "123", isFinal: true });
    assert.equal(changedSource.timing.translationReused, false);
    assert.equal(changedSource.room.captions.find(c => c.id === "source-change").sourceLanguage, "ja");

    fail = true; f.tick(701);
    const failed = await f.caption("失败文本", 1, false, 3, "failure");
    assert.equal(failed.room.captions.find(c => c.id === "failure").translationState, "error");
    const before = f.calls.length; fail = false;
    const retriedFinal = await f.caption("失败文本", 2, true, 3, "failure");
    assert.equal(retriedFinal.timing.translationReused, false);
    assert.equal(f.calls.length, before + 1);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_ERROR|fake-translator-key/);
  } finally { f.database.close(); }
});

test("timings measure only attempted provider requests and never mislabel no-ops as zero latency", async () => {
  let fail = false;
  const f = await fixture(async text => { f.tick(37); if (fail) throw new Error("provider unavailable"); return text + " translated"; });
  try {
    const initial = await f.caption("原文", 1, true);
    assert.deepEqual(initial.timing, { translationMs: 37, translationReused: false });
    const unchanged = await f.send("edit-caption", { id: "sentence-1", revision: 1, text: "原文" });
    assert.equal(unchanged.timing, undefined);
    fail = true;
    const edited = await f.send("edit-caption", { id: "sentence-1", revision: 1, text: "修正原文" });
    assert.deepEqual(edited.timing, { translationMs: 37, translationReused: false });
    assert.equal(edited.room.captions[0].translationState, "error");
    fail = false;
    const retried = await f.send("retry-translation", { id: "sentence-1", revision: 2 });
    assert.deepEqual(retried.timing, { translationMs: 37, translationReused: false });
    assert.equal(retried.room.captions[0].translationState, "done");
  } finally { f.database.close(); }
});

async function soloFixture(translate, pair = ["zh", "ko"]) {
  const f = await fixture(translate, pair);
  f.database.prepare("UPDATE rooms SET device_mode='solo',guest_token_hash=NULL,guest_status='none',guest_seen_at=NULL WHERE id='test-room'").run();
  return f;
}

test("solo rooms start without a guest, cannot be joined, recover on refresh, and retain expiry and cleanup", async () => {
  const f = await fixture();
  try {
    for (const invalid of [{ deviceMode: "invalid" }, { deviceMode: "solo", otherLanguage: "fr" }]) {
      assert.equal((await f.send("create", { mode: "live", language: "zh", ...invalid })).status, 400);
    }
    const created = await f.send("create", { mode: "live", deviceMode: "solo", language: "zh", otherLanguage: "ko" });
    assert.equal(created.status, 201);
    const { roomId, token, code } = created.session;
    const send = (action, data = {}) => f.send(action, { roomId, ...data }, token);
    assert.equal(created.room.deviceMode, "solo");
    assert.equal(created.room.state, "ready");
    assert.equal(created.room.guestLanguage, "ko");
    assert.equal(created.room.guestStatus, "none");
    assert.equal(created.room.guestOnline, false);
    assert.equal(f.database.prepare("SELECT guest_token_hash FROM rooms WHERE id=?").get(roomId).guest_token_hash, null);
    assert.equal((await f.send("join", { code, language: "ja" })).code, "SOLO_PRIVATE");
    assert.equal((await f.read(f.guestToken, roomId)).code, "UNAUTHORIZED");
    const started = await send("start");
    assert.equal(started.room.state, "running");
    for (let i = 0; i < 3; i++) {
      f.tick(15_000);
      assert.equal((await f.read(token, roomId)).room.state, "running", "host polling alone keeps solo running");
    }
    f.tick(21_000);
    const restored = await f.read(token, roomId);
    assert.equal(restored.room.state, "paused");
    assert.equal(restored.room.generation, started.room.generation + 1);
    const resumed = await send("start");
    assert.equal(resumed.room.state, "running");
    const result = await send("caption", { id: "solo", revision: 1, generation: resumed.room.generation, sourceLanguage: "ko", speakerId: "Guest-2", speakerSide: "b", text: "안녕하세요", isFinal: true });
    assert.equal(result.room.captions[0].translationState, "done");
    assert.equal((await send("end")).room.captions.length, 0);
    assert.equal((await send("start")).code, "ROOM_ENDED");
    f.tick(30 * 60_000);
    assert.equal((await f.read(token, roomId)).code, "ROOM_EXPIRED");
    assert.equal(f.database.prepare("SELECT id FROM rooms WHERE id=?").get(roomId), undefined);
  } finally { f.database.close(); }
});

test("solo unknown voices wait for assignment; final source and speaker corrections use the opposite listener's language", async () => {
  const directions = [];
  const f = await soloFixture(async (text, url) => { directions.push([url.searchParams.get("from"), url.searchParams.get("to")]); return text + " translated"; });
  const send = (data) => f.send("caption", { id: "solo", revision: 1, generation: 3, sourceLanguage: "zh", text: "你好", isFinal: true, ...data });
  try {
    for (const invalid of [{ speakerSide: "c" }, { speakerId: "x".repeat(101) }, { speakerId: "<script>" }, { speakerId: 1 }]) {
      assert.equal((await send(invalid)).code, "INVALID_CAPTION");
    }
    const unknown = await send({ speakerId: null, speakerSide: null });
    assert.equal(unknown.room.captions[0].speakerSide, null);
    assert.equal(unknown.room.captions[0].targetLanguage, null);
    assert.equal(unknown.room.captions[0].translationState, "pending");
    assert.equal(f.calls.length, 0);
    await f.send("pause");
    assert.equal((await f.read()).room.captions[0].translationState, "pending", "unknown speaker is not a translation failure");
    const assigned = await f.send("edit-caption", { id: "solo", revision: 1, text: "你好", speakerSide: "a" });
    assert.equal(assigned.room.captions[0].speakerSide, "a");
    assert.equal(assigned.room.captions[0].targetLanguage, "ko");
    assert.equal(assigned.room.captions[0].revision, 2);
    assert.equal(assigned.room.captions[0].translation, "你好 translated");
    assert.deepEqual(directions, [["zh-Hans", "ko"]]);
    const switched = await f.send("edit-caption", { id: "solo", revision: 2, text: "你好", speakerSide: "b" });
    assert.equal(switched.room.captions[0].targetLanguage, "zh");
    assert.equal(switched.room.captions[0].translation, "你好");
    assert.equal(f.calls.length, 1, "same-language text is displayed without provider translation");
    assert.equal((await f.send("edit-caption", { id: "solo", revision: 3, text: "你好", speakerSide: null })).code, "INVALID_CAPTION");
    assert.equal((await f.send("edit-caption", { id: "solo", revision: 2, text: "你好", speakerSide: "a" })).code, "STALE_UPDATE");
    const resumed = await f.send("start");
    const korean = await send({ id: "korean", generation: resumed.room.generation, sourceLanguage: "ko", speakerId: "Guest-2", speakerSide: "b", text: "안녕" });
    assert.equal(korean.room.captions.find(c => c.id === "korean").targetLanguage, "zh");
    const corrected = await f.send("edit-caption", { id: "korean", revision: 1, text: "안녕하세요" });
    assert.equal(corrected.room.captions.find(c => c.id === "korean").translation, "안녕하세요 translated", "solo operator can correct both voices");
  } finally { f.database.close(); }
});

test("solo same-language speakers remain distinct and demo assigns both sides without provider calls", async () => {
  const f = await soloFixture(undefined, ["zh", "zh"]);
  try {
    for (const side of ["a", "b"]) {
      const result = await f.send("caption", { id: side, revision: 1, generation: 3, sourceLanguage: "zh", speakerSide: side, speakerId: "Guest-" + side, text: "你好", isFinal: true });
      const caption = result.room.captions.find(c => c.id === side);
      assert.equal(caption.speakerSide, side);
      assert.equal(caption.speakerId, "Guest-" + side);
      assert.equal(caption.targetLanguage, "zh");
      assert.equal(caption.translation, "你好");
    }
    assert.equal(f.calls.length, 0);
    const created = await f.send("create", { deviceMode: "solo", mode: "demo", language: "ko", otherLanguage: "ko" });
    assert.equal(created.status, 201);
    const send = (action, data = {}) => f.send(action, { roomId: created.session.roomId, ...data }, created.session.token);
    await send("start");
    for (let i = 0; i < 4; i++) await send("demo-next", { expectedDemoIndex: i });
    const captions = (await f.read(created.session.token, created.session.roomId)).room.captions;
    assert.deepEqual(captions.map(c => c.speakerSide), ["b", "a"]);
    assert.ok(captions.every(c => c.targetLanguage === "ko" && c.text === c.translation));
    assert.equal(f.calls.length, 0);
  } finally { f.database.close(); }
});

test("solo speaker reassignment never reuses a different target or accepts its delayed translation", async () => {
  const held = Promise.withResolvers(), started = Promise.withResolvers();
  let hold = false;
  const f = await soloFixture(async text => { if (hold) { hold = false; started.resolve(); return held.promise; } return text + " translated"; });
  const send = (revision, speakerSide, isFinal = false) => f.send("caption", { id: "solo", revision, speakerSide, speakerId: "Guest-1", generation: 3, sourceLanguage: "zh", text: "你好", isFinal });
  try {
    await send(1, "a");
    const reused = await send(2, "a");
    assert.equal(reused.timing.translationReused, true);
    f.tick(701);
    const moved = await send(3, "b", true);
    assert.equal(moved.timing.translationReused, false);
    assert.equal(moved.room.captions[0].targetLanguage, "zh");
    assert.equal(moved.room.captions[0].translation, "你好");
    hold = true;
    const correcting = f.send("edit-caption", { id: "solo", revision: 3, text: "你好", speakerSide: "a" });
    await started.promise;
    const pending = (await f.read()).room.captions[0];
    assert.equal(pending.revision, 4);
    assert.equal(pending.translation, "");
    assert.equal(pending.targetLanguage, "ko");
    await f.send("edit-caption", { id: "solo", revision: 4, text: "你好", speakerSide: "b" });
    held.resolve("过期韩语译文");
    const final = (await correcting).room.captions[0];
    assert.equal(final.speakerSide, "b");
    assert.equal(final.targetLanguage, "zh");
    assert.equal(final.translation, "你好");
    assert.equal(final.revision, 5);
  } finally { f.database.close(); }
});

test("English meeting captions switch direction in the same solo room and keep correction permissions", async () => {
  const directions = [];
  const f = await soloFixture(async (text, url) => { directions.push([url.searchParams.get("from"), url.searchParams.get("to")]); return text + " translated"; }, ["en", "zh"]);
  try {
    for (const [id, sourceLanguage, speakerSide, text] of [["lecture", "en", "a", "Please open your books."], ["question", "zh", "b", "请再解释一遍。"]]) {
      const result = await f.send("caption", { id, revision: 1, generation: 3, sourceLanguage, speakerSide, speakerId: null, text, isFinal: true });
      assert.equal(result.status, 200);
      const caption = result.room.captions.find(c => c.id === id);
      assert.equal(caption.translation, text + " translated");
      assert.equal(caption.targetLanguage, sourceLanguage === "en" ? "zh" : "en");
    }
    const corrected = await f.send("edit-caption", { id: "lecture", revision: 1, text: "Please close your books." });
    assert.equal(corrected.room.captions.find(c => c.id === "lecture").translation, "Please close your books. translated");
    assert.deepEqual(directions, [["en", "zh-Hans"], ["zh-Hans", "en"], ["en", "zh-Hans"]]);
    const invalid = await f.send("create", { language: "fr", mode: "demo" });
    assert.equal(invalid.code, "INVALID_LANGUAGE");
    assert.equal(invalid.errorEn, "Choose Chinese, Japanese, Korean, or English.");
  } finally { f.database.close(); }
});

test("English demo captions and corrections contain text in both directions without Azure requests", async () => {
  const f = await soloFixture(undefined, ["en", "zh"]);
  try {
    f.database.prepare("UPDATE rooms SET mode='demo' WHERE id='test-room'").run();
    for (let i = 0; i < 4; i++) await f.send("demo-next", { expectedDemoIndex: i });
    const captions = (await f.read()).room.captions;
    assert.match(captions[0].translation, /Hello/);
    assert.match(captions[1].text, /great to meet/);
    assert.ok(captions.every(c => c.text && c.translation));
    const edited = await f.send("edit-caption", { id: captions[0].id, revision: 2, text: "你好，谢谢你今天过来学习。" });
    assert.match(edited.room.captions[0].translation, /\[Demo\]/);
    assert.equal(f.calls.length, 0);
  } finally { f.database.close(); }
});

test("speech authorization is withheld if the room ends or reconnects while Azure is issuing a token", async () => {
  for (const transition of ["end", "pause-resume", "unchanged"]) {
    const held = Promise.withResolvers(), started = Promise.withResolvers();
    const f = await fixture(undefined, ["en", "zh"], async () => { started.resolve(); return held.promise; });
    try {
      const issuing = f.speechToken();
      await started.promise;
      if (transition === "end") await f.send("end");
      if (transition === "pause-resume") { await f.send("pause"); await f.send("start"); }
      held.resolve("test-only-token");
      const result = await issuing;
      if (transition === "unchanged") {
        assert.equal(result.status, 200);
        assert.equal(result.token, "test-only-token");
      } else {
        assert.equal(result.status, 409);
        assert.equal(result.code, "INVALID_STATE");
        assert.equal(result.token, undefined);
        assert.doesNotMatch(JSON.stringify(result), /test-only-token/);
      }
    } finally { f.database.close(); }
  }
});

async function remoteFixture(translate, pair = ["zh", "en"], issueToken) {
  const f = await fixture(translate, pair, issueToken);
  f.database.prepare("UPDATE rooms SET device_mode='remote',state='ready' WHERE id='test-room'").run();
  const token = role => role === "host" ? f.hostToken : f.guestToken;
  const data = (role, extra = {}) => {
    const room = f.database.prepare("SELECT * FROM rooms WHERE id='test-room'").get();
    return { generation: room.generation, captureGeneration: room[`${role}_capture_generation`], ...extra };
  };
  const send = (role, action, extra = {}) => f.send(action, data(role, extra), token(role));
  const caption = (role, text, revision = 1, isFinal = false, suffix = "sentence", extra = {}) => {
    const fields = data(role);
    return send(role, "caption", { id: `${role === "host" ? "h" : "g"}-${fields.captureGeneration}-${suffix}`,
      sourceLanguage: pair[role === "host" ? 0 : 1], text, revision, isFinal, ...extra });
  };
  return { ...f, remote: { data, send, caption, token } };
}

test("remote live rooms join without approval and each participant starts independently", async () => {
  const f = await remoteFixture();
  try {
    assert.equal((await f.send("create", { deviceMode: "remote", language: "zh", mode: "demo" })).code, "INVALID_MODE");
    const created = await f.send("create", { deviceMode: "remote", language: "zh", mode: "live" });
    assert.equal(created.room.deviceMode, "remote");
    assert.equal(created.room.state, "waiting");
    const initial = { roomId: created.session.roomId, generation: created.room.generation, captureGeneration: 0 };
    assert.equal((await f.send("start", initial, created.session.token)).code, "NOT_READY");
    const joined = await f.send("join", { code: created.session.code, language: "en" });
    assert.equal(joined.room.state, "ready");
    assert.equal(joined.room.guestStatus, "approved");
    const generation = joined.room.generation;
    const started = await Promise.all([
      f.send("start", { roomId: initial.roomId, generation, captureGeneration: joined.room.hostCaptureGeneration }, created.session.token),
      f.send("start", { roomId: initial.roomId, generation, captureGeneration: joined.room.guestCaptureGeneration }, joined.session.token),
    ]);
    assert.ok(started.every(result => result.status === 200));
    const current = (await f.read(created.session.token, initial.roomId)).room;
    assert.equal(current.hostListening, true);
    assert.equal(current.guestListening, true);
    assert.equal(current.hostCaptureGeneration, joined.room.hostCaptureGeneration + 1);
    assert.equal(current.guestCaptureGeneration, joined.room.guestCaptureGeneration + 1);
    assert.equal(current.generation, generation, "starting either microphone does not invalidate its partner");
    assert.equal((await f.send("start", { roomId: initial.roomId, generation, captureGeneration: joined.room.hostCaptureGeneration }, created.session.token)).code, "STALE_UPDATE");
  } finally { f.database.close(); }
});

test("remote captions authenticate the actor's language, identity and generation; both sides translate concurrently", async () => {
  const f = await remoteFixture();
  try {
    await Promise.all([f.remote.send("host", "start"), f.remote.send("guest", "start")]);
    const both = await Promise.all([f.remote.caption("host", "你好"), f.remote.caption("guest", "Hello")]);
    assert.ok(both.every(result => result.status === 200));
    assert.equal(f.calls.length, 2, "one speaker's 700 ms window does not suppress the other");
    const rows = (await f.read()).room.captions;
    assert.deepEqual(new Set(rows.map(row => row.speakerSide)), new Set(["a", "b"]));
    assert.deepEqual(new Set(rows.map(row => row.speakerId)), new Set(["host", "guest"]));
    assert.ok(rows.every(row => row.translationState === "done"));
    const hostId = rows.find(row => row.speakerSide === "a").id;
    for (const extra of [{ sourceLanguage: "zh" }, { speakerSide: "a" }, { speakerId: "host" }, { id: hostId }, { id: "g-0-old" }]) {
      assert.equal((await f.remote.caption("guest", "Spoof", 2, true, "spoof", extra)).code, "INVALID_CAPTION");
    }
    assert.equal((await f.remote.send("guest", "discard-caption", { id: hostId })).code, "INVALID_CAPTION");
    await f.remote.caption("host", "你好", 2, true);
    await f.remote.caption("guest", "Hello", 2, true);
    assert.equal((await f.remote.send("guest", "edit-caption", { id: hostId, revision: 2, text: "篡改" })).code, "CAPTION_OWNER_ONLY");
    const own = await f.remote.send("host", "edit-caption", { id: hostId, revision: 2, text: "您好" });
    assert.equal(own.room.captions.find(c => c.id === hostId).translation, "您好 translated");
    assert.equal((await f.remote.send("host", "edit-caption", { id: hostId, revision: 3, text: "您好", speakerSide: "b" })).code, "CAPTION_OWNER_ONLY");
  } finally { f.database.close(); }
});

test("remote pause invalidates only its own captions and late translation while the other side continues", async () => {
  const held = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await remoteFixture(async text => { if (text === "Held final") { started.resolve(); return held.promise; } return text + " translated"; });
  try {
    await Promise.all([f.remote.send("host", "start"), f.remote.send("guest", "start")]);
    await f.remote.caption("host", "临时原文", 1, false, "partial");
    await f.remote.caption("guest", "Partner partial", 1, false, "partial");
    const old = f.remote.data("host"), delayed = f.remote.caption("host", "Held final", 1, true, "held");
    await started.promise;
    const paused = await f.remote.send("host", "pause");
    assert.equal(paused.room.hostListening, false);
    assert.equal(paused.room.guestListening, true);
    assert.equal(paused.room.state, "running");
    assert.equal(paused.room.generation, old.generation);
    assert.equal(paused.room.hostCaptureGeneration, old.captureGeneration + 1);
    assert.ok(!paused.room.captions.some(c => c.id.startsWith("h-") && c.id.endsWith("partial")));
    assert.ok(paused.room.captions.some(c => c.id.startsWith("g-") && c.id.endsWith("partial")));
    held.resolve("Expired translation");
    const after = (await delayed).room.captions.find(c => c.id.endsWith("held"));
    assert.equal(after.translation, "");
    assert.equal(after.translationState, "error");
    assert.equal((await f.remote.caption("guest", "Partner final", 2, true, "partial")).status, 200);
    assert.equal((await f.remote.caption("host", "Late callback", 2, true, "partial", old)).code, "STALE_UPDATE");
    assert.equal((await f.speechToken(f.remote.data("guest"), f.guestToken)).status, 200);
    assert.equal((await f.speechToken(f.remote.data("host"))).code, "INVALID_STATE");
    await f.remote.send("host", "start");
    assert.equal((await f.remote.send("host", "pause", old)).code, "STALE_UPDATE");
    assert.equal((await f.read()).room.hostListening, true);
  } finally { f.database.close(); }
});

test("remote heartbeat loss pauses the absent participant without stopping the online microphone", async () => {
  const f = await remoteFixture();
  try {
    await Promise.all([f.remote.send("host", "start"), f.remote.send("guest", "start")]);
    const oldGuest = f.remote.data("guest");
    f.tick(15_000); await f.read();
    f.tick(6_000);
    const current = (await f.read()).room;
    assert.equal(current.hostListening, true);
    assert.equal(current.guestListening, false);
    assert.equal(current.guestCaptureGeneration, oldGuest.captureGeneration + 1);
    assert.equal(current.generation, oldGuest.generation);
    assert.equal(current.state, "running");
    assert.equal((await f.read(f.guestToken)).room.guestListening, false, "reconnecting a page does not silently reopen its microphone");
    assert.equal((await f.speechToken(oldGuest, f.guestToken)).code, "STALE_UPDATE");
    const restarted = await f.remote.send("guest", "start");
    assert.equal(restarted.room.guestListening, true);
    assert.equal(restarted.room.hostListening, true);
  } finally { f.database.close(); }
});

test("remote authorization rechecks its own capture epoch and applies token throttles per participant", async () => {
  for (const pausedRole of ["host", "guest"]) {
    const held = Promise.withResolvers(), started = Promise.withResolvers();
    const f = await remoteFixture(undefined, ["zh", "en"], async () => { started.resolve(); return held.promise; });
    try {
      await Promise.all([f.remote.send("host", "start"), f.remote.send("guest", "start")]);
      const issuing = f.speechToken(f.remote.data("host"));
      await started.promise;
      await f.remote.send(pausedRole, "pause");
      held.resolve("remote-test-token");
      const result = await issuing;
      assert.equal(result.status, pausedRole === "host" ? 409 : 200);
      assert.equal(result.token, pausedRole === "host" ? undefined : "remote-test-token");
    } finally { f.database.close(); }
  }
  const f = await remoteFixture();
  try {
    await Promise.all([f.remote.send("host", "start"), f.remote.send("guest", "start")]);
    assert.equal((await f.speechToken()).code, "STALE_UPDATE", "remote tokens require both epochs");
    for (let i = 0; i < 5; i++) assert.equal((await f.speechToken(f.remote.data("host"))).status, 200);
    assert.equal((await f.speechToken(f.remote.data("host"))).code, "RATE_LIMIT");
    assert.equal((await f.speechToken(f.remote.data("guest"), f.guestToken)).status, 200);
    assert.ok(f.database.prepare("SELECT key FROM rate_limits WHERE key='room:test-room:host'").get());
    assert.ok(f.database.prepare("SELECT key FROM rate_limits WHERE key='room:test-room:guest'").get());
  } finally { f.database.close(); }
});

test("remote leave and end invalidate both microphones, revoke old guest tokens and clear captions", async () => {
  for (const operation of ["leave", "end"]) {
    const held = Promise.withResolvers(), started = Promise.withResolvers();
    const f = await remoteFixture(async text => { if (text === "Delayed guest") { started.resolve(); return held.promise; } return text + " translated"; });
    try {
      await Promise.all([f.remote.send("host", "start"), f.remote.send("guest", "start")]);
      const oldHost = f.remote.data("host"), oldGuest = f.remote.data("guest");
      const delayed = f.remote.caption("guest", "Delayed guest", 1, true);
      await started.promise;
      await f.remote.send(operation === "leave" ? "guest" : "host", operation);
      const next = (await f.read()).room;
      assert.equal(next.hostListening, false);
      assert.equal(next.guestListening, false);
      assert.ok(next.generation > oldHost.generation);
      assert.ok(next.hostCaptureGeneration > oldHost.captureGeneration);
      assert.ok(next.guestCaptureGeneration > oldGuest.captureGeneration);
      assert.equal(next.captions.length, 0);
      held.resolve("Old partner's translation");
      const late = await delayed;
      if (operation === "leave") {
        assert.equal(late.code, "UNAUTHORIZED");
        assert.equal((await f.read(f.guestToken)).code, "UNAUTHORIZED");
        const joined = await f.send("join", { code: "1234ABCD", language: "en" });
        assert.equal(joined.room.captions.length, 0);
        assert.equal(joined.room.hostListening, false);
        await f.remote.send("host", "start");
        assert.equal((await f.remote.caption("host", "Late host", 1, true, "old", oldHost)).code, "STALE_UPDATE");
      } else {
        assert.equal(late.room.captions.length, 0);
        assert.equal((await f.remote.send("host", "start")).code, "ROOM_ENDED");
      }
    } finally { f.database.close(); }
  }
});

test("two simultaneous remote final captions cannot exceed the shared 400-caption limit", async () => {
  const f = await remoteFixture();
  try {
    await Promise.all([f.remote.send("host", "start"), f.remote.send("guest", "start")]);
    const insert = f.database.prepare(`INSERT INTO captions (room_id,id,revision,source_language,text,translation,is_final,translation_state,created_at,generation,speaker_side)
      VALUES ('test-room',?,1,'zh','seed','seed translated',1,'done',1,3,'a')`);
    for (let i = 0; i < 399; i++) insert.run(`h-1-seed-${i}`);
    const results = await Promise.all([f.remote.caption("host", "Last host", 1, true), f.remote.caption("guest", "Last guest", 1, true)]);
    assert.equal(results.filter(result => result.status === 200).length, 1);
    assert.equal(results.filter(result => result.code === "CAPTION_LIMIT").length, 1);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM captions WHERE room_id='test-room'").get().n, 400);
  } finally { f.database.close(); }
});
