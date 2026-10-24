// Run against an isolated local preview: node tests/api.mjs http://127.0.0.1:5173
import assert from "node:assert/strict";

const origin = process.argv[2] || "http://127.0.0.1:5173";
const sessions = [];
async function api(action, data = {}, session) {
  const result = await fetch(origin + "/api/room", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: "Bearer " + session.token } : {}) },
    body: JSON.stringify({ action, ...data, ...(session ? { roomId: session.roomId } : {}) }),
  });
  return { status: result.status, ...await result.json() };
}
async function poll(session, roomId = session.roomId) {
  const result = await fetch(origin + "/api/room?roomId=" + encodeURIComponent(roomId), {
    headers: { Authorization: "Bearer " + session.token },
  });
  return { status: result.status, ...await result.json() };
}

try {
  const config = await (await fetch(origin + "/api/config")).json();
  assert.equal(config.demoAvailable, true);
  assert.equal(typeof config.speechReady, "boolean");
  assert.equal((await api("create", { padding: "x".repeat(9000) })).status, 413);
  if (!config.speechReady) {
    assert.equal((await api("create", { language: "zh", mode: "live" })).code, "SPEECH_NOT_CONFIGURED");
  }
  const invalidLanguage = await api("create", { language: "en", mode: "demo" });
  assert.equal(invalidLanguage.status, 400);
  assert.ok(invalidLanguage.errorJa.length > 0);
  const created = await api("create", { language: "zh", mode: "demo" });
  assert.equal(created.status, 201);
  const host = created.session;
  sessions.push(host);
  assert.equal(created.room.state, "waiting");
  assert.equal(created.room.captions.length, 0);
  assert.equal((await api("start", {}, host)).code, "NOT_READY");
  assert.equal((await api("join", { code: host.code, language: "zh" })).code, "SAME_LANGUAGE");

  // Two concurrent join requests must not overwrite each other's participant token.
  const raced = await Promise.all([0, 1].map(() => api("join", { code: host.code, language: "ja" })));
  assert.equal(raced.filter((r) => r.status === 200).length, 1);
  assert.equal(raced.filter((r) => r.code === "ROOM_FULL").length, 1);
  const firstGuest = raced.find((r) => r.status === 200).session;
  assert.ok((await poll(firstGuest)).room.generation > created.room.generation);
  assert.equal((await poll(firstGuest)).room.guestStatus, "pending");
  assert.equal((await api("start", {}, firstGuest)).code, "AWAITING_APPROVAL");
  const beforeReject = (await poll(host)).room.generation;
  assert.ok((await api("reject", {}, host)).room.generation > beforeReject);
  assert.equal((await poll(firstGuest)).status, 403);

  const cancelled = await api("join", { code: host.code, language: "ja" });
  assert.equal((await api("cancel-join", {}, host)).code, "INVALID_STATE");
  assert.equal((await api("cancel-join", {}, cancelled.session)).left, true);
  assert.equal((await poll(cancelled.session)).status, 403);
  const vacant = (await poll(host)).room;
  assert.equal(vacant.guestStatus, "none");
  assert.ok(vacant.generation > cancelled.room.generation);
  const joined = await api("join", { code: host.code, language: "ja" });
  assert.equal(joined.status, 200);
  const guest = joined.session;
  const approved = await api("approve", {}, host);
  assert.equal(approved.room.state, "ready");
  assert.ok(approved.room.generation > joined.room.generation);
  assert.equal((await api("cancel-join", {}, guest)).code, "INVALID_STATE");
  assert.equal((await api("start", {}, guest)).code, "HOST_ONLY");
  assert.equal((await api("start", {}, host)).room.state, "running");
  assert.equal((await api("demo-next", { expectedDemoIndex: 0 }, guest)).code, "HOST_ONLY");

  const other = await api("create", { language: "ja", mode: "demo" });
  sessions.push(other.session);
  assert.equal((await poll(host, other.session.roomId)).status, 403);
  const tokenAttempt = await fetch(origin + "/api/speech-token", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + host.token },
    body: JSON.stringify({ roomId: host.roomId }),
  });
  assert.equal(tokenAttempt.status, 403, "demo rooms cannot obtain billable speech credentials");

  const partial = await api("demo-next", { expectedDemoIndex: 0 }, host);
  assert.equal(partial.room.captions.length, 1);
  assert.equal(partial.room.captions[0].isFinal, false);
  assert.equal(partial.room.captions[0].revision, 1);
  assert.equal(partial.room.captions[0].translationState, "pending");
  const finals = await Promise.all([0, 1].map(() => api("demo-next", { expectedDemoIndex: 1 }, host)));
  assert.equal(finals.filter((r) => r.status === 200).length, 1);
  assert.equal(finals.filter((r) => r.code === "STALE_UPDATE").length, 1);
  const complete = (await poll(host)).room;
  assert.equal(complete.captions.length, 1, "a final result updates the same caption");
  assert.equal(complete.captions[0].isFinal, true);
  assert.equal(complete.captions[0].revision, 2);
  assert.ok(complete.captions[0].translation.length > 0);
  assert.deepEqual((await poll(guest)).room.captions, complete.captions);
  assert.equal((await api("demo-next", { expectedDemoIndex: 0 }, host)).code, "STALE_UPDATE");
  assert.equal((await api("caption", { id: "arbitrary", revision: 1, sourceLanguage: "zh", text: "Not allowed", isFinal: true }, host)).code, "INVALID_STATE");
  assert.equal((await api("discard-caption", { id: "demo-0", generation: complete.generation }, guest)).code, "HOST_ONLY");
  assert.equal((await api("discard-caption", { id: "demo-0", generation: complete.generation }, host)).code, "INVALID_STATE");

  const pendingSecond = await api("demo-next", { expectedDemoIndex: 2 }, host);
  assert.equal(pendingSecond.room.captions.length, 2);
  assert.equal(pendingSecond.room.captions[1].isFinal, false);
  const paused = await api("pause", {}, guest);
  assert.equal(paused.room.state, "paused");
  assert.equal(paused.room.captions.length, 1, "pause discards unfinished captions");
  assert.equal(paused.room.captions[0].isFinal, true, "pause preserves final captions");
  assert.equal((await api("demo-next", { expectedDemoIndex: 3 }, host)).code, "INVALID_STATE");
  assert.equal((await api("start", {}, host)).room.state, "running");
  const next = await api("demo-next", { expectedDemoIndex: 3 }, host);
  assert.equal(next.room.captions[1].sourceLanguage, "zh");
  const ended = await api("end", {}, guest);
  assert.equal(ended.room.state, "ended");
  assert.equal(ended.room.captions.length, 0, "ending clears room transcript");
  assert.equal((await poll(host)).room.captions.length, 0);
  assert.equal((await api("start", {}, host)).code, "ROOM_ENDED");
  assert.equal((await api("join", { code: host.code, language: "ja" })).status, 404);
  console.log("PASS: configuration boundary, approval, concurrent joins, room isolation, partial/final updates, dual-client sync, pause/resume, end cleanup.");
} finally {
  for (const session of sessions) await api("end", {}, session).catch(() => {});
}
