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
