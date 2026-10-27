// Run: node --experimental-test-module-mocks --test tests/speech.test.ts
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { registerHooks } from "node:module";
import vm from "node:vm";
import type { Language } from "../lib/types";
import type { SpeechCaption } from "../lib/speech";

registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "./languages" ? new URL("../lib/languages.ts", import.meta.url).href : specifier, context);
} });

type Result = { text: string; language?: string; reason?: number; speakerId?: string };
let latest: FakeRecognizer;
let failStartup = false;
let tracksStopped = 0;
let sdkStops = 0;
let sdkCloses = 0;
let candidateLanguages: string[] = [];
let fixedLanguage = "";
let lastAudioInput: unknown;
let lastPush: { write: (buffer: ArrayBuffer) => void; close: () => void };
let pushWrites: ArrayBuffer[] = [];
let pushCloses = 0;
const installedSdk = await import("microsoft-cognitiveservices-speech-sdk");

test("installed SDK accepts endpoint configuration with a token and no empty API key", () => {
  const endpoint = new URL("wss://koreacentral.stt.speech.microsoft.com/speech/universal/v2");
  assert.throws(() => installedSdk.SpeechConfig.fromEndpoint(endpoint, ""), /Invalid 'auth'/);
  const config = installedSdk.SpeechConfig.fromEndpoint(endpoint);
  try {
    config.authorizationToken = "TEST_TOKEN";
    config.setProperty(installedSdk.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
    assert.equal(config.authorizationToken, "TEST_TOKEN");
    assert.equal(config.getProperty("SpeechServiceConnection_LanguageIdMode"), "Continuous");
  } finally { config.close(); }
});

class FakeRecognizer {
  constructor(config?: { speechRecognitionLanguage?: string }, ..._args: unknown[]) { latest = this; fixedLanguage = config?.speechRecognitionLanguage ?? ""; }
  recognizing!: (_: unknown, event: { result: Result }) => void;
  recognized!: (_: unknown, event: { result: Result }) => void;
  canceled!: () => void;
  sessionStopped!: () => void;
  static FromConfig() { latest = new FakeRecognizer(); return latest; }
  startContinuousRecognitionAsync(ok: () => void, error: (message: string) => void) {
    if (failStartup) error("PRIVATE_TOKEN_SHOULD_NOT_ESCAPE"); else ok();
  }
  stopContinuousRecognitionAsync(ok: () => void) { sdkStops++; ok(); }
  close(ok: () => void) { sdkCloses++; ok(); }
}
class FakeTranscriber extends FakeRecognizer {
  transcribing!: (_: unknown, event: { result: Result }) => void;
  transcribed!: (_: unknown, event: { result: Result }) => void;
  constructor(..._args: unknown[]) { super(); latest = this; }
  static FromConfig() { return new FakeTranscriber(); }
  startTranscribingAsync(ok: () => void, error: (message: string) => void) { super.startContinuousRecognitionAsync(ok, error); }
  stopTranscribingAsync(ok: () => void) { super.stopContinuousRecognitionAsync(ok); }
}

mock.module("microsoft-cognitiveservices-speech-sdk", { namedExports: {
  SpeechRecognizer: FakeRecognizer,
  ConversationTranscriber: FakeTranscriber,
  SpeechConfig: { fromEndpoint: function (endpoint: URL, auth?: string) {
    assert.equal(arguments.length, 1, "token configuration must omit the auth argument");
    assert.equal(auth, undefined);
    assert.match(endpoint.href, /\/speech\/universal\/v2$/);
    return { authorizationToken: "", setProperty() {} };
  } },
  AutoDetectSourceLanguageConfig: { fromLanguages: (languages: string[]) => { candidateLanguages = languages; return { mode: 0 }; } },
  LanguageIdMode: { Continuous: 1 },
  PropertyId: { SpeechServiceConnection_LanguageIdMode: 3200, SpeechServiceResponse_DiarizeIntermediateResults: 48 },
  ResultReason: { RecognizedSpeech: 3, NoMatch: 0 },
  AudioConfig: { fromStreamInput: (input: unknown) => { lastAudioInput = input; return { close() {} }; } },
  AudioStreamFormat: { getWaveFormatPCM: (rate: number, bits: number, channels: number) => { assert.deepEqual([rate, bits, channels], [16000, 16, 1]); return {}; } },
  AudioInputStream: { createPushStream: () => { lastPush = { write: buffer => pushWrites.push(buffer), close: () => { pushCloses++; } }; return lastPush; } },
} });

const { startSpeech, speechLooksStalled } = await import(new URL("../lib/speech.ts", import.meta.url).href);

test("speech health warns only after prolonged sound without recognition, clears on quiet, and ignores timer suspension", () => {
  const fresh = () => ({ lastRecognitionAt: 0, lastSoundAt: 0, lastSampleAt: 0, soundStartedAt: null as number | null, voicedMs: 0 });
  let health = fresh();
  for (let at = 100; at <= 30000; at += 100) assert.equal(speechLooksStalled(health, 0, at), false);
  for (let at = 30100; at <= 34000; at += 100) assert.equal(speechLooksStalled(health, 0.2, at), false, "speaking after silence is not immediately stale");
  for (let at = 34100; at <= 42000; at += 100) assert.equal(speechLooksStalled(health, 0.2, at), false);
  assert.equal(speechLooksStalled(health, 0.2, 42200), true);
  assert.equal(speechLooksStalled(health, 0, 44000), false, "silence clears warning");
  health = fresh();
  for (let at = 100; at <= 13000; at += 100) {
    if (at % 3000 === 0) { health.lastRecognitionAt = at; health.voicedMs = 0; health.soundStartedAt = null; }
    assert.equal(speechLooksStalled(health, 0.2, at), false, "recognition activity prevents a warning");
  }
  health = fresh();
  assert.equal(speechLooksStalled(health, 0.2, 100), false);
  assert.equal(speechLooksStalled(health, 0.2, 30000), false, "a delayed sample cannot invent 30 seconds of sound");
});

test("speech updates preserve sentence identity and always release the microphone", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const track = { onended: null, stop() { tracksStopped++; } };
  const mediaStream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let pendingMedia: Promise<typeof mediaStream> | undefined;
  let microphoneRequested = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getUserMedia: async () => { microphoneRequested = true; return pendingMedia ?? mediaStream; } },
  } });
  const captions: SpeechCaption[] = [];
  const errors: string[] = [];
  const timings: { languageWaitMs: number }[] = [];
  let stopped = 0;
  const options = {
    languages: ["zh", "ja"] as [Language, Language],
    getToken: async () => ({ token: "TEST_TOKEN", region: "eastasia" }),
    onCaption: (item: SpeechCaption) => captions.push(item),
    onError: (message: string) => errors.push(message),
    onTiming: (sample: { languageWaitMs: number }) => timings.push(sample),
    onStopped: () => { stopped++; },
  };
  try {
    const session = await startSpeech(options);
    assert.deepEqual(candidateLanguages, ["zh-CN", "ja-JP"]);
    latest.recognizing(null, { result: { text: "明天" } });
    latest.recognizing(null, { result: { text: "明天下午", language: "zh-CN" } });
    latest.recognized(null, { result: { text: "明天下午三点。", language: "zh-CN", reason: 3 } });
    latest.recognizing(null, { result: { text: "はい", language: "ja-JP" } });
    latest.recognized(null, { result: { text: "", reason: 0 } });
    assert.equal(captions[0].sourceLanguage, null);
    assert.deepEqual(captions.slice(0, 3).map((c) => c.revision), [1, 2, 3]);
    assert.equal(captions[0].id, captions[2].id);
    assert.equal(captions[2].isFinal, true);
    assert.notEqual(captions[2].id, captions[3].id);
    assert.equal(captions[3].sourceLanguage, "ja");
    assert.equal(captions[4].id, captions[3].id);
    assert.equal(captions[4].text, "");
    assert.equal(captions[4].isFinal, true);
    assert.equal(timings.length, 2, "one language confirmation sample per sentence");
    assert.ok(timings.every(sample => Number.isFinite(sample.languageWaitMs) && sample.languageWaitMs >= 0));

    await Promise.all([session.stop(), session.stop()]);
    assert.deepEqual([tracksStopped, sdkStops, sdkCloses, stopped], [1, 1, 1, 1]);
    latest.recognizing(null, { result: { text: "late" } });
    assert.equal(captions.length, 5);

    failStartup = true;
    await assert.rejects(startSpeech(options), (error: Error) => {
      assert.match(error.message, /启动失败/);
      assert.doesNotMatch(error.message, /PRIVATE_TOKEN/);
      return true;
    });
    assert.deepEqual([tracksStopped, sdkStops, sdkCloses, stopped], [2, 2, 2, 2]);

    failStartup = false;
    const interrupted = await startSpeech(options);
    latest.canceled();
    await interrupted.stop();
    assert.equal(errors.length, 1);
    assert.deepEqual([tracksStopped, sdkStops, sdkCloses, stopped], [3, 3, 3, 3]);

    let grantMicrophone!: (stream: typeof mediaStream) => void;
    microphoneRequested = false;
    pendingMedia = new Promise(resolve => { grantMicrophone = resolve; });
    const controller = new AbortController();
    const starting = startSpeech({ ...options, signal: controller.signal });
    while (!microphoneRequested) await setImmediate();
    controller.abort();
    grantMicrophone(mediaStream);
    await assert.rejects(starting, { name: "AbortError" });
    assert.deepEqual([tracksStopped, sdkStops, sdkCloses, stopped], [4, 3, 3, 4]);

    pendingMedia = undefined;
    const activeController = new AbortController();
    const activeSession = await startSpeech({ ...options, signal: activeController.signal });
    activeController.abort();
    await activeSession.stop();
    assert.deepEqual([tracksStopped, sdkStops, sdkCloses, stopped], [5, 4, 4, 5]);

    for (const pair of [["zh", "ko"], ["ja", "ko"]] as [Language, Language][]) {
      const koreanSession = await startSpeech({ ...options, languages: pair, uiLanguage: "ko" });
      assert.deepEqual(candidateLanguages, pair.map(lang => ({ zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", en: "en-US" })[lang]));
      latest.recognized(null, { result: { text: "금요일 오후 세 시에 만나요.", language: "ko-KR", reason: 3 } });
      assert.equal(captions.at(-1)?.sourceLanguage, "ko");
      latest.recognizing(null, { result: { text: "outside room", language: pair[0] === "zh" ? "ja-JP" : "zh-CN" } });
      assert.equal(captions.at(-1)?.sourceLanguage, null, "do not assign languages outside this room");
      latest.canceled();
      assert.match(errors.at(-1)!, /다시 연결/);
      await koreanSession.stop();
    }
    await assert.rejects(startSpeech({ ...options, languages: ["ko", "ko"], uiLanguage: "ko" }), /서로 다른/);

    const remoteEnglish = await startSpeech({ ...options, languages: ["zh", "en"], sourceLanguage: "en", uiLanguage: "en" });
    assert.equal(fixedLanguage, "en-US", "a remote participant uses their own fixed language");
    latest.recognized(null, { result: { text: "Can you hear me?", reason: 3 } });
    assert.equal(captions.at(-1)?.sourceLanguage, "en");
    latest.canceled();
    assert.match(errors.at(-1)!, /speech service disconnected/);
    await remoteEnglish.stop();

    const solo = await startSpeech({ ...options, diarization: true, languages: ["zh", "ko"] });
    let transcriber = latest as FakeTranscriber;
    transcriber.transcribing(null, { result: { text: "你好", language: "zh-CN", speakerId: "Unknown" } });
    assert.equal(captions.at(-1)?.speakerSide, null);
    transcriber.transcribing(null, { result: { text: "你好", language: "zh-CN", speakerId: "Guest-2" } });
    assert.equal(captions.at(-1)?.speakerSide, null, "a provisional label cannot claim A");
    transcriber.transcribed(null, { result: { text: "你好。", language: "zh-CN", speakerId: "Guest-1", reason: 3 } });
    assert.equal(captions.at(-1)?.speakerSide, "a");
    transcriber.transcribed(null, { result: { text: "안녕하세요.", language: "ko-KR", speakerId: "Guest-2", reason: 3 } });
    assert.equal(captions.at(-1)?.speakerSide, "b");
    transcriber.transcribed(null, { result: { text: "한국어도 해요.", language: "ko-KR", speakerId: "Guest-1", reason: 3 } });
    assert.equal(captions.at(-1)?.speakerSide, "a", "a language switch must not change the voice owner");
    transcriber.transcribed(null, { result: { text: "第三个人。", language: "zh-CN", speakerId: "Guest-3", reason: 3 } });
    assert.equal(captions.at(-1)?.speakerSide, null, "extra voices stay unassigned");
    const beforeStop = [tracksStopped, sdkStops, sdkCloses];
    await solo.stop();
    assert.deepEqual([tracksStopped, sdkStops, sdkCloses], beforeStop.map(n => n + 1));

    const sameLanguage = await startSpeech({ ...options, diarization: true, languages: ["ko", "ko"] });
    transcriber = latest as FakeTranscriber;
    transcriber.transcribed(null, { result: { text: "다시 시작해요.", speakerId: "Guest-2", reason: 3 } });
    assert.equal(captions.at(-1)?.sourceLanguage, "ko", "single-language recognition does not require LID metadata");
    assert.equal(captions.at(-1)?.speakerSide, "a", "every connection starts a fresh A/B assignment");
    await sameLanguage.stop();
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("fixed English capture uses PCM push input, downmixes safely, and stops all resources without a microphone fallback", async () => {
  const { captureAudio } = await import(new URL("../lib/audio-capture.ts", import.meta.url).href);
  const keys = ["navigator", "window", "MediaStream", "AudioContext", "AudioWorkletNode"];
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Track extends EventTarget {
    kind: string; readyState = "live"; stops = 0;
    constructor(kind: string) { super(); this.kind = kind; }
    stop() { this.readyState = "ended"; this.stops++; }
    end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
  }
  class Stream {
    tracks: Track[];
    constructor(tracks: Track[]) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  }
  type Processor = { process: (inputs: Float32Array[][]) => boolean };
  let processorType: new () => Processor;
  const processorBuffers: ArrayBuffer[] = [];
  let microphoneCalls = 0, resumeHangs = false;
  const allTracks: Track[][] = [], contexts: Context[] = [], revoked: string[] = [];
  let node: Worklet;
  class Worklet {
    port: { onmessage: ((event: { data: ArrayBuffer }) => void) | null } = { onmessage: null };
    disconnected = false;
    constructor(_context: unknown, name: string) { assert.equal(name, "kotoba-pcm"); node = this; }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  class Context {
    sampleRate: number; state = "suspended"; destination = {}; closed = 0;
    sources: { disconnected: boolean; connect: () => void; disconnect: () => void }[] = [];
    constructor(options: { sampleRate?: number } = {}) { this.sampleRate = options.sampleRate ?? 48000; contexts.push(this); }
    audioWorklet = { addModule: async (url: string) => {
      const code = await (await fetch(url)).text();
      vm.runInNewContext(code, {
        AudioWorkletProcessor: class { port = { postMessage: (buffer: ArrayBuffer) => processorBuffers.push(buffer) }; },
        registerProcessor: (name: string, processor: new () => Processor) => { assert.equal(name, "kotoba-pcm"); processorType = processor; },
      });
    } };
    createAnalyser() { return { fftSize: 0, getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128) }; }
    createMediaStreamSource() { const source = { disconnected: false, connect() {}, disconnect() { this.disconnected = true; } }; this.sources.push(source); return source; }
    resume() { if (resumeHangs) return new Promise<void>(() => {}); this.state = "running"; return Promise.resolve(); }
    close() { this.closed++; this.state = "closed"; return Promise.resolve(); }
  }
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    getDisplayMedia: async () => { const tracks = [new Track("audio"), new Track("video")]; allTracks.push(tracks); return new Stream(tracks); },
    getUserMedia: async () => { microphoneCalls++; throw new Error("no microphone allowed"); },
  } } });
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: Stream });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: Context });
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: Worklet });
  const captions: SpeechCaption[] = [], errors: string[] = [];
  const options = { languages: ["en", "zh"] as [Language, Language], sourceLanguage: "en" as Language,
    getToken: async () => ({ token: "TEST_TOKEN", region: "koreacentral" }),
    onCaption: (caption: SpeechCaption) => captions.push(caption), onError: (error: string) => errors.push(error), onStopped() {} };
  try {
    candidateLanguages = []; pushWrites = []; pushCloses = 0;
    const capture = await captureAudio("display"), session = await startSpeech({ ...options, capture });
    assert.equal(fixedLanguage, "en-US"); assert.deepEqual(candidateLanguages, [], "fixed source skips language detection");
    assert.equal(lastAudioInput, lastPush, "SDK receives only PushAudioInputStream, never the capture MediaStream");
    latest.recognizing(null, { result: { text: "Welcome to class." } });
    latest.recognized(null, { result: { text: "Welcome to class.", reason: 3 } });
    assert.equal(captions[0].sourceLanguage, "en"); assert.equal(captions[1].sourceLanguage, "en");
    const processor = new processorType!();
    const left = new Float32Array(2048), right = new Float32Array(2048);
    left.set([4, -4, 1, -1, 0.5]); right.set([0, 0, -1, 0, 0.5]);
    assert.equal(processor.process([[left.subarray(0, 128), right.subarray(0, 128)]]), true);
    assert.equal(processorBuffers.length, 0, "small worklet frames are buffered into 128 ms chunks");
    assert.equal(processor.process([[left.subarray(128), right.subarray(128)]]), true);
    assert.deepEqual([...new Int16Array(processorBuffers[0]).slice(0, 5)], [32767, -32768, 0, -16384, 16384], "real processor code clamps, averages stereo, and emits signed PCM16");
    const deliver = node!.port.onmessage!;
    deliver({ data: new ArrayBuffer(4096) }); assert.equal(pushWrites.length, 1);
    const beforeErrors = errors.length;
    await session.stop(); deliver({ data: new ArrayBuffer(4096) });
    assert.equal(pushWrites.length, 1, "late PCM cannot write into a closed input"); assert.equal(pushCloses, 1);
    assert.equal(errors.length, beforeErrors, "normal capture.stop must not be reported as a source failure");
    assert.deepEqual(allTracks[0].map(track => track.stops), [1, 1]); assert.equal(contexts[0].closed, 1); assert.equal(node!.disconnected, true); assert.equal(node!.port.onmessage, null); assert.equal(revoked.length, 1);

    const nextCapture = await captureAudio("display"), nextSession = await startSpeech({ ...options, capture: nextCapture });
    allTracks[1][1].end(); await nextSession.stop();
    assert.equal(nextCapture.ended.aborted, true); assert.deepEqual(allTracks[1].map(track => track.stops), [1, 1]);
    assert.match(errors.at(-1)!, /音频来源已停止/); assert.equal(contexts[1].closed, 1); assert.equal(pushCloses, 2);

    const invalid = await captureAudio("display");
    await assert.rejects(startSpeech({ ...options, capture: invalid, languages: ["zh", "ko"] }), /请选择/);
    assert.deepEqual(allTracks[2].map(track => track.stops), [1, 1]);
    const failed = await captureAudio("display");
    await assert.rejects(startSpeech({ ...options, capture: failed, getToken: async () => { throw new Error("SECRET_TOKEN"); } }), error => { assert.match((error as Error).message, /启动失败/); assert.doesNotMatch((error as Error).message, /SECRET/); return true; });
    assert.deepEqual(allTracks[3].map(track => track.stops), [1, 1]);

    const stale = await captureAudio("display"), abort = new AbortController(); abort.abort();
    await assert.rejects(startSpeech({ ...options, capture: stale, signal: abort.signal }), { name: "AbortError" });
    assert.deepEqual(allTracks[4].map(track => track.stops), [1, 1]);
    assert.equal(microphoneCalls, 0, "source end, invalid input and token failure never request a microphone");

    resumeHangs = true; mock.timers.enable({ apis: ["setTimeout"] });
    const suspended = await captureAudio("display"), starting = startSpeech({ ...options, capture: suspended });
    const rejected = assert.rejects(starting, /启动失败/);
    const previousContexts = contexts.length;
    while (contexts.length === previousContexts || !node!.port.onmessage) await setImmediate();
    // addModule is asynchronous; let its continuation install the bounded resume timeout.
    await setImmediate(); mock.timers.tick(15000); await rejected;
    assert.deepEqual(allTracks[5].map(track => track.stops), [1, 1]); assert.equal(contexts.at(-1)!.closed, 1); assert.equal(pushCloses, 3);
    mock.timers.reset();
    resumeHangs = false; failStartup = true;
    const sdkFailure = await captureAudio("display");
    await assert.rejects(startSpeech({ ...options, capture: sdkFailure }), error => { assert.match((error as Error).message, /启动失败/); assert.doesNotMatch((error as Error).message, /PRIVATE_TOKEN/); return true; });
    assert.deepEqual(allTracks[6].map(track => track.stops), [1, 1]); assert.equal(contexts.at(-1)!.closed, 1); assert.equal(pushCloses, 4); assert.equal(microphoneCalls, 0);
  } finally {
    failStartup = false; mock.timers.reset(); URL.revokeObjectURL = originalRevoke;
    for (const context of contexts) if (context.state !== "closed") await context.close();
    for (const key of keys) { const descriptor = descriptors.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
