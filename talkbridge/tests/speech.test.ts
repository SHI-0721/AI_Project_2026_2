// Run: node --experimental-test-module-mocks --test tests/speech.test.ts
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { SpeechCaption } from "../lib/speech";

type Result = { text: string; language?: string; reason?: number };
let latest: FakeRecognizer;
let failStartup = false;
let tracksStopped = 0;
let sdkStops = 0;
let sdkCloses = 0;
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

mock.module("microsoft-cognitiveservices-speech-sdk", { namedExports: {
  SpeechRecognizer: FakeRecognizer,
  SpeechConfig: { fromEndpoint: function (endpoint: URL, auth?: string) {
    assert.equal(arguments.length, 1, "token configuration must omit the auth argument");
    assert.equal(auth, undefined);
    assert.match(endpoint.href, /\/speech\/universal\/v2$/);
    return { authorizationToken: "", setProperty() {} };
  } },
  AutoDetectSourceLanguageConfig: { fromLanguages: () => ({ mode: 0 }) },
  LanguageIdMode: { Continuous: 1 },
  PropertyId: { SpeechServiceConnection_LanguageIdMode: 3200 },
  ResultReason: { RecognizedSpeech: 3, NoMatch: 0 },
  AudioConfig: { fromStreamInput: () => ({ close() {} }) },
} });

const { startSpeech } = await import(new URL("../lib/speech.ts", import.meta.url).href);

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
  let stopped = 0;
  const options = {
    getToken: async () => ({ token: "TEST_TOKEN", region: "eastasia" }),
    onCaption: (item: SpeechCaption) => captions.push(item),
    onError: (message: string) => errors.push(message),
    onStopped: () => { stopped++; },
  };
  try {
    const session = await startSpeech(options);
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
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
