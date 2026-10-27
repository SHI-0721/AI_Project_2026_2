// Run: node --test tests/audio-capture.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
const { captureAudio } = await import(new URL("../lib/audio-capture.ts", import.meta.url).href);

class Track extends EventTarget {
  readyState = "live";
  stops = 0;
  kind: "audio" | "video";
  constructor(kind: "audio" | "video") { super(); this.kind = kind; }
  stop() { this.stops++; this.readyState = "ended"; }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
class Stream {
  private tracks: Track[];
  constructor(tracks: Track[]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
}
async function withMedia(media: Record<string, unknown>, run: () => Promise<void>) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"), streamDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MediaStream");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: media } });
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: Stream });
  try { await run(); } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else Reflect.deleteProperty(globalThis, "navigator");
    if (streamDescriptor) Object.defineProperty(globalThis, "MediaStream", streamDescriptor); else Reflect.deleteProperty(globalThis, "MediaStream");
  }
}

test("display capture opens immediately, returns audio only, never requests a microphone, and owns every track", async () => {
  const audio = new Track("audio"), video = new Track("video"); let displayCalls = 0, microphoneCalls = 0;
  await withMedia({ getDisplayMedia: async (options: unknown) => { displayCalls++; assert.deepEqual(options, { video: true, audio: true }); return new Stream([audio, video]); }, getUserMedia: async () => { microphoneCalls++; throw new Error("must not request microphone"); } }, async () => {
    const starting = captureAudio("display"); assert.equal(displayCalls, 1, "display picker is invoked before the first await");
    const capture = await starting;
    assert.deepEqual(capture.stream.getTracks(), [audio]); assert.equal(capture.stream.getVideoTracks().length, 0);
    video.end(); assert.equal(capture.ended.aborted, true); assert.deepEqual([audio.stops, video.stops], [1, 1]);
    capture.stop(); assert.deepEqual([audio.stops, video.stops], [1, 1]); assert.equal(microphoneCalls, 0);
  });
});

test("permission rejection, unsupported browsers, and a video-only share have clear safe messages and no microphone fallback", async () => {
  let microphoneCalls = 0; const video = new Track("video");
  await withMedia({ getUserMedia: async () => { microphoneCalls++; }, getDisplayMedia: async () => { throw new DOMException("PRIVATE_PROVIDER_DETAIL", "NotAllowedError"); } }, async () => {
    await assert.rejects(captureAudio("display"), error => { assert.match((error as Error).message, /已取消或未获授权/); assert.doesNotMatch((error as Error).message, /PRIVATE/); return true; });
  });
  await withMedia({ getUserMedia: async () => { microphoneCalls++; } }, async () => { await assert.rejects(captureAudio("display"), /不支持共享/); });
  await withMedia({ getDisplayMedia: async () => new Stream([video]), getUserMedia: async () => { microphoneCalls++; } }, async () => { await assert.rejects(captureAudio("display"), /未共享声音/); });
  assert.equal(video.stops, 1); assert.equal(microphoneCalls, 0);
});

test("aborting while the display picker is open closes every late track without returning a usable capture", async () => {
  const audio = new Track("audio"), video = new Track("video"), abort = new AbortController(); let grant!: (stream: Stream) => void;
  await withMedia({ getDisplayMedia: () => new Promise(resolve => { grant = resolve; }) }, async () => {
    const starting = captureAudio("display", abort.signal); abort.abort();
    await assert.rejects(starting, { name: "AbortError" }); assert.deepEqual([audio.stops, video.stops], [0, 0], "cancellation completes while the picker is still open");
    grant(new Stream([audio, video])); await Promise.resolve();
    assert.deepEqual([audio.stops, video.stops], [1, 1]);
  });
});

test("microphone capture is explicit and an active cancellation stops it once", async () => {
  const audio = new Track("audio"), abort = new AbortController(); let microphoneCalls = 0, displayCalls = 0;
  await withMedia({ getUserMedia: async () => { microphoneCalls++; return new Stream([audio]); }, getDisplayMedia: async () => { displayCalls++; } }, async () => {
    const capture = await captureAudio("microphone", abort.signal); abort.abort(); capture.stop();
    assert.equal(capture.ended.aborted, true); assert.deepEqual([audio.stops, microphoneCalls, displayCalls], [1, 1, 0]);
  });
});
