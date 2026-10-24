export type SpeechCaption = {
  id: string;
  revision: number;
  sourceLanguage: "zh" | "ja" | null;
  text: string;
  isFinal: boolean;
};

type SpeechOptions = {
  signal?: AbortSignal;
  getToken: () => Promise<{ token: string; region: string }>;
  onCaption: (item: SpeechCaption) => void;
  onError: (message: string) => void;
  onStopped: () => void;
  onLevel?: (level: number) => void;
};

export async function startSpeech(options: SpeechOptions): Promise<{ stop: () => Promise<void> }> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("此页面无法使用麦克风，请通过 HTTPS 在安卓 Chrome 中打开。");
  }

  let recognizer: import("microsoft-cognitiveservices-speech-sdk").SpeechRecognizer | undefined;
  let audio: import("microsoft-cognitiveservices-speech-sdk").AudioConfig | undefined;
  let stream: MediaStream | undefined;
  let meter: AudioContext | undefined;
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let tokenTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let sentenceId = crypto.randomUUID();
  let revision = 0;
  let cancelStartup: (() => void) | undefined;

  function stop(): Promise<void> {
    if (stopped) return stopPromise ?? Promise.resolve();
    stopped = true;
    options.signal?.removeEventListener("abort", abort);
    clearInterval(levelTimer);
    clearTimeout(tokenTimer);
    // Release the microphone immediately even if the SDK's stop callback never arrives.
    stream?.getTracks().forEach((track) => track.stop());
    if (meter && meter.state !== "closed") void meter.close().catch(() => {});
    options.onLevel?.(0);
    stopPromise = (async () => {
      if (recognizer) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1500);
          const finish = () => { clearTimeout(timeout); resolve(); };
          try { recognizer!.stopContinuousRecognitionAsync(finish, finish); }
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
        fail("语音连接续期失败，已停止收音，请重新开始。");
      }
    }, 8 * 60 * 1000);
  }

  function abort() {
    void stop();
    cancelStartup?.();
  }
  function checkAborted() {
    if (options.signal?.aborted) throw new DOMException("收音已取消。", "AbortError");
  }
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    checkAborted();
    const [sdk, authorization] = await Promise.all([
      import("microsoft-cognitiveservices-speech-sdk"),
      options.getToken(),
    ]);
    checkAborted();
    if (!authorization.token || !/^[a-z0-9]+$/.test(authorization.region)) {
      throw new Error("invalid speech configuration");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Browser permission prompts cannot be aborted. Dispose a late stream before using it.
    if (options.signal?.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      stream = undefined;
      throw new DOMException("收音已取消。", "AbortError");
    }
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => fail("麦克风已断开，已停止收音，请检查权限后重新开始。");
    });

    if (options.onLevel) {
      try {
        meter = new AudioContext();
        const analyser = meter.createAnalyser();
        analyser.fftSize = 256;
        meter.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        void meter.resume().catch(() => {});
        levelTimer = setInterval(() => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) sum += ((value - 128) / 128) ** 2;
          options.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 4));
        }, 100);
      } catch {
        // A volume meter is optional; microphone recognition can continue without it.
      }
    }

    const config = sdk.SpeechConfig.fromEndpoint(new URL(
      `wss://${authorization.region}.stt.speech.microsoft.com/speech/universal/v2`,
    ));
    config.authorizationToken = authorization.token;
    config.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
    const languages = sdk.AutoDetectSourceLanguageConfig.fromLanguages(["zh-CN", "ja-JP"]);
    languages.mode = sdk.LanguageIdMode.Continuous;
    audio = sdk.AudioConfig.fromStreamInput(stream);
    recognizer = sdk.SpeechRecognizer.FromConfig(config, languages, audio);

    function publish(text: string, language: string | undefined, isFinal: boolean) {
      if (stopped) return;
      if (text.trim() || (isFinal && revision > 0)) {
        options.onCaption({
          id: sentenceId,
          revision: ++revision,
          sourceLanguage: language === "zh-CN" ? "zh" : language === "ja-JP" ? "ja" : null,
          text: text.trim(),
          isFinal,
        });
      }
      if (isFinal) { sentenceId = crypto.randomUUID(); revision = 0; }
    }

    recognizer.recognizing = (_, event) => publish(event.result.text, event.result.language, false);
    recognizer.recognized = (_, event) => {
      if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
        publish(event.result.text, event.result.language, true);
      } else if (event.result.reason === sdk.ResultReason.NoMatch) {
        publish("", undefined, true); // Empty final clears an unconfirmed draft on both phones.
      }
    };
    recognizer.canceled = () => fail("语音服务连接中断，已停止收音，请重新开始。");
    recognizer.sessionStopped = () => {
      if (!stopped) fail("语音会话已结束，请点击开始恢复收音。");
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("speech start timeout")), 15000);
      cancelStartup = () => { clearTimeout(timeout); reject(new DOMException("收音已取消。", "AbortError")); };
      try {
        recognizer!.startContinuousRecognitionAsync(
          () => { clearTimeout(timeout); resolve(); },
          () => { clearTimeout(timeout); reject(new Error("speech start failed")); },
        );
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
    if (name === "NotAllowedError") throw new Error("麦克风权限未开启，请在浏览器设置中允许后重试。");
    if (name === "NotFoundError") throw new Error("没有找到可用的麦克风，请检查设备后重试。");
    if (name === "NotReadableError") throw new Error("麦克风无法读取，可能正被其他应用占用。");
    // Never expose SDK errors, response bodies, or authorization material to the UI.
    throw new Error("语音识别启动失败，请检查网络及语音服务配置后重试。");
  }
}
