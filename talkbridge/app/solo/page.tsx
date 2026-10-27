"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Languages, LoaderCircle, Mic, Pause, Play, RefreshCw, RotateCw, Square, X } from "lucide-react";
import type { Caption, Language, RoomSnapshot, Session } from "@/lib/types";
import { startSpeech } from "@/lib/speech";
import { LANGUAGE_CODES, LANGUAGE_NAMES, SPEECH_LOCALES, isLanguage } from "@/lib/languages";
import { words } from "@/lib/ui-copy";

const copy = {
  en: { title: "One phone, face to face", intro: "Place the phone between you. It listens, separates speakers, and translates. An internet connection is required.", paired: "Two-phone mode", setupA: "A · Bottom of the screen", setupB: "B · Top of the screen", readsA: "For A · What B said", readsB: "For B · What A said", create: "Start a one-phone conversation", guide: "Each time you start or reconnect, A should say one complete sentence first, then B. Take turns and avoid speaking together.", identity: "A / B are voice labels for this listening session only. Reconnecting assigns them again; voiceprints are not saved.", flip: "Rotate the upper panel", unknown: "Speaker not yet identified", unknownHint: "Wait for the sentence to finish before assigning it. A third speaker or unclear voice may remain here.", assignA: "Assign to A", assignB: "Assign to B", speaker: "Who said this?", listen: "Waiting to start listening", empty: "Your partner's translation will appear here", editHint: "Editing the original text or speaker translates the sentence again.", expired: "This session is invalid. End it and start again.", back: "End and go back", noSpeaker: "Unassigned", demo: "The demo shows captions and layout only. It does not test speaker recognition.", same: "Both participants chose the same language. Original text will be shown with separate speaker labels.", ready: "One-phone conversation ready", single: "One phone · Online", original: "Original", invalid: "This is not a one-phone session. Please return home." },
  zh: { title: "一部手机，面对面聊", intro: "把手机放在两人之间，自动收音、区分发言人并翻译。需要联网。", paired: "双手机模式", setupA: "A · 靠近手机下方", setupB: "B · 面对手机上方", readsA: "给 A 看 · B 说的话", readsB: "给 B 看 · A 说的话", create: "进入单手机对话", guide: "每次开始或重连：请 A 先说完整一句，再由 B 接话。轮流说话，避免同时开口。", identity: "A / B 仅是本次收音的人声标签；重连会重新分配，不保存声纹。", flip: "旋转上半屏", unknown: "说话人未确定", unknownHint: "等一句说完再确认归属；第三个人或不清晰的声音可能留在这里。", assignA: "改为 A 说", assignB: "改为 B 说", speaker: "这句话是谁说的？", listen: "等待开始收音", empty: "对方说话后，译文会显示在这里", editHint: "修正原文或发言人后，会重新翻译。", expired: "会话已失效，请结束后重新开始。", back: "结束并返回", noSpeaker: "待确认", demo: "演示仅展示字幕与分区，不验证人声识别。", same: "双方选择了同一种语言，将保留原文并区分发言人。", ready: "单手机已就绪", single: "单手机 · 在线", original: "原文", invalid: "这不是单手机会话，请返回首页。" },
  ja: { title: "スマホ1台で、向かい合って話す", intro: "2人の間にスマホを置くだけ。音声を聞き取り、話者を分けて翻訳します。通信が必要です。", paired: "スマホ2台モード", setupA: "A · 画面の下側", setupB: "B · 画面の上側", readsA: "A の画面 · B の発言", readsB: "B の画面 · A の発言", create: "1台で会話を始める", guide: "開始・再接続のたびに、A が先に1文話し、その後 B が話してください。重ならず交互に話しましょう。", identity: "A / B は今回の音声セッション内の話者ラベルです。再接続で再割当てされ、声紋は保存しません。", flip: "上半分を回転", unknown: "話者を確認中", unknownHint: "文が確定したら話者を修正できます。3人目や不明瞭な音声はここに残る場合があります。", assignA: "A の発言に変更", assignB: "B の発言に変更", speaker: "誰の発言ですか？", listen: "音声の開始を待っています", empty: "相手が話すと、ここに翻訳が表示されます", editHint: "原文や話者を修正すると、もう一度翻訳します。", expired: "セッションが無効です。終了してやり直してください。", back: "終了して戻る", noSpeaker: "未確認", demo: "デモは字幕と配置の見本です。話者認識のテストではありません。", same: "同じ言語を選択したため、原文を表示して話者を分けます。", ready: "1台での会話準備完了", single: "スマホ1台 · オンライン", original: "原文", invalid: "1台モードのセッションではありません。ホームに戻ってください。" },
  ko: { title: "휴대폰 한 대로 마주 보고 대화", intro: "두 사람 사이에 휴대폰을 놓으세요. 음성을 듣고 화자를 구분해 번역합니다. 인터넷 연결이 필요합니다.", paired: "휴대폰 두 대 모드", setupA: "A · 화면 아래쪽", setupB: "B · 화면 위쪽", readsA: "A의 화면 · B가 한 말", readsB: "B의 화면 · A가 한 말", create: "한 대로 대화 시작하기", guide: "시작하거나 다시 연결할 때마다 A가 먼저 한 문장을 말한 뒤 B가 이어 말해 주세요. 동시에 말하지 말고 번갈아 말해 주세요.", identity: "A / B는 이번 수음 세션의 화자 표시입니다. 다시 연결하면 새로 지정하며 성문을 저장하지 않습니다.", flip: "화면 위쪽 회전", unknown: "화자 확인 중", unknownHint: "문장이 완성되면 화자를 수정할 수 있습니다. 제삼자나 불명확한 음성은 여기에 남을 수 있습니다.", assignA: "A의 발언으로 변경", assignB: "B의 발언으로 변경", speaker: "누가 한 말인가요?", listen: "수음 시작 대기 중", empty: "상대방이 말하면 여기에 번역이 나타납니다", editHint: "원문이나 화자를 수정하면 다시 번역합니다.", expired: "세션이 만료되었습니다. 종료한 뒤 다시 시작해 주세요.", back: "종료하고 돌아가기", noSpeaker: "미확인", demo: "데모는 자막과 화면 배치 예시입니다. 화자 인식 테스트가 아닙니다.", same: "같은 언어를 선택해 원문을 표시하고 화자를 구분합니다.", ready: "한 대로 대화할 준비 완료", single: "휴대폰 한 대 · 온라인", original: "원문", invalid: "한 대 모드의 세션이 아닙니다. 홈으로 돌아가 주세요." },
};
type Side = "a" | "b";
type Draft = Caption & { local: true; generation: number };
type Edit = { id: string; revision: number; text: string; original: string; side: Side | null; originalSide: Side | null; roomId: string; token: string };
const SESSION_KEY = "kotoba-solo-session", ROOM_KEY = "kotoba-solo-room";

async function request<T>(path: string, language: Language, body?: Record<string, unknown>, session?: Session): Promise<T> {
  const response = await fetch(path, { method: body ? "POST" : "GET", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(15000) });
  const data = await response.json() as T & { error?: string; errorJa?: string; errorKo?: string; errorEn?: string; code?: string };
  if (!response.ok) throw Object.assign(new Error((language === "en" ? data.errorEn : language === "ko" ? data.errorKo : language === "ja" ? data.errorJa : data.error) || words[language].connectFailed), { status: response.status, code: data.code });
  return data;
}
function errorText(error: unknown, language: Language) {
  const failure = error as { name?: string; message?: string };
  return failure.name === "TimeoutError" ? words[language].connectionTimeout : failure.name === "TypeError" ? words[language].connectFailed : failure.message || words[language].connectFailed;
}

export default function Solo() {
  const [language, setLanguage] = useState<Language>("zh");
  const [otherLanguage, setOtherLanguage] = useState<Language>("ko");
  const [mode, setMode] = useState<"live" | "demo">("demo");
  const [configured, setConfigured] = useState(false);
  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [rotated, setRotated] = useState(true);
  const [fontSize, setFontSize] = useState(1);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [uncertain, setUncertain] = useState("");
  const [health, setHealth] = useState<"ok" | "stalled">("ok");
  const [editing, setEditing] = useState<Edit | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const roomRef = useRef(room); roomRef.current = room;
  const sessionRef = useRef(session); sessionRef.current = session;
  const speech = useRef<Awaited<ReturnType<typeof startSpeech>> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0), sequence = useRef(0), applied = useRef(0), operations = useRef(0);
  const connecting = useRef(false), restoring = useRef(false), editPending = useRef(false);
  const controlWork = useRef<Promise<void>>(Promise.resolve());
  const sends = useRef(new Map<string, { at: number; side: Side | null | undefined }>());
  const pending = useRef(new Map<string, Set<Promise<unknown>>>());
  const upper = useRef<HTMLDivElement>(null), lower = useRef<HTMLDivElement>(null);
  const t = words[language], s = copy[language];
  const active = !!session, running = room?.state === "running", demo = room?.mode === "demo";
  const confirmed = room?.captions ?? [];
  const local = running ? drafts.filter(d => d.generation === room.generation && !confirmed.some(c => c.id === d.id && (c.isFinal || c.revision >= d.revision))) : [];
  const captions: (Caption & { local?: boolean })[] = [...confirmed.filter(c => !local.some(d => d.id === c.id)), ...local].sort((a, b) => a.createdAt - b.createdAt);
  const unknown = captions.filter(c => !c.speakerSide);

  const stopLocal = useCallback(() => {
    epoch.current++; connecting.current = false;
    controller.current?.abort(); controller.current = null;
    void speech.current?.stop(); speech.current = null;
    setListening(false); setDrafts([]); setUncertain(""); setHealth("ok");
  }, []);
  const apply = useCallback((next: RoomSnapshot, seq: number, token: string) => {
    if (sessionRef.current?.token !== token || sessionRef.current.roomId !== next.id) return;
    setRoom(previous => {
      if (previous?.id === next.id && (previous.generation > next.generation || (previous.generation === next.generation && seq < applied.current))) return previous;
      applied.current = seq;
      if (previous?.id === next.id && previous.generation === next.generation) {
        const old = new Map(previous.captions.map(c => [c.id, c]));
        next = { ...next, captions: next.captions.map(c => { const saved = old.get(c.id); return saved && (saved.revision > c.revision || (saved.revision === c.revision && saved.translationState === "done" && c.translationState !== "done")) ? saved : c; }) };
      }
      return next;
    });
  }, []);
  const action = useCallback(async (name: string, body: Record<string, unknown> = {}) => {
    const current = sessionRef.current; if (!current) throw new Error("Missing session");
    const seq = ++sequence.current;
    const result = await request<{ room: RoomSnapshot }>("/api/room", current.language, { action: name, roomId: current.roomId, ...body }, current);
    apply(result.room, seq, current.token);
    return result.room;
  }, [apply]);
  const perform = async (work: () => Promise<unknown>) => {
    operations.current++; setBusy(true); setError("");
    try { await work(); } catch (e) { setError(errorText(e, language)); }
    finally { if (--operations.current === 0) setBusy(false); }
  };
  function pauseRemote() {
    const work = controlWork.current.then(() => action("pause"));
    controlWork.current = work.then(() => {}, () => {});
    return work;
  }

  useEffect(() => {
    try {
      const preferred = localStorage.getItem("kotoba-language"); if (isLanguage(preferred)) { setLanguage(preferred); setOtherLanguage(preferred === "ko" ? "zh" : "ko"); }
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as Session | null;
      const cached = JSON.parse(sessionStorage.getItem(ROOM_KEY) || "null") as RoomSnapshot | null;
      if (saved?.roomId && saved.token && saved.role === "host" && isLanguage(saved.language)) {
        restoring.current = true; setRecovering(true); setSession(saved); setLanguage(saved.language);
        if (cached?.id === saved.roomId && cached.deviceMode === "solo") { setRoom(cached); if (cached.guestLanguage) setOtherLanguage(cached.guestLanguage); }
      }
    } catch { /* Storage is optional. */ }
    request<{ speechReady: boolean }>("/api/config", "zh").then(config => { setConfigured(config.speechReady); setMode(config.speechReady ? "live" : "demo"); }).catch(() => setError(words.zh.configFailed)).finally(() => setChecking(false));
    return () => { epoch.current++; controller.current?.abort(); void speech.current?.stop(); };
  }, []);
  useEffect(() => { document.documentElement.lang = language === "zh" ? "zh-CN" : language; }, [language]);
  useEffect(() => {
    if (session && room?.id === session.roomId) {
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); sessionStorage.setItem(ROOM_KEY, JSON.stringify(room)); } catch { /* The server remains authoritative. */ }
    }
    setDrafts(previous => previous.filter(d => room?.state === "running" && d.generation === room.generation && !room.captions.some(c => c.id === d.id && (c.isFinal || c.revision >= d.revision))));
  }, [session, room]);
  useEffect(() => {
    if (!session) return;
    let cancelled = false, expired = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const seq = ++sequence.current;
        const data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(session!.roomId)}`, session!.language, undefined, session!);
        if (cancelled) return;
        if (data.room.deviceMode !== "solo") { expired = true; setInvalid(true); setError(copy[session!.language].invalid); stopLocal(); return; }
        if (!connecting.current && !speech.current && data.room.mode === "live" && data.room.state === "running" && data.room.generation >= (roomRef.current?.generation ?? 0)) {
          // A refresh or network recovery never silently restarts the microphone.
          const pausing = pauseRemote(); const paused = await pausing;
          if (!cancelled) apply(paused, ++sequence.current, session!.token);
        } else apply(data.room, seq, session!.token);
        if (!cancelled) { restoring.current = false; setRecovering(false); setOnline(true); setOtherLanguage(data.room.guestLanguage!); }
      } catch (e) {
        if (!cancelled) {
          setOnline(false); setError(errorText(e, session!.language)); stopLocal();
          if ([401, 403, 404, 410].includes((e as { status?: number }).status ?? 0)) { expired = true; setInvalid(true); }
        }
      } finally { if (!cancelled && !expired) timer = setTimeout(poll, roomRef.current?.state === "running" ? 600 : 1500); }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [session, apply, stopLocal]);
  useEffect(() => {
    if (!connecting.current && (room?.state !== "running" || !online)) stopLocal();
  }, [room?.state, online, stopLocal]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden" && (controller.current || connecting.current)) { stopLocal(); void pauseRemote().catch(() => {}); } };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [stopLocal, action]);
  useEffect(() => {
    if (!running || !listening) return;
    let lock: WakeLockSentinel | null = null, cancelled = false;
    navigator.wakeLock?.request("screen").then(value => { if (cancelled) void value.release(); else lock = value; }).catch(() => {});
    return () => { cancelled = true; void lock?.release(); };
  }, [running, listening]);
  useEffect(() => {
    if (!demo || !running || !online) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try { await action("demo-next", { expectedDemoIndex: roomRef.current?.demoIndex }); }
      catch (e) { if (!cancelled && (e as { code?: string }).code !== "STALE_UPDATE") setError(errorText(e, language)); }
      finally { if (!cancelled) timer = setTimeout(tick, 2100); }
    }
    timer = setTimeout(tick, 500); return () => { cancelled = true; clearTimeout(timer); };
  }, [demo, running, online, action, language]);
  useEffect(() => {
    for (const el of [upper.current, lower.current]) if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      const latest = el.lastElementChild as HTMLElement | null;
      // offsetTop is in the scroll container's coordinates, including the rotated upper panel.
      el.scrollTop = latest && latest.offsetHeight > el.clientHeight ? latest.offsetTop : el.scrollHeight;
    }
  }, [captions]);
  useEffect(() => {
    if (!editing && !confirmEnd) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>(".solo-modal");
    modal?.querySelector<HTMLElement>(editing ? "textarea" : "button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !editPending.current) { setEditing(null); setConfirmEnd(false); }
      if (event.key === "Tab" && modal) {
        const items = Array.from(modal.querySelectorAll<HTMLElement>("button:not(:disabled),textarea:not(:disabled),select:not(:disabled)"));
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", keys); return () => { document.removeEventListener("keydown", keys); previous?.focus(); };
  }, [!!editing, confirmEnd]);

  async function create() {
    await perform(async () => {
      const data = await request<{ session: Session; room: RoomSnapshot }>("/api/room", language, { action: "create", deviceMode: "solo", language, otherLanguage, mode });
      sessionRef.current = data.session; setSession(data.session); setRoom(data.room); setOnline(true); setInvalid(false);
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data.session)); sessionStorage.setItem(ROOM_KEY, JSON.stringify(data.room)); } catch { /* Optional. */ }
    });
  }
  async function start() {
    const prior = controlWork.current;
    stopLocal(); const run = epoch.current; connecting.current = true;
    const work = perform(async () => {
      await prior; if (run !== epoch.current) return;
      if (roomRef.current?.state === "running") { await action("pause"); if (run !== epoch.current) return; }
      const next = await action("start");
      if (run !== epoch.current || next.mode !== "live") return;
      const abort = new AbortController(); controller.current = abort;
      const fail = (message: string) => {
        if (run !== epoch.current || abort.signal.aborted) return;
        setError(message); stopLocal(); void pauseRemote().catch(() => {});
      };
      try {
        const client = await startSpeech({ diarization: true, languages: [next.hostLanguage, next.guestLanguage!], uiLanguage: language, signal: abort.signal,
          getToken: () => { const current = sessionRef.current!; return request("/api/speech-token", current.language, { roomId: current.roomId }, current); },
          onCaption: item => {
            if (run !== epoch.current || abort.signal.aborted) return;
            if (!item.text || (!item.sourceLanguage && item.isFinal)) {
              setUncertain(item.text); sends.current.delete(item.id); setDrafts(previous => previous.filter(d => d.id !== item.id));
              void Promise.allSettled([...(pending.current.get(item.id) ?? [])]).then(() => { if (run === epoch.current) return action("discard-caption", { id: item.id, generation: next.generation }); }).catch(() => {});
              return;
            }
            if (!item.sourceLanguage) { setUncertain(item.text); return; }
            const saved = roomRef.current?.captions.find(c => c.id === item.id); if (saved?.isFinal) return;
            setUncertain("");
            setDrafts(previous => {
              const old = previous.find(c => c.id === item.id); if (old && old.revision >= item.revision) return previous;
              return [...previous.filter(c => c.id !== item.id), { ...item, sourceLanguage: item.sourceLanguage!, isFinal: false, edited: false, translation: "", translationState: "pending" as const, targetLanguage: item.speakerSide === "a" ? next.guestLanguage : item.speakerSide === "b" ? next.hostLanguage : null, createdAt: old?.createdAt ?? saved?.createdAt ?? Date.now(), generation: next.generation, local: true as const }].slice(-400);
            });
            const last = sends.current.get(item.id);
            if (!item.isFinal && last && last.side === item.speakerSide && Date.now() - last.at < 700) return;
            sends.current.set(item.id, { at: Date.now(), side: item.speakerSide }); if (item.isFinal) sends.current.delete(item.id);
            const writes = pending.current.get(item.id) ?? new Set<Promise<unknown>>(); pending.current.set(item.id, writes);
            const write = action("caption", { ...item, generation: next.generation }).catch(e => {
              if (run === epoch.current) { setError(errorText(e, language)); setDrafts(previous => previous.filter(d => d.id !== item.id || d.revision > item.revision)); }
            }).finally(() => { writes.delete(write); if (!writes.size) pending.current.delete(item.id); });
            writes.add(write);
          }, onError: fail, onStopped: () => fail(t.speechStopped), onHealth: value => { if (run === epoch.current) setHealth(value); },
        });
        if (run !== epoch.current) { await client.stop(); return; }
        speech.current = client; setListening(true); setOnline(true); setRecovering(false);
      } catch (e) { fail(errorText(e, language)); }
    });
    controlWork.current = work.finally(() => { if (run === epoch.current) connecting.current = false; });
    await work;
  }
  async function pause() { stopLocal(); await perform(pauseRemote); }
  function refresh() { stopLocal(); location.reload(); }
  function reset() {
    stopLocal(); sessionRef.current = null; setSession(null); setRoom(null); setInvalid(false); setRecovering(false); setOnline(true); setError(""); setEditing(null); setConfirmEnd(false);
    try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(ROOM_KEY); } catch { /* Optional. */ }
  }
  async function end() {
    stopLocal(); setConfirmEnd(false);
    if (invalid || room?.state === "ended") { reset(); return; }
    await perform(async () => { await controlWork.current; await action("end"); reset(); });
  }
  function openEdit(caption: Caption) {
    const current = sessionRef.current;
    if (!current || !caption.isFinal || invalid || roomRef.current?.state === "ended") return;
    setEditing({ id: caption.id, revision: caption.revision, text: caption.text, original: caption.text, side: caption.speakerSide ?? null, originalSide: caption.speakerSide ?? null, roomId: current.roomId, token: current.token }); setEditError("");
  }
  async function saveEdit() {
    const edit = editing, current = sessionRef.current;
    if (!edit || editPending.current) return;
    if (!current || current.token !== edit.token || current.roomId !== edit.roomId || roomRef.current?.state === "ended" || invalid) { setEditError(t.editUnavailable); return; }
    const value = edit.text.trim(); if (!value || value.length > 1000) { setEditError(t.editInvalid); return; }
    if (value === edit.original && edit.side === edit.originalSide) { setEditing(null); return; }
    editPending.current = true; setEditSaving(true); setEditError("");
    try {
      await action("edit-caption", { id: edit.id, revision: edit.revision, text: value, ...(edit.side ? { speakerSide: edit.side } : {}) });
      if (sessionRef.current?.token === edit.token) setEditing(null);
    } catch (e) {
      if (sessionRef.current?.token === edit.token) {
        setEditError(errorText(e, language));
        if ((e as { code?: string }).code === "STALE_UPDATE") {
          try {
            const seq = ++sequence.current, data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(current.roomId)}`, language, undefined, current);
            apply(data.room, seq, current.token); const latest = data.room.captions.find(c => c.id === edit.id);
            if (sessionRef.current?.token === edit.token && latest?.isFinal) { setEditing(old => old?.id === edit.id ? { ...old, revision: latest.revision, original: latest.text, originalSide: latest.speakerSide ?? null } : old); setEditError(t.editConflict); }
          } catch { /* Keep the user's draft for retry. */ }
        }
      }
    } finally { editPending.current = false; setEditSaving(false); }
  }
  const editable = active && !invalid && (room?.state === "running" || room?.state === "paused");
  function renderCaption(caption: Caption & { local?: boolean }) {
    const translation = !caption.speakerSide ? s.unknown : caption.translationState === "done" ? caption.translation : caption.translationState === "error" ? t.failedTranslation : t.translating;
    return <article key={caption.id} className={`caption ${caption.isFinal ? "final" : "partial"}`}>
      <div className="caption-meta"><span>{caption.speakerSide?.toUpperCase() ?? s.noSpeaker} · {LANGUAGE_NAMES[caption.sourceLanguage]}{caption.edited && <span className="edited-badge">{t.edited}</span>}</span><span>{caption.isFinal ? <Check size={12}/> : <LoaderCircle size={12} className="spin"/>}{caption.local ? t.localDraft : !caption.isFinal ? t.partial : new Date(caption.createdAt).toLocaleTimeString(SPEECH_LOCALES[language], { hour: "2-digit", minute: "2-digit" })}</span></div>
      <p className="caption-main">{caption.speakerSide ? translation : caption.text}</p>
      {caption.speakerSide && <p className="caption-secondary">{caption.text}</p>}
      {caption.isFinal && !caption.local && editable && <div className="caption-actions"><button onClick={() => openEdit(caption)} disabled={editSaving}>{t.edit}</button>{!caption.speakerSide && ["a", "b"].map(side => <button key={side} disabled={busy || editSaving} onClick={() => void perform(() => action("edit-caption", { id: caption.id, revision: caption.revision, text: caption.text, speakerSide: side }))}>{side === "a" ? s.assignA : s.assignB}</button>)}{caption.translationState === "error" && <button disabled={busy} onClick={() => void perform(() => action("retry-translation", { id: caption.id, revision: caption.revision }))}>{t.retryTranslation}</button>}</div>}
    </article>;
  }
  function panel(side: Side) {
    const list = captions.filter(c => c.speakerSide === side), viewer = side === "a" ? "B" : "A";
    const target = side === "a" ? room?.guestLanguage ?? otherLanguage : room?.hostLanguage ?? language;
    return <section className={`caption-panel solo-panel ${side === "a" ? "opponent" : "self"} ${side === "a" && rotated ? "rotated" : ""}`} aria-label={side === "a" ? s.readsB : s.readsA}>
      <div className="panel-heading"><div><span className="speaker-avatar">{viewer}</span><span>{side === "a" ? s.readsB : s.readsA}<small>{LANGUAGE_NAMES[target]} · {t.translationFirst}</small></span></div><span className="panel-tag">{side.toUpperCase()} → {viewer}</span></div>
      <div className="caption-scroll" ref={side === "a" ? upper : lower}>{list.length ? list.map(renderCaption) : <div className="empty-caption"><Languages size={26}/><h3>{s.empty}</h3></div>}</div>
    </section>;
  }
  const status = invalid ? s.expired : recovering ? t.restoring : !online ? t.network : !room ? t.prepare : room.state === "ready" ? s.ready : room.state === "running" ? (demo ? t.demoNote : listening ? t.running : busy ? t.connectingMic : t.needsReconnect) : room.state === "ended" ? t.ended : t.paused;

  return <main className={`solo-shell ${active ? "solo-active" : ""}`} style={{ "--caption-scale": [1, 1.2, 1.4][fontSize] } as React.CSSProperties}>
    <header className="solo-header"><a href="/" onClick={event => { if (active && room?.state !== "ended") { event.preventDefault(); setConfirmEnd(true); } }}><ArrowLeft size={17}/>{s.paired}</a><span><Languages size={18}/>语间 <small>{s.single}</small></span><button className="recovery-button" onClick={refresh} aria-label={t.refresh}><RefreshCw size={16}/>{t.refresh}</button></header>
    {!active && <section className="solo-setup"><span className="eyebrow">ONE PHONE · TWO VOICES</span><h1>{s.title}</h1><p>{s.intro}</p><div className="solo-language-grid">{(["a", "b"] as const).map(side => <label key={side}>{side === "a" ? s.setupA : s.setupB}<select value={side === "a" ? language : otherLanguage} onChange={event => { const value = event.target.value; if (isLanguage(value)) side === "a" ? setLanguage(value) : setOtherLanguage(value); }}>{LANGUAGE_CODES.map(value => <option key={value} value={value}>{LANGUAGE_NAMES[value]}</option>)}</select></label>)}</div>{language === otherLanguage && <p className="solo-hint">{s.same}</p>}<div className="mode-select"><button className={mode === "live" ? "on" : ""} disabled={!configured || checking} onClick={() => setMode("live")}>{t.live}{!configured && ` · ${t.notConfigured}`}</button><button className={mode === "demo" ? "on" : ""} onClick={() => setMode("demo")}>{t.demo}</button></div><button className="button primary" disabled={busy || checking} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={18}/> : <Mic size={18}/>} {s.create}</button><p className="solo-hint">{s.guide}</p></section>}
    {!active && <a className="recovery-button" href="/meeting">{{ zh: "会议翻译", ja: "会議の翻訳", ko: "회의 번역", en: "Meeting translation" }[language]}</a>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label={t.close} onClick={() => setError("")}><X size={16}/></button></div>}
    <div className="solo-display-tools"><button className="recovery-button" aria-pressed={rotated} onClick={() => setRotated(value => !value)}><RotateCw size={16}/>{s.flip}</button><label>{t.font}<select value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>{[t.regular, t.large, t.extra].map((name, i) => <option key={name} value={i}>{name}</option>)}</select></label></div>
    <div className="caption-stage solo-stage">{panel("a")}<div className="solo-divider"><Mic size={16}/><span>{demo ? t.demo : s.single}</span></div>{panel("b")}</div>
    {(unknown.length > 0 || uncertain) && <section className="solo-unknown" aria-label={s.unknown}><h2>{s.unknown}</h2><p>{s.unknownHint}</p><div>{unknown.map(renderCaption)}{uncertain && <p className="caption-secondary">{t.uncertain} {uncertain}</p>}</div></section>}
    {active && <div className="solo-controls"><div className="solo-status" role="status"><span className={`tiny-dot ${listening ? "listening" : ""}`}/>{status}</div><div className="solo-control-buttons">{invalid || room?.state === "ended" ? <button className="button secondary" onClick={reset}>{t.leave}</button> : <>{running && (demo || listening) ? <button className="button secondary" disabled={busy || !online} onClick={() => void pause()}><Pause size={17}/>{t.pause}</button> : <button className="button primary" disabled={busy || recovering || !online || !room} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" size={17}/> : <Play size={17}/>} {running ? t.reconnect : room?.state === "paused" ? t.resume : t.start}</button>}{running && listening && <button className="recovery-button" disabled={busy} onClick={() => void start()}><RefreshCw size={16}/>{t.reconnect}</button>}<button className="button end-button" onClick={() => setConfirmEnd(true)}><Square size={14}/>{t.end}</button></>}</div></div>}
    {active && <p className="solo-hint solo-live-hint">{demo ? s.demo : s.guide}</p>}
    {listening && health === "stalled" && <div className="speech-warning" role="status"><div><strong>{t.speechStalled}</strong><p>{t.speechStalledHint}</p></div><button className="recovery-button" disabled={busy} onClick={() => void start()}>{t.reconnect}</button></div>}
    <footer className="solo-footer"><p>{s.identity}</p><p>{t.noRecording} · {t.clearAfter}</p><span>V0.6 · 中文 / 日本語 / 한국어 / English</span></footer>
    {(editing || confirmEnd) && <div className="modal-backdrop"><section className={`modal solo-modal ${editing ? "edit-modal" : ""}`} role="dialog" aria-modal="true" aria-label={editing ? t.editTitle : t.end}><button className="modal-close icon-button" disabled={editSaving} aria-label={t.close} onClick={() => { if (!editPending.current) { setEditing(null); setConfirmEnd(false); } }}><X size={20}/></button>{editing ? <><h2>{t.editTitle}</h2><p>{s.editHint}</p><label className="field-label" htmlFor="solo-caption-edit">{s.original}</label><textarea id="solo-caption-edit" value={editing.text} rows={4} maxLength={1000} disabled={editSaving} onChange={event => setEditing(value => value ? { ...value, text: event.target.value } : null)}/><p className="edit-current">{t.currentOriginal}：{editing.original}</p><label className="solo-speaker-select">{s.speaker}<select disabled={editSaving} value={editing.side ?? ""} onChange={event => setEditing(value => value ? { ...value, side: event.target.value as Side } : null)}>{!editing.side && <option value="" disabled>{s.noSpeaker}</option>}<option value="a">A · {LANGUAGE_NAMES[room?.hostLanguage ?? language]}</option><option value="b">B · {LANGUAGE_NAMES[room?.guestLanguage ?? otherLanguage]}</option></select></label>{editError && <p className="edit-error" role="alert">{editError}</p>}{!editable && <p className="edit-error">{t.editUnavailable}</p>}<button className="button primary" disabled={editSaving || !editable || !editing.text.trim()} onClick={() => void saveEdit()}>{editSaving ? t.saving : t.saveEdit}</button><button className="button secondary" disabled={editSaving} onClick={() => setEditing(null)}>{t.cancelEdit}</button></> : <><h2>{t.end}</h2><p>{invalid ? s.expired : t.endConfirm}</p><button className="button primary" onClick={() => void end()}>{t.confirm}</button><button className="button secondary" onClick={() => setConfirmEnd(false)}>{t.cancel}</button></>}</section></div>}
  </main>;
}
