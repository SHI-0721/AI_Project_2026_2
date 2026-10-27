import type { Language } from "./types";
import { isLanguage, SPEECH_LOCALES } from "./languages";
import type { CapturedAudio } from "./audio-capture";

export type SpeechCaption = {
  id: string;
  revision: number;
  sourceLanguage: Language | null;
  text: string;
  isFinal: boolean;
  speakerId?: string | null;
  speakerSide?: "a" | "b" | null;
};

type SpeechOptions = {
  languages: [Language, Language];
  diarization?: boolean;
  sourceLanguage?: Language;
  capture?: CapturedAudio;
  uiLanguage?: Language;
  signal?: AbortSignal;
  getToken: () => Promise<{ token: string; region: string }>;
  onCaption: (item: SpeechCaption) => void;
  onError: (message: string) => void;
  onStopped: () => void;
  onLevel?: (level: number) => void;
  onHealth?: (state: "ok" | "stalled") => void;
  onTiming?: (sample: { languageWaitMs: number }) => void;
};

type SpeechHealth = { lastRecognitionAt: number; lastSoundAt: number; lastSampleAt: number; soundStartedAt: number | null; voicedMs: number };
// Calibrate for the phone microphone if field testing shows excessive noise alerts.
const HEALTH = { level: 0.08, quietMs: 1500, staleMs: 12000, voicedMs: 2500 };
export function speechLooksStalled(health: SpeechHealth, level: number, now: number): boolean {
  // A suspended/throttled tab does not count the entire missed interval as sound.
  const elapsed = Math.min(250, Math.max(0, now - health.lastSampleAt));
  health.lastSampleAt = now;
  if (now - health.lastSoundAt > HEALTH.quietMs) {
    health.soundStartedAt = null; health.voicedMs = 0;
  }
  if (level >= HEALTH.level) {
    health.soundStartedAt ??= now;
    health.lastSoundAt = now;
    health.voicedMs += elapsed;
  }
  if (now - health.lastSoundAt > HEALTH.quietMs) {
    return false;
  }
  // Noise may also satisfy this heuristic: warn without pausing or restarting the microphone.
  return health.soundStartedAt !== null && health.voicedMs >= HEALTH.voicedMs
    && now - Math.max(health.lastRecognitionAt, health.soundStartedAt) >= HEALTH.staleMs;
}

export async function startSpeech(options: SpeechOptions): Promise<{ stop: () => Promise<void> }> {
  const say = (zh: string, ja: string, ko: string, en: string) => options.uiLanguage === "en" ? en : options.uiLanguage === "ko" ? ko : options.uiLanguage === "ja" ? ja : zh;
  if (options.languages?.length !== 2 || !options.languages.every(isLanguage)
    || (options.sourceLanguage !== undefined && (!isLanguage(options.sourceLanguage) || !options.languages.includes(options.sourceLanguage)))
    || (!options.diarization && !options.sourceLanguage && options.languages[0] === options.languages[1])) {
    options.capture?.stop();
    throw new Error(say("请选择两种不同的对话语言。", "異なる2つの会話言語を選んでください。", "서로 다른 두 대화 언어를 선택해 주세요.", "Choose two different conversation languages."));
  }
  if (typeof window === "undefined" || (!options.capture && !navigator.mediaDevices?.getUserMedia)) {
    options.capture?.stop();
    throw new Error(say("此页面无法使用麦克风，请通过 HTTPS 在安卓 Chrome 中打开。", "マイクを利用できません。Android ChromeでHTTPSのページを開いてください。", "마이크를 사용할 수 없습니다. 안드로이드 Chrome에서 HTTPS 페이지를 열어 주세요.", "Microphone access is unavailable. Open this HTTPS page in Chrome or Edge."));
  }

  let recognizer: import("microsoft-cognitiveservices-speech-sdk").SpeechRecognizer | import("microsoft-cognitiveservices-speech-sdk").ConversationTranscriber | undefined;
  let audio: import("microsoft-cognitiveservices-speech-sdk").AudioConfig | undefined;
  let stream: MediaStream | undefined;
  let meter: AudioContext | undefined;
  let pushInput: import("microsoft-cognitiveservices-speech-sdk").PushAudioInputStream | undefined;
  let worklet: AudioWorkletNode | undefined;
  let captureNode: MediaStreamAudioSourceNode | undefined;
  let workletUrl: string | undefined;
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let tokenTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let captureInterrupted = options.capture?.ended.aborted ?? false;
  let stopPromise: Promise<void> | undefined;
  let sentenceId = crypto.randomUUID();
  let revision = 0;
  let cancelStartup: (() => void) | undefined;
  const health: SpeechHealth = { lastRecognitionAt: performance.now(), lastSoundAt: 0, lastSampleAt: performance.now(), soundStartedAt: null, voicedMs: 0 };
  let stalled = false;
  let firstTextAt: number | undefined;
  let languageTimed = false;
  // Anonymous speaker labels are scoped to this connection; A must speak first after every restart.
  const speakers = new Map<string, "a" | "b">();
  function reportHealth(next: boolean) {
    if (stalled === next) return;
    stalled = next; options.onHealth?.(next ? "stalled" : "ok");
  }
  function recognitionActivity() {
    health.lastRecognitionAt = performance.now(); health.voicedMs = 0; health.soundStartedAt = null;
    reportHealth(false);
  }

  function stop(): Promise<void> {
    if (stopped) return stopPromise ?? Promise.resolve();
    stopped = true;
    options.signal?.removeEventListener("abort", abort);
    options.capture?.ended.removeEventListener("abort", captureEnded);
    clearInterval(levelTimer);
    clearTimeout(tokenTimer);
    reportHealth(false);
    if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); }
    captureNode?.disconnect();
    pushInput?.close();
    if (workletUrl) { URL.revokeObjectURL(workletUrl); workletUrl = undefined; }
    // Release the microphone immediately even if the SDK's stop callback never arrives.
    if (options.capture) options.capture.stop();
    else stream?.getTracks().forEach((track) => track.stop());
    if (meter && meter.state !== "closed") void meter.close().catch(() => {});
    options.onLevel?.(0);
    stopPromise = (async () => {
      if (recognizer) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1500);
          const finish = () => { clearTimeout(timeout); resolve(); };
          try {
            if ("stopTranscribingAsync" in recognizer!) recognizer.stopTranscribingAsync(finish, finish);
            else recognizer!.stopContinuousRecognitionAsync(finish, finish);
          }
          catch { finish(); }
        });
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1500);
          const finish = () => { clearTimeout(timeout); resolve(); };
          try { recognizer!.close(finish, finish); }
          catch { finish(); }
        });
      }
      try { audio?.close(); } catch { /* Tracks have already been stopped. */ }
      options.onStopped();
    })();
    return stopPromise;
  }

  function fail(message: string) {
    if (stopped) return;
    try { options.onError(message); } finally { void stop(); }
  }

  function renewToken() {
    tokenTimer = setTimeout(async () => {
      try {
        const { token } = await options.getToken();
        if (stopped) return;
        if (!token) throw new Error("missing token");
        recognizer!.authorizationToken = token;
        renewToken();
      } catch {
        fail(say("语音连接续期失败，已停止收音，请重新开始。", "音声接続を更新できませんでした。再接続してください。", "음성 연결을 갱신하지 못해 수음을 중지했습니다. 다시 연결해 주세요.", "Speech authorization could not be renewed. Recording has stopped. Please reconnect."));
      }
    }, 8 * 60 * 1000);
  }

  function abort() {
    void stop();
    cancelStartup?.();
  }
  function captureEnded() {
    if (stopped) return;
    captureInterrupted = true;
    fail(say("音频来源已停止，请重新选择收音来源后继续。", "音声共有が終了しました。入力元を選び直してください。", "오디오 입력이 종료되었습니다. 입력 소스를 다시 선택해 주세요.", "The audio source has stopped. Select an input source and start again."));
    cancelStartup?.();
  }
  function checkAborted() {
    if (options.signal?.aborted || captureInterrupted) throw new DOMException("收音已取消。", "AbortError");
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  options.capture?.ended.addEventListener("abort", captureEnded, { once: true });

  try {
    checkAborted();
    if (options.capture) {
      stream = options.capture.stream;
      if (!stream.getAudioTracks().length || stream.getAudioTracks().every(track => track.readyState === "ended") || stream.getVideoTracks().length) throw new Error("invalid audio capture");
    }
    const [sdk, authorization] = await Promise.all([
      import("microsoft-cognitiveservices-speech-sdk"),
      options.getToken(),
    ]);
    checkAborted();
    if (!authorization.token || !/^[a-z0-9]+$/.test(authorization.region)) {
      throw new Error("invalid speech configuration");
    }
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Browser permission prompts cannot be aborted. Dispose a late stream before using it.
    if (options.signal?.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      stream = undefined;
      throw new DOMException("收音已取消。", "AbortError");
    }
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => fail(say("麦克风已断开，已停止收音，请检查权限后重新开始。", "マイクが切断されました。権限を確認して再接続してください。", "마이크 연결이 끊겼습니다. 권한을 확인한 후 다시 연결해 주세요.", "The microphone disconnected. Check its permissions and reconnect."));
    });

    if (options.capture || options.onLevel || options.onHealth) {
      try {
        meter = new AudioContext(options.capture ? { sampleRate: 16000 } : undefined);
        const analyser = meter.createAnalyser();
        analyser.fftSize = 256;
        meter.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        if (!options.capture) void meter.resume().catch(() => {});
        levelTimer = setInterval(() => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) sum += ((value - 128) / 128) ** 2;
          const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
          options.onLevel?.(level);
          reportHealth(speechLooksStalled(health, level, performance.now()));
        }, 100);
      } catch {
        if (options.capture) throw new Error("capture audio context unavailable");
        // A volume meter is optional; microphone recognition can continue without it.
      }
    }

    const config = sdk.SpeechConfig.fromEndpoint(new URL(
      `wss://${authorization.region}.stt.speech.microsoft.com/speech/universal/v2`,
    ));
    config.authorizationToken = authorization.token;
    const candidates = options.sourceLanguage ? [options.sourceLanguage] : [...new Set(options.languages)];
    const languages = candidates.length > 1 ? sdk.AutoDetectSourceLanguageConfig.fromLanguages(candidates.map(lang => SPEECH_LOCALES[lang])) : undefined;
    if (languages) {
      config.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
      languages.mode = sdk.LanguageIdMode.Continuous;
    }
    if (options.capture) {
      // SDK MediaStream input can silently fall back to the microphone after the stream ends.
      // PCM push input has no microphone path, even during SDK reconnection.
      if (!meter?.audioWorklet || meter.sampleRate !== 16000) throw new Error("capture PCM format unavailable");
      pushInput = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
      workletUrl = URL.createObjectURL(new Blob([`
        class KotobaPcm extends AudioWorkletProcessor {
          constructor() { super(); this.chunk = new Int16Array(2048); this.offset = 0; }
          process(inputs) {
            const channels = inputs[0];
            if (!channels || !channels.length) return true;
            for (let i = 0; i < channels[0].length; i++) {
              let value = 0;
              for (const channel of channels) value += channel[i];
              value = Math.max(-1, Math.min(1, value / channels.length));
              this.chunk[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
              if (this.offset === this.chunk.length) {
                this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
                this.chunk = new Int16Array(2048); this.offset = 0;
              }
            }
            // Unwritten output channels stay silent: shared audio must not echo from this page.
            return true;
          }
        }
        registerProcessor("kotoba-pcm", KotobaPcm);
      `], { type: "text/javascript" }));
      try { await meter.audioWorklet.addModule(workletUrl); }
      finally { if (workletUrl) { URL.revokeObjectURL(workletUrl); workletUrl = undefined; } }
      checkAborted();
      worklet = new AudioWorkletNode(meter, "kotoba-pcm", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      worklet.port.onmessage = event => {
        if (!stopped && event.data instanceof ArrayBuffer) {
          try { pushInput!.write(event.data); }
          catch { fail(say("音频传输已停止，请重新连接。", "音声の送信が停止しました。再接続してください。", "오디오 전송이 중지되었습니다. 다시 연결해 주세요.", "Audio transmission has stopped. Please reconnect.")); }
        }
      };
      captureNode = meter.createMediaStreamSource(stream);
      captureNode.connect(worklet); worklet.connect(meter.destination);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("audio resume timeout")), 15000);
        cancelStartup = () => { clearTimeout(timeout); reject(new DOMException("收音已取消。", "AbortError")); };
        meter!.resume().then(() => { clearTimeout(timeout); resolve(); }, () => { clearTimeout(timeout); reject(new Error("audio resume failed")); });
      });
      cancelStartup = undefined; checkAborted();
      audio = sdk.AudioConfig.fromStreamInput(pushInput);
    } else audio = sdk.AudioConfig.fromStreamInput(stream);
    if (options.diarization) {
      config.setProperty(sdk.PropertyId.SpeechServiceResponse_DiarizeIntermediateResults, "true");
      if (candidates.length === 1) {
        config.speechRecognitionLanguage = SPEECH_LOCALES[candidates[0]];
        recognizer = new sdk.ConversationTranscriber(config, audio);
      } else recognizer = sdk.ConversationTranscriber.FromConfig(config, languages!, audio);
    } else if (options.sourceLanguage) {
      config.speechRecognitionLanguage = SPEECH_LOCALES[options.sourceLanguage];
      recognizer = new sdk.SpeechRecognizer(config, audio);
    } else recognizer = sdk.SpeechRecognizer.FromConfig(config, languages!, audio);

    function publish(text: string, language: string | undefined, isFinal: boolean, voice?: string) {
      if (stopped) return;
      recognitionActivity();
      const sourceLanguage = options.sourceLanguage ?? options.languages.find(lang => SPEECH_LOCALES[lang] === language) ?? (options.diarization && candidates.length === 1 && !language ? candidates[0] : null);
      const speakerId = voice && voice !== "Unknown" && /^[a-zA-Z0-9_-]{1,100}$/.test(voice) ? voice : null;
      // Commit new labels on final results: provisional diarization can revise an earlier guess.
      if (text.trim() && isFinal && speakerId && !speakers.has(speakerId) && speakers.size < 2) speakers.set(speakerId, speakers.size ? "b" : "a");
      if (text.trim()) {
        firstTextAt ??= performance.now();
        if (sourceLanguage && !languageTimed) {
          languageTimed = true;
          options.onTiming?.({ languageWaitMs: Math.max(0, performance.now() - firstTextAt) });
        }
      }
      if (text.trim() || (isFinal && revision > 0)) {
        options.onCaption({
          id: sentenceId,
          revision: ++revision,
          sourceLanguage,
          text: text.trim(),
          isFinal,
          ...(options.diarization ? { speakerId, speakerSide: speakerId ? speakers.get(speakerId) ?? null : null } : {}),
        });
      }
      if (isFinal) { sentenceId = crypto.randomUUID(); revision = 0; firstTextAt = undefined; languageTimed = false; }
    }

    const partial = (_: unknown, event: { result: { text: string; language?: string; speakerId?: string } }) => publish(event.result.text, event.result.language, false, event.result.speakerId);
    const final = (_: unknown, event: { result: { text: string; language?: string; speakerId?: string; reason: number } }) => {
      if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
        publish(event.result.text, event.result.language, true, event.result.speakerId);
      } else if (event.result.reason === sdk.ResultReason.NoMatch) {
        publish("", undefined, true); // Empty final clears an unconfirmed draft on both phones.
      }
    };
    if ("startTranscribingAsync" in recognizer) { recognizer.transcribing = partial; recognizer.transcribed = final; }
    else { recognizer.recognizing = partial; recognizer.recognized = final; }
    recognizer.canceled = () => fail(say("语音服务连接中断，已停止收音，请重新开始。", "音声サービスとの接続が切れました。再接続してください。", "음성 서비스 연결이 끊겼습니다. 다시 연결해 주세요.", "The speech service disconnected. Recording has stopped. Please reconnect."));
    recognizer.sessionStopped = () => {
      if (!stopped) fail(say("语音会话已结束，请点击开始恢复收音。", "音声セッションが終了しました。再接続してください。", "음성 세션이 종료되었습니다. 다시 연결해 주세요.", "The speech session ended. Press start to resume recording."));
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("speech start timeout")), 15000);
      cancelStartup = () => { clearTimeout(timeout); reject(new DOMException("收音已取消。", "AbortError")); };
      try {
        const ok = () => { clearTimeout(timeout); resolve(); };
        const failed = () => { clearTimeout(timeout); reject(new Error("speech start failed")); };
        if ("startTranscribingAsync" in recognizer!) recognizer.startTranscribingAsync(ok, failed);
        else recognizer!.startContinuousRecognitionAsync(ok, failed);
      } catch {
        clearTimeout(timeout);
        reject(new Error("speech start failed"));
      }
    });
    cancelStartup = undefined;
    checkAborted();
    if (stopped) throw new Error("speech stopped during startup");
    renewToken();
    return { stop };
  } catch (error) {
    await stop();
    checkAborted();
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError") throw new Error(say("麦克风权限未开启，请在浏览器设置中允许后重试。", "ブラウザーでマイクの使用を許可してください。", "브라우저 설정에서 마이크 권한을 허용한 후 다시 시도해 주세요.", "Microphone access was denied. Allow it in your browser settings and try again."));
    if (name === "NotFoundError") throw new Error(say("没有找到可用的麦克风，请检查设备后重试。", "マイクが見つかりません。デバイスを確認してください。", "사용 가능한 마이크를 찾지 못했습니다. 기기를 확인해 주세요.", "No microphone was found. Check your device and try again."));
    if (name === "NotReadableError") throw new Error(say("麦克风无法读取，可能正被其他应用占用。", "マイクを利用できません。他のアプリが使用中の可能性があります。", "마이크를 사용할 수 없습니다. 다른 앱에서 사용 중일 수 있습니다.", "The microphone cannot be read. Another app may be using it."));
    // Never expose SDK errors, response bodies, or authorization material to the UI.
    throw new Error(say("语音识别启动失败，请检查网络及语音服务配置后重试。", "音声認識を開始できません。ネットワークと設定を確認してください。", "음성 인식을 시작하지 못했습니다. 네트워크와 음성 서비스 설정을 확인해 주세요.", "Speech recognition could not start. Check your network and speech service configuration."));
  }
}
