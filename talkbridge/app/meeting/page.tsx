"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowLeftRight, Check, Copy, Headphones, Languages, LoaderCircle, Mic, MonitorUp, Pause, Play, Square, Volume2 } from "lucide-react";
import type { Caption, Language, RoomSnapshot, Session } from "@/lib/types";
import { LANGUAGE_CODES, LANGUAGE_NAMES } from "@/lib/languages";
import { captureAudio, type CapturedAudio } from "@/lib/audio-capture";
import { startSpeech } from "@/lib/speech";
import "./meeting.css";

type InputSource = "microphone" | "display";
type Status = "idle" | "starting" | "listening" | "paused" | "stopped";
type Row = Caption & { roomId: string; targetLanguage: Language; local?: boolean };
async function request<T>(path: string, body?: Record<string, unknown>, session?: Session): Promise<T> {
  const response = await fetch(path, { method: body ? "POST" : "GET", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(15000) });
  const data = await response.json() as T & { error?: string; code?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || "连接失败，请重试。"), { code: data.code, status: response.status });
  return data;
}
function errorText(error: unknown) {
  const failure = error as { name?: string; message?: string };
  if (failure.name === "NotAllowedError" || failure.name === "AbortError") return "已取消音频选择，或未允许共享。点击开始后重新选择并勾选共享音频。";
  if (failure.name === "NotFoundError") return "没有找到可用音频，请检查麦克风或选择包含声音的浏览器标签页。";
  if (failure.name === "TimeoutError" || failure.name === "TypeError") return "网络连接失败，已停止收音。历史字幕仍在本页，请检查网络后重新开始。";
  return failure.message || "无法开始收音，请检查音频权限后重试。";
}
const clock = (milliseconds: number) => { const seconds = Math.max(0, Math.ceil(milliseconds / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; };

export default function Meeting() {
  const [sourceLanguage, setSourceLanguage] = useState<Language>("en");
  const [targetLanguage, setTargetLanguage] = useState<Language>("zh");
  const [inputSource, setInputSource] = useState<InputSource>("display");
  const [status, setStatus] = useState<Status>("idle");
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const sessionRef = useRef<Session | null>(null), roomRef = useRef<RoomSnapshot | null>(null);
  const speech = useRef<Awaited<ReturnType<typeof startSpeech>> | null>(null);
  const capture = useRef<CapturedAudio | null>(null), controller = useRef<AbortController | null>(null);
  const epoch = useRef(0), playback = useRef(0), sequence = useRef(0), applied = useRef(0);
  const startup = useRef<Promise<void> | null>(null), closing = useRef<Promise<void>>(Promise.resolve());
  const controls = useRef<Promise<unknown>>(Promise.resolve()), mounted = useRef(true);
  const pending = useRef(new Map<string, Set<Promise<unknown>>>()), sent = useRef(new Map<string, number>());
  const discarded = useRef(new Set<string>());
  const transcript = useRef<HTMLDivElement>(null), follow = useRef(true);
  const englishVoice = voices.find(voice => /^en(?:-|_)/i.test(voice.lang) && voice.localService);
  const active = status === "starting" || status === "listening";

  function cancelPlayback() { playback.current++; if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); if (mounted.current) setSpeaking(false); }
  function stopLocal() {
    epoch.current++; controller.current?.abort(); controller.current = null;
    capture.current?.stop(); capture.current = null;
    const client = speech.current; speech.current = null;
    if (mounted.current) setRows(old => old.filter(row => row.isFinal).map(row => row.translationState === "pending" ? { ...row, translationState: "error", local: false } : row));
    closing.current = Promise.allSettled([closing.current, client?.stop()]).then(() => {});
    return closing.current;
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = controls.current.then(work); controls.current = next.catch(() => {}); return next;
  }
  function merge(next: RoomSnapshot, seq: number, token: string) {
    if (!mounted.current || sessionRef.current?.token !== token || sessionRef.current.roomId !== next.id) return;
    const previous = roomRef.current;
    if (previous?.id === next.id && (previous.generation > next.generation || (previous.generation === next.generation && seq < applied.current))) return;
    applied.current = seq; roomRef.current = next; setRoom(next);
    setRows(old => {
      const values = new Map(old.map(row => [`${row.roomId}:${row.id}`, row]));
      for (const caption of next.captions) {
        const key = `${next.id}:${caption.id}`, saved = values.get(key);
        if (discarded.current.has(key) || (!caption.isFinal && !controller.current)) continue;
        if (saved && (saved.revision > caption.revision || (saved.revision === caption.revision && saved.translationState === "done" && caption.translationState !== "done"))) continue;
        values.set(key, { ...caption, translationState: !controller.current && caption.translationState === "pending" ? "error" : caption.translationState, roomId: next.id, targetLanguage: caption.targetLanguage ?? (caption.sourceLanguage === next.hostLanguage ? next.guestLanguage! : next.hostLanguage) });
      }
      return [...values.values()].slice(-400);
    });
  }
  async function action(name: string, extra: Record<string, unknown> = {}, current = sessionRef.current, run?: number) {
    if (!current) return null;
    const seq = ++sequence.current;
    const data = await request<{ room: RoomSnapshot }>("/api/room", { action: name, roomId: current.roomId, ...extra }, current);
    if (run === undefined || run === epoch.current) merge(data.room, seq, current.token); return data.room;
  }
  async function pauseServer() {
    if (sessionRef.current && roomRef.current?.state === "running") await action("pause");
  }
  function fail(message: string, run: number) {
    if (run !== epoch.current || !mounted.current) return;
    void stopLocal(); setStatus("paused"); setError(message);
    void enqueue(pauseServer).catch(() => {});
  }
  async function halt(end: boolean) {
    cancelPlayback(); const boot = startup.current, closed = stopLocal();
    if (mounted.current) setStatus(end ? "stopped" : "paused");
    await Promise.allSettled([boot, closed]);
    await enqueue(async () => {
      if (!end) { await pauseServer(); return; }
      const current = sessionRef.current;
      if (current) { try { await action("end", {}, current); } catch (e) { if (![404, 410].includes((e as { status?: number }).status ?? 0)) throw e; } }
      sessionRef.current = null; roomRef.current = null; if (mounted.current) setRoom(null);
    });
  }
  function change(source: Language, target: Language, input = inputSource) {
    void halt(false).catch(e => { if (mounted.current) setError(errorText(e)); });
    setSourceLanguage(source); setTargetLanguage(target); setInputSource(input); setNotice("方向已设置。点击开始后收音。");
  }

  // Called directly by the click handler: the display picker must retain user activation.
  function start() {
    if (controller.current) return;
    cancelPlayback(); setError(""); setNotice("");
    const abort = new AbortController(), run = ++epoch.current; controller.current = abort;
    const choosing = captureAudio(inputSource, abort.signal);
    setStatus("starting");
    const priorStart = startup.current, priorClose = closing.current;
    let tokenFailure = "";
    const work = (async () => {
      let selected: CapturedAudio | undefined;
      try {
        selected = await choosing;
        if (run !== epoch.current || abort.signal.aborted) { selected.stop(); return; }
        if (selected.ended.aborted) { selected.stop(); throw new Error("所选音频已停止。请点击开始重新选择。"); }
        capture.current = selected;
        selected.ended.addEventListener("abort", () => fail("共享或音频设备已停止。点击开始可重新选择音频。", run), { once: true });
        await Promise.allSettled([priorStart, priorClose]);
        if (run !== epoch.current) return;
        const next = await enqueue(async () => {
          if (run !== epoch.current) return null;
          let current = roomRef.current;
          const samePair = current && ((current.hostLanguage === sourceLanguage && current.guestLanguage === targetLanguage) || (current.hostLanguage === targetLanguage && current.guestLanguage === sourceLanguage)) && current.expiresAt > Date.now() && current.state !== "ended";
          if (!samePair) {
            if (sessionRef.current) { try { await action("end"); } catch (e) { if (![404, 410].includes((e as { status?: number }).status ?? 0)) throw e; } }
            if (run !== epoch.current) return null;
            const data = await request<{ session: Session; room: RoomSnapshot }>("/api/room", { action: "create", deviceMode: "solo", mode: "live", language: sourceLanguage, otherLanguage: targetLanguage });
            sessionRef.current = data.session; roomRef.current = data.room; setRoom(data.room); current = data.room;
          }
          if (run !== epoch.current) return null;
          if (current?.state === "running") await action("pause");
          if (run !== epoch.current) return null;
          return action("start");
        });
        if (!next || run !== epoch.current) return;
        const current = sessionRef.current!;
        const client = await startSpeech({ capture: selected, sourceLanguage, languages: [sourceLanguage, targetLanguage], diarization: false, uiLanguage: "zh", signal: abort.signal,
          getToken: async () => { try { return await request("/api/speech-token", { roomId: current.roomId }, current); } catch (e) { tokenFailure = errorText(e); throw e; } },
          onCaption: item => {
            if (run !== epoch.current || sessionRef.current?.token !== current.token) return;
            const key = `${current.roomId}:${item.id}`;
            if (discarded.current.has(key)) return;
            if (!item.text) {
              discarded.current.add(key);
              setRows(old => old.filter(row => `${row.roomId}:${row.id}` !== key || row.isFinal));
              void Promise.allSettled([...(pending.current.get(key) ?? [])]).then(async () => { if (run !== epoch.current) return; await action("discard-caption", { id: item.id, generation: next.generation }, current, run); if (run === epoch.current) setRows(old => old.filter(row => `${row.roomId}:${row.id}` !== key || row.isFinal)); }).catch(() => {}); return;
            }
            const side = sourceLanguage === next.hostLanguage ? "a" : "b";
            setRows(old => {
              const saved = old.find(row => `${row.roomId}:${row.id}` === key);
              if (saved && (saved.isFinal || saved.revision >= item.revision)) return old;
              const row: Row = { ...item, sourceLanguage, targetLanguage, roomId: current.roomId, speakerSide: side, translation: "", translationState: "pending", edited: false, createdAt: saved?.createdAt ?? Date.now(), local: true };
              return [...old.filter(value => `${value.roomId}:${value.id}` !== key), row].slice(-400);
            });
            if (!item.isFinal && Date.now() - (sent.current.get(key) ?? 0) < 700) return;
            sent.current.set(key, Date.now()); if (item.isFinal) sent.current.delete(key);
            const writes = pending.current.get(key) ?? new Set<Promise<unknown>>(); pending.current.set(key, writes);
            const write = action("caption", { ...item, sourceLanguage, speakerSide: side, generation: next.generation }, current, run).catch(e => fail(errorText(e), run)).finally(() => { writes.delete(write); if (!writes.size) pending.current.delete(key); });
            writes.add(write);
          }, onError: message => fail(tokenFailure || message, run), onStopped: () => fail(tokenFailure || "收音已停止，请重新开始。", run),
        });
        if (run !== epoch.current) { await client.stop(); return; }
        speech.current = client; setStatus("listening");
      } catch (e) { fail(tokenFailure || errorText(e), run); }
      finally { if (run !== epoch.current) selected?.stop(); }
    })();
    startup.current = work; void work.finally(() => { if (startup.current === work) startup.current = null; });
  }

  async function playEnglish(row: Row) {
    if (!englishVoice || typeof speechSynthesis === "undefined") { setError("本机没有可用的英文语音。请在系统语言设置中安装英语语音后刷新。"); return; }
    const stopped = halt(false), run = playback.current;
    await stopped.catch(e => { setError(errorText(e)); });
    if (!mounted.current || run !== playback.current || controller.current) return;
    const utterance = new SpeechSynthesisUtterance(row.translation); utterance.voice = englishVoice; utterance.lang = englishVoice.lang;
    utterance.onend = () => { if (run === playback.current && mounted.current) setSpeaking(false); };
    utterance.onerror = () => { if (run === playback.current && mounted.current) { setSpeaking(false); setError("本机朗读失败，可复制译文后重试。"); } };
    setSpeaking(true); setNotice("收音已暂停。本机播放不会自动传入会议麦克风，结束后请手动开始收音。"); speechSynthesis.speak(utterance);
  }
  async function copyTranslation(value: string) { try { await navigator.clipboard.writeText(value); setNotice("译文已复制。"); } catch { setError("无法访问剪贴板，请选中译文手动复制。"); } }

  useEffect(() => {
    mounted.current = true;
    request<{ speechReady: boolean }>("/api/config").then(value => { if (mounted.current) setConfigured(value.speechReady); }).catch(() => { if (mounted.current) { setConfigured(false); setError("服务状态检查失败，请刷新后重试。"); } });
    const updateVoices = () => { if (mounted.current && typeof speechSynthesis !== "undefined") setVoices(speechSynthesis.getVoices()); };
    updateVoices(); if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener("voiceschanged", updateVoices);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const leave = () => { cancelPlayback(); void stopLocal(); setStatus("paused"); void enqueue(pauseServer).catch(() => {}); };
    window.addEventListener("pagehide", leave);
    return () => { mounted.current = false; cancelPlayback(); void stopLocal(); clearInterval(timer); window.removeEventListener("pagehide", leave); if (typeof speechSynthesis !== "undefined") speechSynthesis.removeEventListener("voiceschanged", updateVoices); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Cleanup operations read current refs, not render state.
  }, []);
  useEffect(() => {
    if (status !== "listening" || !sessionRef.current) return;
    const current = sessionRef.current, run = epoch.current; let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const seq = ++sequence.current, data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(current.roomId)}`, undefined, current);
        if (cancelled || run !== epoch.current) return;
        if (data.room.generation < (roomRef.current?.generation ?? 0)) return;
        merge(data.room, seq, current.token);
        if (data.room.state !== "running") fail("会话已暂停或结束，收音已停止。请重新开始。", run);
      } catch (e) { if (!cancelled) fail(errorText(e), run); }
      finally { if (!cancelled && run === epoch.current) timer = setTimeout(poll, 1500); }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The connection epoch and current room are read from refs.
  }, [status, room?.id]);
  useEffect(() => { if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [rows]);

  const remaining = room ? Math.max(0, room.expiresAt - now) : null;
  const label = speaking ? "本机播放中 · 收音已暂停" : ({ idle: "准备就绪", starting: "正在连接音频…", listening: "正在收音", paused: "已暂停", stopped: "已停止" })[status];
  const originals = rows.filter(row => row.translationState === "done" && row.translation).map(row => row.translation).join("\n");
  return <main className={`meeting-shell ${active || room || rows.length ? "meeting-active" : ""}`}>
    <header className="meeting-header"><Link href="/" onClick={() => { void halt(true).catch(() => {}); }}><ArrowLeft size={17}/>返回语间</Link><span><Languages size={21}/> 语间 <small>会议字幕</small></span><span className="meeting-version">BETA</span></header>
    <section className="meeting-intro"><span className="eyebrow">LISTEN · UNDERSTAND · REPLY</span><h1>听懂会议，也说清想法。</h1><p>选择一个声音来源，原文与译文同步显示。支持中文、英语、日语和韩语。</p></section>
    <section className="meeting-settings" aria-label="翻译与音频设置">
      <div className="meeting-presets"><button onClick={() => change("en", "zh", "display")}><Headphones size={17}/><span>听老师<small>英语 → 中文 · 会议声音</small></span></button><button onClick={() => change("zh", "en", "microphone")}><Mic size={17}/><span>我发言<small>中文 → 英语 · 麦克风</small></span></button></div>
      <div className="meeting-selectors"><label>原文语言<select value={sourceLanguage} onChange={event => change(event.target.value as Language, targetLanguage)}>{LANGUAGE_CODES.map(value => <option key={value} value={value}>{LANGUAGE_NAMES[value]}</option>)}</select></label><button className="meeting-swap" aria-label="交换翻译方向" onClick={() => change(targetLanguage, sourceLanguage)}><ArrowLeftRight size={18}/></button><label>译文语言<select value={targetLanguage} onChange={event => change(sourceLanguage, event.target.value as Language)}>{LANGUAGE_CODES.map(value => <option key={value} value={value}>{LANGUAGE_NAMES[value]}</option>)}</select></label></div>
      <div className="meeting-inputs" aria-label="声音来源"><button aria-pressed={inputSource === "display"} onClick={() => change(sourceLanguage, targetLanguage, "display")}><MonitorUp size={18}/>标签页 / 电脑声音</button><button aria-pressed={inputSource === "microphone"} onClick={() => change(sourceLanguage, targetLanguage, "microphone")}><Mic size={18}/>我的麦克风</button></div>
      <p className="meeting-input-hint">{inputSource === "display" ? "点击开始后，选择正在播放会议的标签页，并勾选“共享音频”。窗口或整个屏幕能否共享声音取决于浏览器与系统。" : "只收取当前麦克风。建议佩戴耳机，减少会议外放再次进入麦克风。"}</p>
      {sourceLanguage === targetLanguage && <p className="meeting-input-hint">原文与译文语言相同，将显示原文。</p>}
      <div className="meeting-controls"><div className={`meeting-status ${status === "listening" ? "is-live" : ""}`} role="status"><span/>{label}</div><div>{active && <button className="button secondary" onClick={() => void halt(false).catch(e => setError(errorText(e)))}><Pause size={16}/>{status === "starting" ? "取消连接" : "暂停"}</button>}{!active && <button className="button primary" disabled={configured !== true} onClick={start}><Play size={17}/>{status === "paused" ? "继续收音" : "开始收音"}</button>}<button className="button end-button" disabled={!room && !active && !speaking} onClick={() => void halt(true).catch(e => setError(errorText(e)))}><Square size={14}/>停止</button></div></div>
      {configured === false && <p className="meeting-input-hint">语音服务暂不可用，请检查配置或刷新重试。</p>}
      <div className={`meeting-limit ${remaining !== null && remaining < 120000 ? "near-limit" : ""}`}>{remaining !== null ? <span>本房间剩余 <strong>{clock(remaining)}</strong></span> : <span>每个房间最长 30 分钟</span>}<span>每个房间最多 400 条字幕 · 停止后可重新开始</span></div>
    </section>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
    {notice && <p className="meeting-notice" role="status">{notice}</p>}
    <section className="meeting-transcript"><div className="meeting-transcript-heading"><div><h2>实时字幕</h2><p>同一句识别结果持续更新，句末确认后保留。</p></div><button className="recovery-button" disabled={!originals} onClick={() => void copyTranslation(originals)}><Copy size={15}/>复制全部译文</button></div><div className="meeting-columns"><span>原文</span><span>译文</span></div><div className="meeting-history" ref={transcript} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>{rows.length ? rows.map(row => <article className={`meeting-row ${row.isFinal ? "final" : "partial"}`} key={`${row.roomId}:${row.id}`}><div className="meeting-original"><div className="meeting-row-meta"><span>{LANGUAGE_NAMES[row.sourceLanguage]}</span><span>{row.isFinal ? <Check size={12}/> : <LoaderCircle className="spin" size={12}/>} {row.isFinal ? "已确认" : "识别中"}</span></div><p>{row.text}</p></div><div className="meeting-translation"><div className="meeting-row-meta"><span>{LANGUAGE_NAMES[row.targetLanguage]}</span>{row.translationState === "done" && <div><button aria-label="复制此句译文" onClick={() => void copyTranslation(row.translation)}><Copy size={14}/></button>{row.isFinal && row.targetLanguage === "en" && <button aria-label="本机播放英文译文" title={englishVoice ? "播放前暂停收音" : "本机未安装英文语音"} onClick={() => void playEnglish(row)}><Volume2 size={15}/></button>}</div>}</div><p className={row.translationState === "done" ? "" : "meeting-pending"}>{row.translationState === "done" ? row.translation : row.translationState === "error" ? "翻译失败，原文已保留。" : "正在翻译…"}</p></div></article>) : <div className="meeting-empty"><Languages size={34}/><h3>让每一句话都更清楚</h3><p>点击开始并允许音频访问，会议字幕将在这里出现。</p></div>}</div></section>
    <details id="meeting-help" className="meeting-playback-guide"><summary><Volume2 size={16}/>英文朗读与会议传声</summary><p>英文译文可手动使用本机英语语音播放，不调用 Azure 语音合成。{englishVoice ? `当前语音：${englishVoice.name}。` : "当前未检测到本机英语语音，可在系统语言设置中安装后刷新。"}</p><p>播放前会停止并等待收音关闭，播放结束不会自动恢复。<strong>本机播放 ≠ 会议麦克风。</strong>默认只有你的电脑能听见；若要让对方听见，需要自己设置虚拟音频设备，将浏览器输出路由到会议麦克风。本页不会自动配置或切换会议设备。</p></details>
    <footer className="meeting-footer">需要联网 · 切换到会议标签页可继续收音 · 关闭或刷新本页会停止收音并清空本页历史<br/>停止后字幕暂留本页，最多保留最近 400 条；请先复制需要的译文。</footer>
  </main>;
}
