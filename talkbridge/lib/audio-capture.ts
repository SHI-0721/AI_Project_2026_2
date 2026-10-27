export type CapturedAudio = {
  /** Only these audio tracks may be sent to recognition. */
  stream: MediaStream;
  stop: () => void;
  ended: AbortSignal;
};

/** Call directly in a click handler: display capture needs the browser's user activation. */
export async function captureAudio(source: "microphone" | "display", signal?: AbortSignal): Promise<CapturedAudio> {
  if (signal?.aborted) throw new DOMException("收音已取消。", "AbortError");
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (source !== "microphone" && source !== "display") throw new Error("请选择麦克风或共享音频。");
  if (source === "display" && !media?.getDisplayMedia) throw new Error("此浏览器不支持共享标签页或系统音频，请使用电脑上的 Chrome 或 Edge，或改用麦克风。");
  if (source === "microphone" && !media?.getUserMedia) throw new Error("此页面无法使用麦克风，请通过 HTTPS 打开并检查浏览器权限。");
  let original: MediaStream;
  try {
    // Do not insert an await before getDisplayMedia: it would lose the click's permission context.
    const permission = source === "display"
      ? media!.getDisplayMedia({ video: true, audio: true })
      : media!.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    original = await new Promise<MediaStream>((resolve, reject) => {
      let settled = false;
      const cancel = () => {
        if (settled) return;
        settled = true; signal?.removeEventListener("abort", cancel);
        reject(new DOMException("收音已取消。", "AbortError"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      permission.then(stream => {
        signal?.removeEventListener("abort", cancel);
        if (settled || signal?.aborted) {
          for (const track of stream.getTracks()) { try { track.stop(); } catch { /* Release all late tracks. */ } }
          if (!settled) cancel();
          return;
        }
        settled = true; resolve(stream);
      }, error => {
        signal?.removeEventListener("abort", cancel);
        if (!settled) { settled = true; reject(error); }
      });
      if (signal?.aborted) cancel();
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("收音已取消。", "AbortError");
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "AbortError") throw new Error(source === "display" ? "音频共享已取消或未获授权，请重新选择标签页并允许共享音频。" : "麦克风权限未开启，请在浏览器设置中允许后重试。");
    if (name === "NotFoundError") throw new Error(source === "display" ? "没有找到可以共享的音频来源，请改选标签页或使用麦克风。" : "没有找到可用的麦克风，请检查设备后重试。");
    throw new Error(source === "display" ? "无法共享音频，请在电脑 Chrome 或 Edge 中重试，选择有声音的标签页并勾选共享音频。" : "麦克风无法读取，可能正被其他应用占用。");
  }
  const tracks = original.getTracks(), ended = new AbortController();
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", stop);
    for (const track of tracks) {
      track.removeEventListener("ended", stop);
      try { track.stop(); } catch { /* Release every remaining track even if one fails. */ }
    }
    ended.abort();
  };
  try {
    if (signal?.aborted) throw new DOMException("收音已取消。", "AbortError");
    const audioTracks = original.getAudioTracks();
    if (!audioTracks.length || audioTracks.every(track => track.readyState === "ended")) {
      throw new Error(source === "display" ? "未共享声音。请重新选择有声音的标签页，并勾选“共享标签页音频”；仅共享画面无法生成字幕。" : "没有检测到可用的麦克风音轨，请检查设备后重试。");
    }
    const stream = new MediaStream(audioTracks);
    // The original video track keeps the browser's display capture alive, but never reaches the SDK.
    for (const track of tracks) track.addEventListener("ended", stop, { once: true });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted || tracks.some(track => track.readyState === "ended")) {
      stop(); throw new DOMException("收音已取消。", "AbortError");
    }
    return { stream, stop, ended: ended.signal };
  } catch (error) { stop(); throw error; }
}
