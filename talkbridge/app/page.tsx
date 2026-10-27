"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, Globe2, HelpCircle, Languages, Link2, LoaderCircle, Mic, MicOff, Pause, Play, QrCode, Radio, RefreshCw, Settings2, ShieldCheck, Square, Users, X } from "lucide-react";
import type { Caption, Language, RoomSnapshot, Session } from "@/lib/types";
import { startSpeech } from "@/lib/speech";

import { LANGUAGE_CODES, LANGUAGE_NAMES, SPEECH_LOCALES, isLanguage } from "@/lib/languages";
import { words } from "@/lib/ui-copy";
type Lang = Language;
type DraftCaption = Caption & { roomId: string; generation: number; captureGeneration?: number; local: true };
type Timing = { translationMs: number | null; translationReused: boolean };
function localCapture(room: RoomSnapshot | null, role?: Session["role"]) {
  return { generation: room?.generation ?? 0, captureGeneration: (role === "host" ? room?.hostCaptureGeneration : room?.guestCaptureGeneration) ?? 0,
    listening: Boolean(role === "host" ? room?.hostListening : room?.guestListening) };
}
const durationMs = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const examples = [
  { zh: "你好，很高兴见到你。", ja: "こんにちは。お会いできてうれしいです。", ko: "안녕하세요. 만나서 반갑습니다.", en: "Hello. It's nice to meet you." },
  { zh: "我们找个安静的地方坐下聊吧。", ja: "静かなところで座って話しましょう。", ko: "조용한 곳에 앉아서 이야기해요.", en: "Let's sit somewhere quiet and talk." },
  { zh: "附近有一家很不错的咖啡馆。", ja: "近くに素敵なカフェがあります。", ko: "근처에 좋은 카페가 있어요.", en: "There's a lovely cafe nearby." },
  { zh: "太好了，我们现在过去吧。", ja: "いいですね。今から行きましょう。", ko: "좋아요. 지금 가요.", en: "Great. Let's go there now." },
];
function errorMessage(error: unknown, language: Lang) {
  const failure = error as { name?: string; message?: string };
  return failure.name === "TimeoutError" ? words[language].connectionTimeout : failure.name === "TypeError" ? words[language].connectFailed : failure.message || words[language].connectFailed;
}
async function request<T>(path: string, body?: Record<string, unknown>, session?: Session): Promise<T> {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(15000) });
  const result = await r.json() as T & { error?: string; errorJa?: string; errorKo?: string; errorEn?: string; code?: string };
  if (!r.ok) { const locale = document.documentElement.lang; const copy = words[isLanguage(locale) ? locale : "zh"]; throw Object.assign(new Error((locale === "en" ? result.errorEn : locale === "ko" ? result.errorKo : locale === "ja" ? result.errorJa : result.error) || copy.connectFailed), { status: r.status, code: result.code }); }
  return result;
}

export default function Home() {
  const [language, setLanguage] = useState<Lang>("zh");
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [configured, setConfigured] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [deviceMode, setDeviceMode] = useState<"paired" | "remote">("paired");
  const [code, setCode] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteHost, setInviteHost] = useState<Lang | null>(null);
  const [editing, setEditing] = useState<{ id: string; revision: number; text: string; original: string; roomId: string; token: string } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const editPending = useRef(false);
  const [modal, setModal] = useState<"share" | "settings" | "guide" | "end" | "edit" | null>(null);
  const [fontSize, setFontSize] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [online, setOnline] = useState(true);
  const [preview, setPreview] = useState(false);
  const [previewRunning, setPreviewRunning] = useState(false);
  const [previewCaptions, setPreviewCaptions] = useState<Caption[]>([]);
  const [qr, setQr] = useState("");
  const [origin, setOrigin] = useState("");
  const [listening, setListening] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [uncertain, setUncertain] = useState("");
  const [localCaptions, setLocalCaptions] = useState<DraftCaption[]>([]);
  const [speechHealth, setSpeechHealth] = useState<"ok" | "stalled">("ok");
  const [diagnostics, setDiagnostics] = useState<{ languageMs: number | null; translationMs: number | null; requestMs: number | null; syncMs: number | null; reused: boolean }>({ languageMs: null, translationMs: null, requestMs: null, syncMs: null, reused: false });
  const [now, setNow] = useState(Date.now());
  const speech = useRef<Awaited<ReturnType<typeof startSpeech>> | null>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef(room); roomRef.current = room;
  const sessionRef = useRef(session); sessionRef.current = session;
  const sendTimes = useRef(new Map<string, number>());
  const pendingCaptions = useRef(new Map<string, Set<Promise<unknown>>>());
  const lifecycle = useRef(0);
  const controlWork = useRef<Promise<void>>(Promise.resolve());
  const connecting = useRef(false);
  const operationCount = useRef(0);
  const speechAbort = useRef<AbortController | null>(null);
  const captureScope = useRef<{ roomId: string; generation: number; captureGeneration: number } | null>(null);
  const restoring = useRef(false);
  const sequence = useRef(0);
  const appliedSequence = useRef(0);
  const timingSequence = useRef(0);
  const cachedRoom = useRef("");
  const upperRef = useRef<HTMLDivElement>(null);
  const lowerRef = useRef<HTMLDivElement>(null);
  const t = words[language];
  const active = !!session || !!room || preview;
  const running = preview ? previewRunning : room?.state === "running";
  const isHost = session?.role === "host";
  const isRemote = room?.deviceMode === "remote";
  const remoteView = isRemote || (!active && deviceMode === "remote");
  const canRecord = isHost || isRemote;
  const ownCapture = localCapture(room, session?.role);
  const ownRunning = isRemote ? ownCapture.listening : running;
  const otherListening = isRemote && Boolean(isHost ? room?.guestListening : room?.hostListening);
  const isDemo = preview || room?.mode === "demo";
  const confirmed = room?.captions ?? [];
  const visibleDrafts = canRecord && !isDemo && ownRunning ? localCaptions.filter(draft => draft.roomId === room?.id && draft.generation === room.generation && (!isRemote || draft.captureGeneration === ownCapture.captureGeneration) && !confirmed.some(c => c.id === draft.id && (c.isFinal || c.revision >= draft.revision))) : [];
  const captions: (Caption & { local?: boolean })[] = preview ? previewCaptions : visibleDrafts.length ? [...confirmed.filter(c => !visibleDrafts.some(draft => draft.id === c.id)), ...visibleDrafts].sort((a,b) => a.createdAt - b.createdAt) : confirmed;
  const approved = room?.guestStatus === "approved";
  const invite = origin && room ? `${origin}/?join=${room.code}&host=${room.hostLanguage}${isRemote ? "&device=remote" : ""}` : "";
  const otherLanguage = room ? (isHost ? room.guestLanguage : room.hostLanguage) : preview ? (language === "ko" ? "zh" : language === "zh" ? "ja" : "zh") : null;
  const glyph = (lang: Lang | null) => lang === "zh" ? "中" : lang === "ja" ? "あ" : lang === "ko" ? "한" : lang === "en" ? "En" : "?";
  const otherName = otherLanguage ? LANGUAGE_NAMES[otherLanguage] : t.waitingLanguage;

  useEffect(() => {
    setOrigin(location.origin);
    const params = new URLSearchParams(location.search);
    const incoming = params.get("join")?.trim().toUpperCase();
    if (incoming) { setCode(incoming.toUpperCase()); setJoinOpen(true); if (params.get("device") === "remote") setDeviceMode("remote"); }
    try {
      const host = params.get("host");
      const hostLanguage = incoming && isLanguage(host) ? host : null;
      setInviteHost(hostLanguage);
      const preferred = params.get("lang") ?? localStorage.getItem("kotoba-language");
      setLanguage(isLanguage(preferred) && preferred !== hostLanguage ? preferred : LANGUAGE_CODES.find(value => value !== hostLanguage)!);
      const saved = sessionStorage.getItem("kotoba-session");
      if (saved) {
        const s = JSON.parse(saved) as Session;
        if (s.roomId && s.token && isLanguage(s.language) && (!incoming || s.code === incoming)) {
          restoring.current = true; setRecovering(true); setSession(s); setLanguage(s.language); setJoinOpen(false);
          const cached = JSON.parse(sessionStorage.getItem("kotoba-room") || "null") as RoomSnapshot | null;
          if (cached?.id === s.roomId) setRoom(cached);
        }
      }
    } catch { /* Storage is optional. */ }
    request<{ speechReady: boolean }>("/api/config").then(c => { setConfigured(c.speechReady); setMode(c.speechReady ? "live" : "demo"); }).catch(() => setError(words[isLanguage(document.documentElement.lang) ? document.documentElement.lang : "zh"].configFailed)).finally(() => setChecking(false));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); speechAbort.current?.abort(); void speech.current?.stop(); };
  }, []);
  useEffect(() => { document.documentElement.lang = language === "zh" ? "zh-CN" : language; try { localStorage.setItem("kotoba-language", language); } catch { /* Optional preference. */ } }, [language]);
  const saveSession = (s: Session) => { sessionRef.current = s; setSession(s); setLanguage(s.language); setRecovering(false); setSessionInvalid(false); try { sessionStorage.setItem("kotoba-session", JSON.stringify(s)); } catch { /* Session stays in memory. */ } };
  useEffect(() => {
    if (room && session?.roomId === room.id) {
      try {
        const value = JSON.stringify(room);
        if (value !== cachedRoom.current) { sessionStorage.setItem("kotoba-room", value); cachedRoom.current = value; }
      } catch { /* Server keeps the room captions until exit/expiry. */ }
    }
  }, [room, session]);
  useEffect(() => {
    setLocalCaptions(previous => {
      const remaining = previous.filter(draft => draft.roomId === room?.id && draft.generation === room.generation && room.state === "running" && (room.deviceMode !== "remote" || (ownCapture.listening && draft.captureGeneration === ownCapture.captureGeneration)) && !room.captions.some(c => c.id === draft.id && (c.isFinal || c.revision >= draft.revision)));
      return remaining.length === previous.length ? previous : remaining;
    });
  }, [room, ownCapture.listening, ownCapture.captureGeneration]);
  const applySnapshot = useCallback((next: RoomSnapshot, seq: number) => {
    if (sessionRef.current?.roomId !== next.id) return;
    setRoom(previous => {
      const sameGeneration = previous?.id === next.id && previous.generation === next.generation;
      const remote = sameGeneration && previous.deviceMode === "remote" && next.deviceMode === "remote";
      const captureAdvanced = remote && (next.hostCaptureGeneration > previous.hostCaptureGeneration || next.guestCaptureGeneration > previous.guestCaptureGeneration);
      if (previous?.id === next.id && (previous.generation > next.generation || (sameGeneration && ((remote && (next.hostCaptureGeneration < previous.hostCaptureGeneration || next.guestCaptureGeneration < previous.guestCaptureGeneration)) || (!captureAdvanced && seq < appliedSequence.current))))) return previous;
      appliedSequence.current = Math.max(appliedSequence.current, seq);
      if (previous?.id === next.id && previous.generation === next.generation) {
        // Requests can finish out of order; a newer poll must not downgrade a sentence.
        const currentCaptions = new Map(previous.captions.map(item => [item.id, item]));
        next = { ...next, captions: next.captions.map(caption => {
          const current = currentCaptions.get(caption.id);
          return current && (current.revision > caption.revision || (current.revision === caption.revision && current.translationState === "done" && caption.translationState !== "done")) ? current : caption;
        }) };
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (!session) return;
    let cancelled = false; let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const seq = ++sequence.current;
        const began = performance.now(); const run = lifecycle.current;
        const data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(session!.roomId)}`, undefined, session!);
        if (!cancelled) {
          if (run === lifecycle.current && sessionRef.current?.token === session!.token && data.room.mode === "live") setDiagnostics(previous => ({ ...previous, syncMs: durationMs(performance.now() - began) }));
          if (!connecting.current && (restoring.current || speechAbort.current?.signal.aborted)) {
            const own = localCapture(data.room, session!.role), remote = data.room.deviceMode === "remote";
            if (data.room.mode === "live" && (remote ? own.listening : session!.role === "host" && data.room.state === "running")) {
              const pausing = request<{room:RoomSnapshot}>("/api/room", { action:"pause", roomId:session!.roomId, ...(remote ? { generation: own.generation, captureGeneration: own.captureGeneration } : {}) }, session!);
              controlWork.current = Promise.allSettled([controlWork.current, pausing]).then(() => {});
              const paused = await pausing;
              if (!cancelled) { applySnapshot(paused.room, ++sequence.current); setToast(words[session!.language].restored); }
            } else applySnapshot(data.room, seq);
          } else applySnapshot(data.room, seq);
          if (!cancelled) { restoring.current = false; setRecovering(false); setSessionInvalid(false); setOnline(true); }
        }
      } catch (e) {
        if (!cancelled) {
          setOnline(false);
          setError(errorMessage(e, session!.language));
          const failure = e as { status?: number; code?: string };
          if ([401,404,410].includes(failure.status ?? 0) || (failure.status === 403 && failure.code === "UNAUTHORIZED")) setSessionInvalid(true);
        }
      } finally { if (!cancelled) timeout = setTimeout(poll, roomRef.current?.state === "running" ? 600 : 1500); }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timeout); };
  }, [session, applySnapshot]);
  const action = useCallback(async (name: string, extra: Record<string, unknown> = {}) => {
    const s = sessionRef.current; if (!s) return;
    const seq = ++sequence.current;
    const began = performance.now(); const run = lifecycle.current;
    const current = roomRef.current;
    const own = localCapture(current, s.role);
    const controls = current?.deviceMode === "remote" && ["start", "pause", "caption", "discard-caption"].includes(name) ? { generation: own.generation, captureGeneration: own.captureGeneration } : {};
    const data = await request<{ room: RoomSnapshot; timing?: Timing }>("/api/room", { action: name, roomId: s.roomId, ...controls, ...extra }, s);
    if (run === lifecycle.current && sessionRef.current?.token === s.token && data.room.mode === "live" && ["caption", "edit-caption", "retry-translation"].includes(name) && seq >= timingSequence.current) {
      timingSequence.current = seq;
      setDiagnostics(previous => ({ ...previous, requestMs: durationMs(performance.now() - began), translationMs: durationMs(data.timing?.translationMs), reused: data.timing?.translationReused === true }));
    }
    applySnapshot(data.room, seq);
    if (run === lifecycle.current && sessionRef.current?.token === s.token) setLocalCaptions(previous => previous.filter(draft => draft.roomId !== data.room.id || draft.generation !== data.room.generation || !data.room.captions.some(c => c.id === draft.id && (c.isFinal || c.revision >= draft.revision))));
    return data.room;
  }, [applySnapshot]);
  const pauseRemote = useCallback(() => {
    if (roomRef.current?.deviceMode === "remote") {
      const s = sessionRef.current;
      // A background/stop event may arrive while start is in flight. Stop the resulting own stream.
      const paused = controlWork.current.then(async () => {
        if (!s || sessionRef.current?.token !== s.token) return;
        const data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(s.roomId)}`, undefined, s);
        if (sessionRef.current?.token !== s.token) return;
        const own = localCapture(data.room, s.role);
        if (!own.listening || data.room.state === "ended") { applySnapshot(data.room, ++sequence.current); return data.room; }
        return action("pause", { generation: own.generation, captureGeneration: own.captureGeneration });
      });
      controlWork.current = paused.then(() => {}, () => {});
      return paused;
    }
    const paused = action("pause");
    // A later reconnect must not race a delayed stop request from this connection.
    controlWork.current = Promise.allSettled([controlWork.current, paused]).then(() => {});
    return paused;
  }, [action, applySnapshot]);
  const perform = async (fn: () => Promise<unknown>) => { operationCount.current++; setBusy(true); setError(""); try { await fn(); } catch (e) { setError(errorMessage(e, language)); } finally { if (--operationCount.current === 0) setBusy(false); } };
  const updateLevel = useCallback((value: number) => {
    volumeRef.current?.style.setProperty("--mic-level", String(value));
  }, []);
  const stopLocal = useCallback(() => {
    lifecycle.current++;
    connecting.current = false;
    speechAbort.current?.abort();
    void speech.current?.stop();
    speech.current = null;
    captureScope.current = null;
    setListening(false); updateLevel(0); setUncertain(""); setLocalCaptions([]); setSpeechHealth("ok");
  }, [updateLevel]);
  function refresh() {
    // Do not await network/SDK callbacks, or erase the session needed to recover this room.
    stopLocal();
    setRecovering(true);
    location.reload();
  }
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(""), 3500); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(".modal");
    dialog?.querySelector<HTMLElement>(modal === "edit" ? "textarea" : "button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !editPending.current) setModal(null);
      if (event.key === "Tab" && dialog) {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled)'));
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("keydown", keys); previous?.focus(); };
  }, [modal]);
  useEffect(() => {
    if (modal !== "share" || !invite) return;
    let live = true;
    import("qrcode").then(q => q.toDataURL(invite, { width: 240, margin: 2, color: { dark: "#252347", light: "#ffffff" } })).then(url => { if (live) setQr(url); }).catch(() => setError(t.qrFailed));
    return () => { live = false; };
  }, [modal, invite]);
  useEffect(() => {
    if (!preview || !previewRunning) return;
    let index = previewCaptions.length;
    const append = () => { const row = examples[index % examples.length]; const sourceLanguage = index % 2 ? language : otherLanguage!; const targetLanguage = sourceLanguage === language ? otherLanguage! : language; const item = { sourceLanguage, text: row[sourceLanguage], translation: row[targetLanguage], edited: false }; const n = index++; setPreviewCaptions(c => [...c.slice(-19), { ...item, id: `preview-${n}-${Date.now()}`, revision: 1, isFinal: true, translationState: "done", createdAt: Date.now() }]); };
    if (!index) append(); const timer = setInterval(append, 3400); return () => clearInterval(timer);
    // A pause/restart creates a new demo sequence timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, previewRunning]);
  useEffect(() => {
    if (!isHost || room?.mode !== "demo" || room.state !== "running" || !online) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { await action("demo-next", { expectedDemoIndex: roomRef.current?.demoIndex }); } catch (e) { if (!cancelled && (e as {code:string}).code !== "STALE_UPDATE") setError(errorMessage(e, language)); } finally { if (!cancelled) timer = setTimeout(tick, 2100); } };
    timer = setTimeout(tick, 500); return () => { cancelled = true; clearTimeout(timer); };
  }, [isHost, room?.mode, room?.state, online, action]);
  useEffect(() => {
    const staleCapture = isRemote && captureScope.current && (captureScope.current.roomId !== room?.id || captureScope.current.generation !== room.generation || captureScope.current.captureGeneration !== ownCapture.captureGeneration);
    if (((room?.state !== "running" || !online || (isRemote && (!ownCapture.listening || staleCapture))) && !connecting.current) || room?.state === "ended" || room?.state === "waiting") stopLocal();
  }, [room?.state, room?.generation, ownCapture.captureGeneration, ownCapture.listening, isRemote, online, stopLocal]);
  useEffect(() => {
    const interrupt = () => { if (document.visibilityState === "hidden" && (speechAbort.current || (roomRef.current?.deviceMode === "remote" && connecting.current))) { stopLocal(); void pauseRemote().catch(() => {}); } };
    document.addEventListener("visibilitychange", interrupt); return () => document.removeEventListener("visibilitychange", interrupt);
  }, [pauseRemote, stopLocal]);
  useEffect(() => {
    if (!running || !listening) return;
    let lock: WakeLockSentinel | null = null; let cancelled = false;
    navigator.wakeLock?.request("screen").then(value => { if (cancelled) void value.release(); else lock = value; }).catch(() => setToast(t.keepAwake));
    return () => { cancelled = true; void lock?.release(); };
  }, [running, listening, language]);
  useEffect(() => { for (const el of [upperRef.current, lowerRef.current]) if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 220) {
    const latest = el.lastElementChild as HTMLElement | null;
    el.scrollTop = latest && latest.offsetHeight > el.clientHeight ? el.scrollTop + latest.getBoundingClientRect().top - el.getBoundingClientRect().top : el.scrollHeight;
  } }, [captions]);

  async function create() { await perform(async () => { const data = await request<{ session: Session; room: RoomSnapshot }>("/api/room", { action: "create", language, mode: deviceMode === "remote" ? "live" : mode, deviceMode }); setPreview(false); setPreviewRunning(false); saveSession(data.session); setRoom(data.room); setOnline(true); setModal("share"); }); }
  async function join() {
    if (!/^[A-F0-9]{8}$/.test(code.trim().toUpperCase())) { setError(t.invalidCode); return; }
    await perform(async () => { const data = await request<{ session: Session; room: RoomSnapshot }>("/api/room", { action: "join", code: code.trim().toUpperCase(), language }); setPreview(false); setPreviewRunning(false); saveSession(data.session); setRoom(data.room); setOnline(true); setJoinOpen(false); history.replaceState(null, "", "/"); });
  }
  async function start(reconnect = false) {
    if (preview) { setPreviewRunning(true); return; }
    const previous = controlWork.current;
    stopLocal(); const run = lifecycle.current; connecting.current = true;
    setDiagnostics({ languageMs: null, translationMs: null, requestMs: null, syncMs: null, reused: false });
    const work = perform(async () => {
      // One startup at a time: a replacement waits for the cancelled request to finish.
      await previous;
      if (run !== lifecycle.current) return;
      const owner = sessionRef.current!;
      let latest = roomRef.current;
      const remote = latest?.deviceMode === "remote";
      if (reconnect && remote) {
        const data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(owner.roomId)}`, undefined, owner);
        if (run !== lifecycle.current) return;
        latest = data.room; applySnapshot(latest, ++sequence.current);
        const own = localCapture(latest, owner.role);
        if (own.listening) latest = await action("pause", { generation: own.generation, captureGeneration: own.captureGeneration }) ?? latest;
        if (run !== lifecycle.current) return;
      } else if (reconnect) { await action("pause"); if (run !== lifecycle.current) return; }
      const expected = localCapture(latest, owner.role);
      const next = await action("start", remote ? { generation: expected.generation, captureGeneration: expected.captureGeneration } : {});
      if (run !== lifecycle.current || !next || next.mode !== "live") return;
      const generation = next.generation;
      const captureGeneration = localCapture(next, owner.role).captureGeneration;
      if (remote) captureScope.current = { roomId: next.id, generation, captureGeneration };
      speechAbort.current = new AbortController();
      const controller = speechAbort.current;
      const stopOnError = (message: string) => { if (run !== lifecycle.current || controller.signal.aborted) return; setError(message); stopLocal(); void pauseRemote().catch(() => {}); };
      try {
        const client = await startSpeech({
          signal: speechAbort.current.signal,
          languages: [next.hostLanguage, next.guestLanguage!], uiLanguage: language,
          ...(remote ? { sourceLanguage: owner.language } : {}),
          getToken: async () => request("/api/speech-token", { roomId: owner.roomId, ...(remote ? { generation, captureGeneration } : {}) }, owner),
          onCaption: incoming => {
            if (run !== lifecycle.current) return;
            const item = remote ? { ...incoming, id: `${owner.role === "host" ? "h" : "g"}-${captureGeneration}-${incoming.id}`, speakerSide: (owner.role === "host" ? "a" : "b") as "a" | "b" } : incoming;
            if (!item.text || (!item.sourceLanguage && item.isFinal)) {
              setUncertain(item.text); sendTimes.current.delete(item.id);
              setLocalCaptions(previous => previous.filter(draft => draft.id !== item.id));
              void Promise.allSettled([...(pendingCaptions.current.get(item.id) ?? [])]).then(() => { if (run === lifecycle.current) return action("discard-caption", { id:item.id, revision:item.revision, generation, ...(remote ? { captureGeneration } : {}) }); }).catch(() => {});
              return;
            }
            if (!item.sourceLanguage) { setUncertain(item.text); return; }
            const saved = roomRef.current?.captions.find(c => c.id === item.id);
            if (saved?.isFinal) return;
            setUncertain(""); const last = sendTimes.current.get(item.id) ?? 0;
            if (!item.isFinal && Date.now() - last < 700) return;
            sendTimes.current.set(item.id, Date.now()); if (item.isFinal) sendTimes.current.delete(item.id);
            setLocalCaptions(previous => {
              const existing = previous.find(draft => draft.id === item.id);
              if (existing && existing.revision >= item.revision) return previous;
              const draft: DraftCaption = { ...item, sourceLanguage: item.sourceLanguage!, isFinal: false, edited: false, translation: "", translationState: "pending", createdAt: existing?.createdAt ?? saved?.createdAt ?? Date.now(), roomId: next.id, generation, ...(remote ? { captureGeneration } : {}), local: true };
              return [...previous.filter(c => c.id !== item.id), draft].slice(-400);
            });
            const pending = pendingCaptions.current.get(item.id) ?? new Set<Promise<unknown>>();
            pendingCaptions.current.set(item.id, pending);
            const work = action("caption", { ...item, generation, ...(remote ? { captureGeneration } : {}) }).catch(e => { if (run === lifecycle.current) { setError(errorMessage(e, language)); setLocalCaptions(previous => previous.filter(draft => draft.id !== item.id || draft.revision > item.revision)); } }).finally(() => { pending.delete(work); if (!pending.size) pendingCaptions.current.delete(item.id); });
            pending.add(work);
          }, onLevel: updateLevel, onError: stopOnError,
          onHealth: value => { if (run === lifecycle.current && !controller.signal.aborted) setSpeechHealth(value); },
          onTiming: sample => { if (run === lifecycle.current && !controller.signal.aborted) setDiagnostics(previous => ({ ...previous, languageMs: durationMs(sample.languageWaitMs) })); },
          onStopped: () => stopOnError(t.speechStopped),
        });
        if (run !== lifecycle.current) { await client.stop(); return; } speech.current = client; restoring.current = false; setListening(true); setRecovering(false); setOnline(true);
      } catch (e) { stopOnError((e as Error).message); }
    });
    controlWork.current = work.finally(() => { if (run === lifecycle.current) connecting.current = false; });
    await work;
  }
  async function reconnect() {
    if (sessionRef.current?.role === "host" || roomRef.current?.deviceMode === "remote") { await start(true); return; }
    stopLocal();
    await perform(async () => {
      const s = sessionRef.current; if (!s) return;
      const seq = ++sequence.current;
      const data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(s.roomId)}`, undefined, s);
      applySnapshot(data.room, seq); setRecovering(false); setOnline(true);
    });
  }
  async function pause() { if (preview) { setPreviewRunning(false); return; } stopLocal(); await perform(pauseRemote); }
  async function end() {
    setModal(null); stopLocal();
    if (preview || room?.state === "ended" || sessionInvalid) { reset(); return; }
    const s = sessionRef.current; if (!s) return;
    await perform(async () => {
      await request("/api/room", { action: s.role === "guest" ? "leave" : "end", roomId: s.roomId }, s);
      reset();
    });
  }
  function reset() { stopLocal(); setDiagnostics({ languageMs: null, translationMs: null, requestMs: null, syncMs: null, reused: false }); sessionRef.current = null; restoring.current = false; setRecovering(false); setSessionInvalid(false); setRoom(null); setSession(null); setPreview(false); setPreviewRunning(false); setPreviewCaptions([]); setEditing(null); setModal(null); setEditError(""); setInviteHost(null); setError(""); setOnline(true); history.replaceState(null, "", "/"); try { sessionStorage.removeItem("kotoba-session"); sessionStorage.removeItem("kotoba-room"); } catch { /* Optional. */ } }
  function openEdit(caption: Caption) {
    const s = sessionRef.current;
    if (!s || !caption.isFinal || caption.sourceLanguage !== s.language || roomRef.current?.state === "ended") return;
    setEditing({ id: caption.id, revision: caption.revision, text: caption.text, original: caption.text, roomId: s.roomId, token: s.token });
    setEditError(""); setModal("edit");
  }
  async function saveEdit() {
    const s = sessionRef.current, draft = editing;
    if (!draft || editPending.current) return;
    const current = roomRef.current?.captions.find(c => c.id === draft.id);
    if (!s || s.roomId !== draft.roomId || s.token !== draft.token || roomRef.current?.state === "ended" || !current?.isFinal || current.sourceLanguage !== s.language) { setEditError(t.editUnavailable); return; }
    const value = draft.text.trim();
    if (!value || value.length > 1000) { setEditError(t.editInvalid); return; }
    if (value === draft.original) { setModal(null); setEditing(null); return; }
    editPending.current = true; setEditSaving(true); setEditError("");
    try {
      await action("edit-caption", { id: draft.id, revision: draft.revision, text: value });
      if (sessionRef.current?.roomId === draft.roomId && sessionRef.current?.token === draft.token) { setModal(null); setEditing(null); }
    } catch (e) {
      if (sessionRef.current?.roomId === draft.roomId && sessionRef.current?.token === draft.token) {
        setEditError(errorMessage(e, language));
        if ((e as { code?: string }).code === "STALE_UPDATE") {
          try {
            const seq = ++sequence.current;
            const data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(s.roomId)}`, undefined, s);
            applySnapshot(data.room, seq);
            const latest = data.room.captions.find(c => c.id === draft.id);
            if (sessionRef.current?.roomId === draft.roomId && sessionRef.current?.token === draft.token && latest?.isFinal && latest.sourceLanguage === s.language) {
              setEditing(current => current?.id === draft.id ? { ...current, revision: latest.revision, original: latest.text } : current);
              setEditError(t.editConflict);
            }
          } catch { /* Keep the draft and original error; the next retry may recover. */ }
        }
      }
    } finally { editPending.current = false; setEditSaving(false); }
  }
  const editable = !!session && !sessionInvalid && room?.state !== "ended";
  const closeModal = () => { if (!editPending.current) setModal(null); };
  const needsReconnect = canRecord && room?.mode === "live" && ownRunning && !listening;
  const status = recovering ? (t.restoring) : !online ? t.network : needsReconnect ? (busy ? (t.connectingMic) : (t.needsReconnect)) : preview ? (previewRunning ? t.sample : t.paused) : isRemote && room?.state !== "ended" && approved ? (listening ? t.remoteListening : otherListening ? t.otherListening : t.remoteReady) : room ? ({ waiting: t.waiting, ready: t.ready, running: t.running, paused: t.paused, ended: t.ended })[room.state] : t.prepare;
  const duration = room?.startedAt ? Math.max(0, Math.floor((now - room.startedAt) / 1000)) : 0;
  const elapsed = `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`;
  const renderCaptions = (self: boolean) => {
    const list = captions.filter(c => (c.sourceLanguage === language) === self);
    return list.length ? list.map(c => {
      const translation = c.translationState === "done" ? c.translation : c.translationState === "error" ? t.failedTranslation : t.translating;
      return <article key={c.id} className={`caption ${c.isFinal ? "final" : "partial"}`}>
        <div className="caption-meta"><span>{LANGUAGE_NAMES[c.sourceLanguage]} {c.edited && <span className="edited-badge">{t.edited}</span>}</span><span>{c.isFinal ? <Check size={12}/> : <LoaderCircle size={12} className="spin"/>}{c.local ? t.localDraft : !c.isFinal ? t.partial : new Date(c.createdAt).toLocaleTimeString(SPEECH_LOCALES[language], { hour: "2-digit", minute: "2-digit" })}</span></div>
        <p className="caption-main">{self ? c.text : translation}</p>
        <p className="caption-secondary">{self ? translation : c.text}</p>
        {self && c.isFinal && !c.local && editable && <div className="caption-actions"><button onClick={() => openEdit(c)} disabled={editSaving}>{t.edit}</button>{c.translationState === "error" && <button disabled={busy} onClick={() => void perform(() => action("retry-translation", { id: c.id, revision: c.revision }))}><RefreshCw size={13}/>{t.retryTranslation}</button>}</div>}
      </article>;
    }) : <div className="empty-caption"><span className="empty-symbol">{self ? <Mic size={25}/> : <Languages size={28}/>}</span><h3>{self ? t.emptySelf : t.emptyOther}</h3><p>{active ? t.hint : t.emptyHint}</p></div>;
  };

  return <div className="app-shell" style={{ "--caption-scale": [1, 1.22, 1.42][fontSize] } as React.CSSProperties}>
    <header className="topbar"><a href="/" className="brand" aria-label={`Kotoba · ${t.leave}`} onClick={e => { if (active && room?.state !== "ended") { e.preventDefault(); setModal("end"); } }}><span className="brand-mark"><Languages size={23}/></span><span>语间<span className="brand-latin">kotoba</span></span><span className="beta">BETA</span></a><nav><span className="header-description">中文 <span>·</span> 日本語 <span>·</span> 한국어 <span>·</span> English</span><button className="icon-button" onClick={() => setModal("guide")} aria-label={t.config}><HelpCircle size={20}/></button><button className="ui-language" onClick={() => { if (!active) { const allowed = LANGUAGE_CODES.filter(value => !joinOpen || value !== inviteHost); setLanguage(allowed[(allowed.indexOf(language) + 1) % allowed.length]); } else setModal("settings"); }}><Globe2 size={16}/>{LANGUAGE_NAMES[language]}<ChevronDown size={13}/></button></nav></header>
    <div className="session-tools">{!active && <><a className="recovery-button" href="/solo">{{ zh: "单手机面对面", ja: "スマホ1台で対話", ko: "휴대폰 한 대로 대화", en: "One-phone conversation" }[language]}<ArrowRight size={15}/></a><a className="recovery-button" href="/meeting">{{ zh: "会议翻译", ja: "会議の翻訳", ko: "회의 번역", en: "Meeting translation" }[language]}<ArrowRight size={15}/></a></>}{session && room?.state !== "ended" && <button className="recovery-button" onClick={() => void reconnect()}><Radio size={15}/>{t.reconnect}</button>}<button className="recovery-button" onClick={refresh}><RefreshCw size={15}/>{t.refresh}</button>{active && <button className="recovery-button exit-session" onClick={() => setModal("end")}>{t.exitSession}</button>}</div>
    <div className="workspace"><aside className={`sidebar ${active ? "compact-mobile" : ""}`}>
      <div className="sidebar-heading"><span className="eyebrow"><span className="tiny-dot"/> {remoteView ? "REMOTE CONVERSATION" : "FACE TO FACE"}</span><h1>{t.headline}<br/><em>{t.headlineAccent}</em></h1><p>{remoteView ? t.remoteIntro : joinOpen ? t.shareHint : t.subintro}</p></div>
      {!active ? <div className="setup-card">{!joinOpen && <><label className="field-label">{t.deviceMode}</label><div className="language-options device-mode-options" role="group" aria-label={t.deviceMode}>{(["paired", "remote"] as const).map(value => <button key={value} aria-pressed={deviceMode === value} className={deviceMode === value ? "selected" : ""} onClick={() => { setDeviceMode(value); if (value === "remote") setMode("live"); }}>{value === "remote" ? t.remoteMode : t.pairedMode}</button>)}</div>{deviceMode === "remote" && <p className="remote-mode-hint">{t.remoteHint}</p>}</>}<label className="field-label">{t.language}</label><div className="language-options">{LANGUAGE_CODES.map(value => <button key={value} className={language === value ? "selected" : ""} disabled={joinOpen && value === inviteHost} onClick={() => setLanguage(value)}><span className="lang-glyph">{glyph(value)}</span>{LANGUAGE_NAMES[value]}{language === value && <Check size={14}/>}</button>)}</div>
        {joinOpen && inviteHost && <p className="invite-language-hint">{t.hostLanguage}：{LANGUAGE_NAMES[inviteHost]} · {t.chooseOther}</p>}
        {joinOpen ? <form onSubmit={e => { e.preventDefault(); void join(); }}><label className="field-label" htmlFor="room-code">{t.code}</label><input id="room-code" value={code} onChange={e => { setCode(e.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase()); setInviteHost(null); }} maxLength={8} autoComplete="off" placeholder={t.codeHint} required/><button className="button primary" disabled={busy || checking || language === inviteHost}>{busy ? <LoaderCircle className="spin" size={18}/> : <Link2 size={18}/>} {t.join}<ArrowRight size={17}/></button><button type="button" className="button text-button" onClick={() => setJoinOpen(false)}>{t.create}</button></form> : <><button className="button primary" disabled={busy || checking || (deviceMode === "remote" && !configured)} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={18}/> : <Users size={18}/>} {t.create}<ArrowRight size={17}/></button><button className="button secondary" onClick={() => setJoinOpen(true)}><Link2 size={17}/>{t.join}</button>{deviceMode === "remote" ? <p className="remote-mode-hint">{configured ? t.remoteAudioNote : t.remoteUnavailable}</p> : <div className="mode-select"><button className={mode === "demo" ? "on" : ""} onClick={() => setMode("demo")}>{t.demo}</button><button disabled={!configured} className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>{t.live}{!configured && <span> · {t.notConfigured}</span>}</button></div>}</>}
      </div> : <div className="room-card"><div className="field-label">{preview ? t.demo : t.code}<span className="mode-pill">{isRemote ? t.remoteMode : isDemo ? t.demo : t.live}</span></div><div className="room-number">{preview ? "PREVIEW" : room?.code}<button className="icon-button" disabled={preview} onClick={() => setModal("share")} aria-label={t.share}><QrCode size={20}/></button></div><div className="participants"><div><span className="person-icon">{glyph(language)}</span><span>{t.host}<small>{LANGUAGE_NAMES[language]}</small></span><span className="online-dot"/></div><div><span className="person-icon lilac">{glyph(otherLanguage)}</span><span>{t.guest}<small>{preview ? t.sample : approved ? otherName : t.waiting}</small></span><span className={`online-dot ${preview || (isHost ? room?.guestOnline && approved : room?.hostOnline) ? "" : "offline"}`}/></div></div>{!preview && room?.state !== "ended" && <button className="button secondary" onClick={() => setModal("share")}><QrCode size={17}/>{t.share}</button>}{room?.state === "ended" && <button className="button secondary" onClick={reset}>{t.leave}</button>}</div>}
      <div className="how-it-works" hidden={joinOpen}><span className="eyebrow">{t.howTitle}</span>{[t.step1,remoteView ? t.remoteStep2 : t.step2,t.step3].map((value, i) => <div key={value}><span>{i + 1}</span>{value}</div>)}</div><div className="sidebar-bottom"><ShieldCheck size={17}/><p>{t.noRecording}<span>{t.clearAfter}</span></p><button className="icon-button" aria-label={t.config} onClick={() => setModal("guide")}><ArrowUpRight size={17}/></button></div>
    </aside><main className="conversation"><div className="conversation-heading"><div><span className="eyebrow">LIVE CONVERSATION</span><h2>{remoteView ? t.remoteMode : joinOpen ? t.join : t.conversationTitle}</h2></div><button className="settings-button" onClick={() => setModal("settings")}><Settings2 size={17}/><span>{t.settings}</span></button></div>
      {!configured && !checking && <div className="notice"><span className="notice-dot"/>{t.unconfigured}<button onClick={() => setModal("guide")}>{t.learnMore}<ArrowUpRight size={12}/></button></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label={t.close} onClick={() => setError("")}><X size={16}/></button></div>}
      {session && (recovering || !online || !room) && <div className="recovery-notice" role="status"><LoaderCircle size={18} className={sessionInvalid ? "" : "spin"}/><div><strong>{sessionInvalid ? t.expired : recovering ? t.restoring : t.network}</strong><p>{sessionInvalid ? t.rejoin : isRemote ? t.remoteHint : t.recoveryHint}</p></div></div>}
      {isRemote && <div className="remote-status" role="status"><span><Mic size={14}/>{listening ? t.remoteListening : t.remoteStopped}</span><span><Radio size={14}/>{otherListening ? t.otherListening : t.otherStopped}</span><p>{t.remoteAudioNote}</p></div>}
      <div className="caption-stage"><section className="caption-panel opponent"><div className="panel-heading"><div><span className="speaker-avatar">{glyph(otherLanguage)}</span><span>{t.theirs}<small>{otherName} → {LANGUAGE_NAMES[language]}</small></span></div><span className="panel-tag">{t.translationFirst}</span></div><div className="caption-scroll" ref={upperRef} aria-label={t.theirs}>{renderCaptions(false)}</div></section><div className="divider"><Languages size={16}/></div><section className="caption-panel self"><div className="panel-heading"><div><span className="speaker-avatar">{glyph(language)}</span><span>{t.mine}<small>{LANGUAGE_NAMES[language]} → {otherName}</small></span></div><span className="panel-tag">{t.originalFirst}</span></div><div className="caption-scroll" ref={lowerRef} aria-label={t.mine}>{renderCaptions(true)}</div></section></div>
      {canRecord && !isDemo && ownRunning && listening && online && speechHealth === "stalled" && <div className="speech-warning" role="status"><div><strong>{t.speechStalled}</strong><p>{t.speechStalledHint}</p></div><button className="recovery-button" disabled={busy} onClick={() => void reconnect()}><RefreshCw size={15}/>{t.reconnect}</button></div>}
      {uncertain && <div className="uncertain" role="status">{t.uncertain} {uncertain}</div>}
      <div className="control-bar"><div className="connection-state"><span className={`status-orb ${ownRunning && online ? "active" : ""} ${!online ? "disconnected" : ""}`}><Radio size={18}/></span><div><strong role="status">{status}</strong><small>{active ? (isDemo ? t.demoNote : isRemote ? t.remoteHint : isHost ? t.mic : t.remoteMic) : t.hint}</small></div></div><div className="control-actions">{room?.startedAt && <span className="elapsed">{elapsed}</span>}{listening && <div className="volume-bars" ref={volumeRef} aria-label={t.volume}>{[0,1,2,3,4].map(i => <span key={i} style={{ height: `calc(6px + min(18px, var(--mic-level, 0) * ${24 + i * 7}px))` }}/>)}</div>}
        {!active ? <button className="button primary" onClick={() => { setPreview(true); setPreviewRunning(true); setPreviewCaptions([]); }}><Play size={16}/>{t.quick}</button> : room?.state === "ended" ? <button className="button secondary" onClick={reset}>{t.leave}</button> : <>{ownRunning && !needsReconnect ? <button className="button secondary" disabled={busy || !online} onClick={() => void pause()}><Pause size={17}/>{isRemote ? t.remotePause : t.pause}</button> : (canRecord || preview) ? <button className="button primary" disabled={busy || recovering || !online || (!preview && !approved)} onClick={() => void (needsReconnect ? reconnect() : start())}>{busy ? <LoaderCircle size={17} className="spin"/> : <Play size={17}/>} {needsReconnect ? t.reconnect : isRemote ? t.remoteStart : room?.state === "paused" || preview ? t.resume : t.start}</button> : <span className="guest-wait">{t.waitHost}</span>}<button className="button end-button" onClick={() => setModal("end")}><Square size={14}/>{session?.role === "guest" ? t.exit : t.end}</button></>}
      </div></div><div className="stage-footnote"><span><MicOff size={12}/>{t.subtitleOnly}</span><span>{isRemote ? t.remoteMapping : t.mapping}</span></div>
    </main></div>
    <footer className="page-footer"><span>语间 kotoba</span><span>{t.footer}</span><span>V0.7 · 中文 / 日本語 / 한국어 / English</span></footer>
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
    {modal && <div className="modal-backdrop" onClick={closeModal}><section className={`modal ${modal === "edit" ? "edit-modal" : ""}`} role="dialog" aria-modal="true" aria-label={modal === "edit" ? t.editTitle : modal === "share" ? t.share : modal === "settings" ? t.settings : modal === "end" ? t.end : t.config} onClick={e => e.stopPropagation()}><button className="modal-close icon-button" disabled={editSaving} aria-label={t.close} onClick={closeModal}><X size={20}/></button>
      {modal === "share" && <><span className="modal-icon"><QrCode size={26}/></span><h2>{t.share}</h2><p>{t.shareHint}</p><div className="qr-box">{qr ? <img src={qr} alt={t.qrAlt} width={220} height={220}/> : <LoaderCircle className="spin"/>}</div><div className="share-code">{room?.code}</div><button className="button primary" onClick={() => void perform(async () => { await navigator.clipboard.writeText(invite); setToast(t.copied); })}><Copy size={17}/>{t.copyInvite}</button><input className="invite-url" aria-label={t.inviteLabel} readOnly value={invite} onFocus={e => e.target.select()}/><p className="small-note">{t.auth}</p></>}
      {modal === "settings" && <><span className="modal-icon"><Settings2 size={26}/></span><h2>{t.settings}</h2><label className="field-label">{t.font}</label><div className="font-options">{[t.regular,t.large,t.extra].map((value,i) => <button key={i} className={i === fontSize ? "selected" : ""} onClick={() => setFontSize(i)}><span style={{fontSize:18+i*4}}>Aa</span>{value}</button>)}</div><p className="small-note">{isRemote ? t.remoteMapping : t.mapping}</p><div className="setting-detail"><Languages size={20}/><div>{t.layoutHint}<small>{t.layoutDetail}</small></div></div><details className="diagnostics"><summary>{t.diagnostics}</summary><p>{t.diagnosticsHint}</p><dl><div><dt>{t.languageDelay}</dt><dd>{canRecord && !isDemo && diagnostics.languageMs !== null ? `${diagnostics.languageMs} ms` : t.noTiming}</dd></div><div><dt>{t.providerDelay}</dt><dd>{canRecord && !isDemo && diagnostics.reused ? t.translationReused : canRecord && !isDemo && diagnostics.translationMs !== null ? `${diagnostics.translationMs} ms` : t.noTiming}</dd></div><div><dt>{t.requestDelay}</dt><dd>{canRecord && !isDemo && diagnostics.requestMs !== null ? `${diagnostics.requestMs} ms` : t.noTiming}</dd></div><div><dt>{t.syncDelay}</dt><dd>{!isDemo && diagnostics.syncMs !== null ? `${diagnostics.syncMs} ms` : t.noTiming}</dd></div></dl><p>{t.diagnosticsPrivacy}</p></details></>}
      {modal === "end" && <><span className="modal-icon"><Square size={24}/></span><h2>{t.exitSession}</h2><p>{sessionInvalid ? t.expiredExit : session?.role === "guest" ? t.guestExit : t.endConfirm}</p><button className="button primary" onClick={() => void end()}>{sessionInvalid ? t.exitHome : session?.role === "guest" ? t.exitClear : t.confirm}</button><button className="button secondary" onClick={closeModal}>{t.cancel}</button></>}
      {modal === "guide" && <><span className="modal-icon"><Languages size={26}/></span><h2>{t.guideTitle}</h2><div className="guide-content"><h3>{t.guideDemoTitle}</h3><p>{t.guideDemo}</p><h3>{isRemote ? t.remoteMode : t.guideLiveTitle}</h3><p>{isRemote ? t.remoteHint : t.guideLive}</p>{isRemote && <p>{t.remoteAudioNote}</p>}<h3>{t.guideMicTitle}</h3><p>{isRemote ? t.remoteAudioNote : t.guideMic}</p><h3>{t.editTitle}</h3><p>{t.editHint}</p><p className="small-note">{t.auth}</p><a href="/SETUP.html" target="_blank" rel="noreferrer" className="guide-link">{t.guideLink}<ArrowUpRight size={16}/></a></div></>}
      {modal === "edit" && editing && <><h2>{t.editTitle}</h2><p>{t.editHint}</p><label className="field-label" htmlFor="caption-edit">{LANGUAGE_NAMES[language]}</label><textarea id="caption-edit" aria-describedby="edit-help" value={editing.text} maxLength={1000} rows={5} disabled={editSaving} onChange={e => setEditing(current => current ? { ...current, text: e.target.value } : null)}/><p className="edit-current">{t.currentOriginal}：{editing.original}</p><p id="edit-help" className="edit-help">{editing.text.length} / 1000{isDemo && <span>{t.editDemo}</span>}</p>{editError && <p className="edit-error" role="alert">{editError}</p>}{!editable && <p className="edit-error" role="alert">{t.editUnavailable}</p>}<button className="button primary" disabled={editSaving || !editable || !editing.text.trim()} onClick={() => void saveEdit()}>{editSaving && <LoaderCircle size={16} className="spin"/>}{editSaving ? t.saving : t.saveEdit}</button><button className="button secondary" disabled={editSaving} onClick={closeModal}>{t.cancelEdit}</button></>}
      <button className="button text-button" onClick={refresh}><RefreshCw size={15}/>{t.refresh}</button>
    </section></div>}
  </div>;
}
