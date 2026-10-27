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
  const invalidLanguage = await api("create", { language: "fr", mode: "demo" });
  assert.equal(invalidLanguage.status, 400);
  assert.ok(invalidLanguage.errorJa.length > 0);
  assert.ok(invalidLanguage.errorKo.length > 0);
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
  const firstJoined = (await poll(firstGuest)).room;
  assert.ok(firstJoined.generation > created.room.generation);
  assert.equal(firstJoined.guestStatus, "approved");
  assert.equal(firstJoined.state, "ready", "joining needs no separate host approval");
  assert.equal((await api("start", {}, firstGuest)).code, "HOST_ONLY");
  assert.equal((await api("approve", {}, firstGuest)).code, "HOST_ONLY");
  assert.equal((await api("leave", {}, host)).code, "GUEST_ONLY");
  assert.equal((await api("leave", {}, firstGuest)).left, true);
  assert.equal((await poll(firstGuest)).status, 403);
  const vacant = (await poll(host)).room;
  assert.equal(vacant.guestStatus, "none");
  assert.equal(vacant.state, "waiting");
  assert.ok(vacant.generation > firstJoined.generation);
  const joined = await api("join", { code: host.code, language: "ja" });
  assert.equal(joined.status, 200);
  let guest = joined.session;
  assert.equal(joined.room.state, "ready");
  assert.equal(joined.room.guestStatus, "approved");
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
  assert.equal((await api("edit-caption", { id: "demo-0", revision: 2, text: "修正权限测试" }, host)).code, "CAPTION_OWNER_ONLY");
  const edited = await api("edit-caption", { id: "demo-0", revision: 2, text: "今日はありがとうございます。" }, guest);
  assert.equal(edited.status, 200);
  assert.equal(edited.room.captions[0].edited, true);
  assert.equal(edited.room.captions[0].revision, 3);
  assert.match(edited.room.captions[0].translation, /演示/);
  assert.deepEqual((await poll(host)).room.captions, edited.room.captions);
  assert.equal((await api("edit-caption", { id: "demo-0", revision: 2, text: "古い修正" }, guest)).code, "STALE_UPDATE");
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
  assert.equal((await api("leave", {}, guest)).left, true);
  assert.equal((await poll(guest)).status, 403, "departed tokens are revoked");
  const afterLeave = (await poll(host)).room;
  assert.equal(afterLeave.state, "waiting");
  assert.equal(afterLeave.captions.length, 0, "new guests must not receive the previous conversation");
  assert.ok(afterLeave.generation > next.room.generation);
  assert.equal((await api("start", {}, host)).code, "NOT_READY");
  const replacement = await api("join", { code: host.code, language: "ja" });
  assert.equal(replacement.status, 200);
  guest = replacement.session;
  assert.equal(replacement.room.captions.length, 0);
  assert.equal(replacement.room.demoIndex, 0);
  assert.equal((await api("start", {}, host)).room.state, "running");
  const ended = await api("end", {}, guest);
  assert.equal(ended.room.state, "ended");
  assert.equal(ended.room.captions.length, 0, "ending clears room transcript");
  assert.equal((await poll(host)).room.captions.length, 0);
  assert.equal((await api("start", {}, host)).code, "ROOM_ENDED");
  assert.equal((await api("join", { code: host.code, language: "ja" })).status, 404);
  for (const partner of ["zh", "ja"]) {
    const korean = await api("create", { language: "ko", mode: "demo" });
    assert.equal(korean.status, 201);
    sessions.push(korean.session);
    const partnerJoin = await api("join", { code: korean.session.code, language: partner });
    assert.equal(partnerJoin.status, 200);
    await api("start", {}, korean.session);
    for (let index = 0; index < 4; index++) assert.equal((await api("demo-next", { expectedDemoIndex: index }, korean.session)).status, 200);
    const pair = (await poll(korean.session)).room;
    assert.deepEqual(pair.captions.map(c => c.sourceLanguage), [partner, "ko"]);
    const correction = await api("edit-caption", { id: "demo-1", revision: 2, text: "내일 오후 네 시에 만나요." }, korean.session);
    assert.equal(correction.status, 200);
    assert.equal(correction.room.captions[1].text, "내일 오후 네 시에 만나요.");
    assert.deepEqual((await poll(partnerJoin.session)).room.captions, correction.room.captions);
    await api("end", {}, korean.session);
  }
  console.log("PASS: language pairs including Korean, correction permissions/sync, configuration boundary, direct/concurrent joins, room isolation, partial/final updates, pause/resume, leave/rejoin, end cleanup.");
} finally {
  for (const session of sessions) await api("end", {}, session).catch(() => {});
}
