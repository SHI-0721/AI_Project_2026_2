// Run: node --experimental-vm-modules --test tests/translator.test.mjs
// Runs the real API handler and SQL with an in-memory database and a fake Azure response; no credentials/network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../lib/server.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const schema = readFileSync(new URL("../drizzle/0000_confused_black_panther.sql", import.meta.url), "utf8");

test("live captions omit the Global header, retain regional authentication, and save translated text", async () => {
  for (const [region, sourceLanguage, original, translated] of [
    ["global", "zh", "你好", "こんにちは"], ["koreacentral", "ja", "ありがとう", "谢谢"],
  ]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(schema);
      const now = Date.now(), token = "a".repeat(64), tokenHash = createHash("sha256").update(token).digest("hex");
      database.prepare(`INSERT INTO rooms (id,code,host_token_hash,host_language,mode,state,
        guest_status,created_at,expires_at,host_seen_at,guest_seen_at,generation)
        VALUES ('test-room','1234ABCD',?,'zh','live','running','approved',?,?,?,?,3)`)
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
      const context = vm.createContext({ Response, URL, crypto: globalThis.crypto, TextEncoder, TextDecoder,
        AbortSignal, fetch: async (url, init) => {
          calls.push({ url, init });
          return Response.json([{ translations: [{ text: translated }] }]);
        } });
      const server = new vm.SourceTextModule(compiled, { context });
      await server.link(name => {
        assert.equal(name, "cloudflare:workers");
        return new vm.SyntheticModule(["env"], function () { this.setExport("env", env); }, { context });
      });
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

async function fixture(translate = async (text) => text + " translated") {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  let now = Date.now();
  let roomReadHold;
  const hostToken = "a".repeat(64), guestToken = "b".repeat(64);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  database.prepare(`INSERT INTO rooms (id,code,host_token_hash,guest_token_hash,host_language,guest_language,
    mode,state,guest_status,created_at,expires_at,host_seen_at,guest_seen_at,generation)
    VALUES ('test-room','1234ABCD',?,?,'zh','ja','live','running','approved',?,?,?,?,3)`)
    .run(digest(hostToken), digest(guestToken), now, now + 60000, now, now);
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
  const context = vm.createContext({ Response, URL, crypto: globalThis.crypto, TextEncoder, TextDecoder,
    Date: class extends Date { static now() { return now; } }, AbortSignal,
    fetch: async (url, init) => {
      const text = JSON.parse(init.body)[0].Text;
      calls.push(text);
      return Response.json([{ translations: [{ text: await translate(text) }] }]);
    } });
  const server = new vm.SourceTextModule(compiled, { context });
  await server.link(name => {
    assert.equal(name, "cloudflare:workers");
    return new vm.SyntheticModule(["env"], function () { this.setExport("env", env); }, { context });
  });
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
  return { database, calls, send, caption, read, hostToken, guestToken, tick: (ms) => { now += ms; },
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
