"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, Globe2, HelpCircle, Languages, Link2, LoaderCircle, Mic, MicOff, Pause, Play, QrCode, Radio, Settings2, ShieldCheck, Square, Users, X } from "lucide-react";
import type { Caption, RoomSnapshot, Session } from "@/lib/types";
import { startSpeech } from "@/lib/speech";

type Lang = "zh" | "ja";
const examples = [
  { sourceLanguage: "ja" as Lang, text: "こんにちは。お会いできてうれしいです。", translation: "你好，很高兴见到你。" },
  { sourceLanguage: "zh" as Lang, text: "我也是。我们找个安静的地方坐下聊吧。", translation: "私もです。静かなところで座って話しましょう。" },
  { sourceLanguage: "ja" as Lang, text: "いいですね。近くに素敵なカフェがあります。", translation: "好呀。附近有一家很不错的咖啡馆。" },
  { sourceLanguage: "zh" as Lang, text: "太好了，我们现在过去吧。", translation: "いいですね。今から行きましょう。" },
];
const words = {
  zh: { create: "创建对话", join: "加入对话", mine: "我说的话", theirs: "对方说的话", language: "我的语言", pause: "暂停", resume: "继续对话", start: "开始对话", end: "结束", leave: "返回首页", share: "邀请对方", settings: "显示设置", waiting: "等待对方加入", ready: "双方已就绪", running: "对话进行中", paused: "对话已暂停", ended: "对话已结束", demo: "演示模式", live: "真实翻译", translating: "正在翻译…", partial: "识别中", emptyOther: "等待对方开口", emptySelf: "你的话会出现在这里", hint: "自然说话，字幕会自动出现", prepare: "准备好，让对话开始", shareHint: "让对方扫码，或发送邀请链接", copied: "邀请链接已复制", approve: "允许加入", reject: "拒绝", pending: "等待房主确认", code: "房间码", codeHint: "输入 8 位房间码", mic: "本机收音", remoteMic: "房主手机收音", demoNote: "示例字幕演示，不会开启麦克风", unconfigured: "真实翻译尚未配置 · 当前可体验演示与双端同步", subintro: "两部手机，一段对话。中文与日语之间，让交流自然发生。", quick: "先体验字幕演示", font: "字幕字号", regular: "标准", large: "大字", extra: "特大", close: "关闭", auth: "此发布站点目前为私有，另一部手机需使用同一获授权账号登录。", mapping: "按双方语言分区显示，不代表声纹识别人。", endConfirm: "结束后将清除本次字幕，并让双方退出对话。", confirm: "结束并清除", cancel: "继续交流", config: "配置说明", guest: "对方", host: "你", sample: "本机示例对话", network: "已断线 · 正在重新连接", uncertain: "正在判断发言语言…" },
  ja: { create: "会話を作成", join: "会話に参加", mine: "自分の発言", theirs: "相手の発言", language: "自分の言語", pause: "一時停止", resume: "会話を再開", start: "会話を開始", end: "終了", leave: "ホームへ", share: "相手を招待", settings: "表示設定", waiting: "相手の参加を待っています", ready: "準備ができました", running: "会話中", paused: "一時停止中", ended: "会話が終了しました", demo: "デモモード", live: "リアルタイム翻訳", translating: "翻訳中…", partial: "認識中", emptyOther: "相手の発言を待っています", emptySelf: "あなたの発言がここに表示されます", hint: "自然に話すと、字幕が表示されます", prepare: "言葉がつながる、その瞬間へ", shareHint: "QR コードまたはリンクで招待", copied: "招待リンクをコピーしました", approve: "参加を許可", reject: "拒否", pending: "ホストの承認を待っています", code: "ルームコード", codeHint: "8 桁のコードを入力", mic: "この端末で集音", remoteMic: "ホストの端末で集音", demoNote: "サンプル字幕です。マイクは使用しません", unconfigured: "音声翻訳は未設定です。デモと字幕の同期を試せます", subintro: "2 台のスマホで、ひとつの会話。中国語と日本語を、もっと自然に。", quick: "字幕デモを体験", font: "字幕の文字サイズ", regular: "標準", large: "大", extra: "特大", close: "閉じる", auth: "現在は非公開サイトです。別の端末でも許可されたアカウントでログインしてください。", mapping: "言語で表示を分けています。話者の本人確認ではありません。", endConfirm: "終了すると両方の端末の字幕が消去されます。", confirm: "終了して消去", cancel: "会話を続ける", config: "設定ガイド", guest: "相手", host: "あなた", sample: "端末内のサンプル会話", network: "切断されました · 再接続中", uncertain: "発言の言語を判定しています…" },
};
async function request<T>(path: string, body?: Record<string, unknown>, session?: Session): Promise<T> {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(15000) });
  const result = await r.json() as T & { error?: string; errorJa?: string; code?: string };
  if (!r.ok) throw Object.assign(new Error((document.documentElement.lang === "ja" ? result.errorJa : result.error) || result.error || "连接失败 / 接続に失敗しました"), { status: r.status, code: result.code });
  return result;
}

export default function Home() {
  const [language, setLanguage] = useState<Lang>("zh");
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [configured, setConfigured] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [code, setCode] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [modal, setModal] = useState<"share" | "settings" | "guide" | "end" | null>(null);
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
  const [level, setLevel] = useState(0);
  const [uncertain, setUncertain] = useState("");
  const [now, setNow] = useState(Date.now());
  const speech = useRef<Awaited<ReturnType<typeof startSpeech>> | null>(null);
  const roomRef = useRef(room); roomRef.current = room;
  const sessionRef = useRef(session); sessionRef.current = session;
  const sendTimes = useRef(new Map<string, number>());
  const pendingCaptions = useRef(new Map<string, Set<Promise<unknown>>>());
  const lifecycle = useRef(0);
  const speechAbort = useRef<AbortController | null>(null);
  const restoring = useRef(false);
  const sequence = useRef(0);
  const appliedSequence = useRef(0);
  const upperRef = useRef<HTMLDivElement>(null);
  const lowerRef = useRef<HTMLDivElement>(null);
  const t = words[language];
  const active = !!room || preview;
  const running = preview ? previewRunning : room?.state === "running";
  const isHost = session?.role === "host";
  const isDemo = preview || room?.mode === "demo";
  const captions = preview ? previewCaptions : room?.captions ?? [];
  const approved = room?.guestStatus === "approved";
  const invite = origin && room ? `${origin}/?join=${room.code}` : "";

  useEffect(() => {
    setOrigin(location.origin);
    const incoming = new URLSearchParams(location.search).get("join");
    if (incoming) { setCode(incoming.toUpperCase()); setJoinOpen(true); }
    try {
      setLanguage(localStorage.getItem("kotoba-language") === "ja" ? "ja" : "zh");
      const saved = sessionStorage.getItem("kotoba-session");
      if (saved && !incoming) { const s = JSON.parse(saved); if (s.roomId && s.token) { restoring.current = true; setSession(s); setLanguage(s.language); } }
    } catch { /* Storage is optional. */ }
    request<{ speechReady: boolean }>("/api/config").then(c => { setConfigured(c.speechReady); setMode(c.speechReady ? "live" : "demo"); }).catch(() => setError("无法读取服务状态，请刷新重试 / サービスを確認できません")).finally(() => setChecking(false));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); speechAbort.current?.abort(); void speech.current?.stop(); };
  }, []);
  useEffect(() => { document.documentElement.lang = language === "zh" ? "zh-CN" : "ja"; try { localStorage.setItem("kotoba-language", language); } catch { /* Optional preference. */ } }, [language]);
  const saveSession = (s: Session) => { setSession(s); setLanguage(s.language); try { sessionStorage.setItem("kotoba-session", JSON.stringify(s)); } catch { /* Session stays in memory. */ } };
  const applySnapshot = useCallback((next: RoomSnapshot, seq: number) => {
    if (sessionRef.current?.roomId !== next.id) return;
    setRoom(previous => {
      if (previous?.id === next.id && (previous.generation > next.generation || (previous.generation === next.generation && seq < appliedSequence.current))) return previous;
      appliedSequence.current = seq;
      return next;
    });
  }, []);
  useEffect(() => {
    if (!session) return;
    let cancelled = false; let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const seq = ++sequence.current;
        const data = await request<{ room: RoomSnapshot }>(`/api/room?roomId=${encodeURIComponent(session!.roomId)}`, undefined, session!);
        if (!cancelled) {
          if (restoring.current || speechAbort.current?.signal.aborted) {
            restoring.current = false;
            if (session!.role === "host" && data.room.mode === "live" && data.room.state === "running") {
              const paused = await request<{room:RoomSnapshot}>("/api/room", { action:"pause", roomId:session!.roomId }, session!);
              if (!cancelled) { applySnapshot(paused.room, ++sequence.current); setToast("页面已恢复，请点击继续收音 / 再開ボタンを押してください"); }
            } else applySnapshot(data.room, seq);
          } else applySnapshot(data.room, seq);
          setOnline(true);
        }
      } catch (e) {
        if (!cancelled) {
          setOnline(false);
          if ([401,403,404,410].includes((e as { status: number }).status)) { setError((e as Error).message); setSession(null); setRoom(null); try { sessionStorage.removeItem("kotoba-session"); } catch { /* Optional storage. */ } }
        }
      } finally { if (!cancelled) timeout = setTimeout(poll, 1200); }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timeout); };
  }, [session, applySnapshot]);
  const action = useCallback(async (name: string, extra: Record<string, unknown> = {}) => {
    const s = sessionRef.current; if (!s) return;
    const seq = ++sequence.current;
    const data = await request<{ room: RoomSnapshot }>("/api/room", { action: name, roomId: s.roomId, ...extra }, s);
    if (!["caption", "discard-caption", "demo-next"].includes(name)) applySnapshot(data.room, seq);
    return data.room;
  }, [applySnapshot]);
  const perform = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(""), 3500); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(".modal");
    dialog?.querySelector<HTMLElement>("button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModal(null);
      if (event.key === "Tab" && dialog) {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input'));
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
    import("qrcode").then(q => q.toDataURL(invite, { width: 240, margin: 2, color: { dark: "#252347", light: "#ffffff" } })).then(url => { if (live) setQr(url); }).catch(() => setError("二维码生成失败，请复制邀请链接 / リンクをコピーしてください"));
    return () => { live = false; };
  }, [modal, invite]);
  useEffect(() => {
    if (!preview || !previewRunning) return;
    let index = previewCaptions.length;
    const append = () => { const item = examples[index % examples.length]; const n = index++; setPreviewCaptions(c => [...c.slice(-19), { ...item, id: `preview-${n}-${Date.now()}`, revision: 1, isFinal: true, translationState: "done", createdAt: Date.now() }]); };
    if (!index) append(); const timer = setInterval(append, 3400); return () => clearInterval(timer);
    // A pause/restart creates a new demo sequence timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, previewRunning]);
  useEffect(() => {
    if (!isHost || room?.mode !== "demo" || room.state !== "running" || !online) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { await action("demo-next", { expectedDemoIndex: roomRef.current?.demoIndex }); } catch (e) { if (!cancelled && (e as {code:string}).code !== "STALE_UPDATE") setError((e as Error).message); } finally { if (!cancelled) timer = setTimeout(tick, 2100); } };
    timer = setTimeout(tick, 500); return () => { cancelled = true; clearTimeout(timer); };
  }, [isHost, room?.mode, room?.state, online, action]);
  useEffect(() => {
    if (room?.state !== "running" || !online) { lifecycle.current++; speechAbort.current?.abort(); void speech.current?.stop(); speech.current = null; setListening(false); setLevel(0); setUncertain(""); }
  }, [room?.state, online]);
  useEffect(() => {
    const interrupt = () => { if (document.visibilityState === "hidden" && speechAbort.current) { lifecycle.current++; speechAbort.current.abort(); void speech.current?.stop(); speech.current = null; setListening(false); void action("pause").catch(() => {}); } };
    document.addEventListener("visibilitychange", interrupt); return () => document.removeEventListener("visibilitychange", interrupt);
  }, [action]);
  useEffect(() => {
    if (!running || !listening) return;
    let lock: WakeLockSentinel | null = null; let cancelled = false;
    navigator.wakeLock?.request("screen").then(value => { if (cancelled) void value.release(); else lock = value; }).catch(() => setToast(language === "zh" ? "请保持屏幕亮着、网页在前台" : "画面を点灯したままにしてください"));
    return () => { cancelled = true; void lock?.release(); };
  }, [running, listening, language]);
  useEffect(() => { for (const el of [upperRef.current, lowerRef.current]) if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 220) {
    const latest = el.lastElementChild as HTMLElement | null;
    el.scrollTop = latest && latest.offsetHeight > el.clientHeight ? el.scrollTop + latest.getBoundingClientRect().top - el.getBoundingClientRect().top : el.scrollHeight;
  } }, [captions]);

  async function create() { await perform(async () => { const data = await request<{ session: Session; room: RoomSnapshot }>("/api/room", { action: "create", language, mode }); setPreview(false); setPreviewRunning(false); saveSession(data.session); setRoom(data.room); setOnline(true); setModal("share"); }); }
  async function join() {
    if (!/^[A-Z0-9]{8}$/.test(code.trim().toUpperCase())) { setError(language === "zh" ? "请输入完整的 8 位房间码" : "8 桁のルームコードを入力してください"); return; }
    await perform(async () => { const data = await request<{ session: Session; room: RoomSnapshot }>("/api/room", { action: "join", code: code.trim().toUpperCase(), language }); setPreview(false); setPreviewRunning(false); saveSession(data.session); setRoom(data.room); setOnline(true); setJoinOpen(false); history.replaceState(null, "", "/"); });
  }
  async function start() {
    if (preview) { setPreviewRunning(true); return; }
    await perform(async () => {
      const next = await action("start"); if (!next || next.mode !== "live") return;
      const generation = next.generation; const run = ++lifecycle.current;
      speechAbort.current = new AbortController();
      const controller = speechAbort.current;
      const stopOnError = (message: string) => { if (run !== lifecycle.current || controller.signal.aborted) return; setError(message); setListening(false); void action("pause").catch(() => {}); };
      try {
        const client = await startSpeech({
          signal: speechAbort.current.signal,
          getToken: async () => request("/api/speech-token", { roomId: sessionRef.current!.roomId }, sessionRef.current!),
          onCaption: item => {
            if (run !== lifecycle.current) return;
            if (!item.text || (!item.sourceLanguage && item.isFinal)) {
              setUncertain(item.text); sendTimes.current.delete(item.id);
              void Promise.allSettled([...(pendingCaptions.current.get(item.id) ?? [])]).then(() => action("discard-caption", { id:item.id, revision:item.revision, generation })).catch(() => {});
              return;
            }
            if (!item.sourceLanguage) { setUncertain(item.text); return; }
            setUncertain(""); const last = sendTimes.current.get(item.id) ?? 0;
            if (!item.isFinal && Date.now() - last < 1500) return;
            sendTimes.current.set(item.id, Date.now()); if (item.isFinal) sendTimes.current.delete(item.id);
            const pending = pendingCaptions.current.get(item.id) ?? new Set<Promise<unknown>>();
            pendingCaptions.current.set(item.id, pending);
            const work = action("caption", { ...item, generation }).catch(e => { if (run === lifecycle.current) setError(e.message); }).finally(() => { pending.delete(work); if (!pending.size) pendingCaptions.current.delete(item.id); });
            pending.add(work);
          }, onLevel: setLevel, onError: stopOnError,
          onStopped: () => { if (run === lifecycle.current && !controller.signal.aborted) { setListening(false); void action("pause").catch(() => {}); } },
        });
        if (run !== lifecycle.current) { await client.stop(); return; } speech.current = client; setListening(true);
      } catch (e) { stopOnError((e as Error).message); }
    });
  }
  async function pause() { if (preview) { setPreviewRunning(false); return; } lifecycle.current++; speechAbort.current?.abort(); await speech.current?.stop(); speech.current = null; setListening(false); await perform(() => action("pause")); }
  async function end() { setModal(null); lifecycle.current++; speechAbort.current?.abort(); await speech.current?.stop(); speech.current = null; setListening(false); if (preview) { setPreviewRunning(false); setPreviewCaptions([]); setPreview(false); return; } await perform(() => action("end")); }
  function reset() { setRoom(null); setSession(null); setPreview(false); setPreviewRunning(false); setPreviewCaptions([]); setError(""); setOnline(true); try { sessionStorage.removeItem("kotoba-session"); } catch { /* Optional. */ } }
  const status = !online ? t.network : preview ? (previewRunning ? t.sample : t.paused) : room ? ({ waiting: room.guestStatus === "pending" && !isHost ? t.pending : t.waiting, ready: t.ready, running: t.running, paused: t.paused, ended: t.ended })[room.state] : t.prepare;
  const duration = room?.startedAt ? Math.max(0, Math.floor((now - room.startedAt) / 1000)) : 0;
  const elapsed = `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`;
  const renderCaptions = (self: boolean) => {
    const list = captions.filter(c => (c.sourceLanguage === language) === self);
    return list.length ? list.map(c => <article key={c.id} className={`caption ${c.isFinal ? "final" : "partial"}`}>
      <div className="caption-meta"><span>{c.sourceLanguage === "zh" ? "中文" : "日本語"}</span><span>{c.isFinal ? <Check size={12}/> : <LoaderCircle size={12} className="spin"/>}{!c.isFinal ? t.partial : new Date(c.createdAt).toLocaleTimeString(language === "zh" ? "zh-CN" : "ja-JP", { hour: "2-digit", minute: "2-digit" })}</span></div>
      <p className="caption-main">{self ? c.text : c.translation || (c.translationState === "error" ? (language === "zh" ? "翻译失败，请参考原文" : "翻訳できませんでした。原文をご確認ください") : t.translating)}</p>
      <p className="caption-secondary">{self ? (c.translation || (c.translationState === "error" ? "翻译暂不可用 / 翻訳できません" : t.translating)) : c.text}</p>
    </article>) : <div className="empty-caption"><span className="empty-symbol">{self ? <Mic size={25}/> : <Languages size={28}/>}</span><h3>{self ? t.emptySelf : t.emptyOther}</h3><p>{active ? t.hint : language === "zh" ? "开始一段对话，让语言不再成为距离" : "会話を始めて、言葉の距離を近づけよう"}</p></div>;
  };

  return <div className="app-shell" style={{ "--caption-scale": [1, 1.22, 1.42][fontSize] } as React.CSSProperties}>
    <header className="topbar"><a href="/" className="brand" aria-label="语间 Kotoba 首页" onClick={e => { if (active && room?.state !== "ended") { e.preventDefault(); setModal("end"); } }}><span className="brand-mark"><Languages size={23}/></span><span>语间<span className="brand-latin">kotoba</span></span><span className="beta">BETA</span></a><nav><span className="header-description">中文 <span>↔</span> 日本語</span><button className="icon-button" onClick={() => setModal("guide")} aria-label={t.config}><HelpCircle size={20}/></button><button className="ui-language" onClick={() => { if (!session) setLanguage(language === "zh" ? "ja" : "zh"); else setModal("settings"); }}><Globe2 size={16}/>{language === "zh" ? "中文" : "日本語"}<ChevronDown size={13}/></button></nav></header>
    <div className="workspace"><aside className={`sidebar ${active ? "compact-mobile" : ""}`}>
      <div className="sidebar-heading"><span className="eyebrow"><span className="tiny-dot"/> FACE TO FACE</span><h1>{language === "zh" ? <>让每一句话，<br/><em>都有回应。</em></> : <>言葉が届く。<br/><em>想いがつながる。</em></>}</h1><p>{t.subintro}</p></div>
      {!active ? <div className="setup-card"><label className="field-label">{t.language}</label><div className="language-options"><button className={language === "zh" ? "selected" : ""} onClick={() => setLanguage("zh")}><span className="lang-glyph">中</span>中文{language === "zh" && <Check size={14}/>}</button><button className={language === "ja" ? "selected" : ""} onClick={() => setLanguage("ja")}><span className="lang-glyph">あ</span>日本語{language === "ja" && <Check size={14}/>}</button></div>
        {joinOpen ? <form onSubmit={e => { e.preventDefault(); void join(); }}><label className="field-label" htmlFor="room-code">{t.code}</label><input id="room-code" value={code} onChange={e => setCode(e.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())} maxLength={8} autoComplete="off" placeholder={t.codeHint} required/><button className="button primary" disabled={busy || checking}>{busy ? <LoaderCircle className="spin" size={18}/> : <Link2 size={18}/>} {t.join}<ArrowRight size={17}/></button><button type="button" className="button text-button" onClick={() => setJoinOpen(false)}>{t.create}</button></form> : <><button className="button primary" disabled={busy || checking} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={18}/> : <Users size={18}/>} {t.create}<ArrowRight size={17}/></button><button className="button secondary" onClick={() => setJoinOpen(true)}><Link2 size={17}/>{t.join}</button><div className="mode-select"><button className={mode === "demo" ? "on" : ""} onClick={() => setMode("demo")}>{t.demo}</button><button disabled={!configured} className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>{t.live}{!configured && <span> · {language === "zh" ? "待配置" : "未設定"}</span>}</button></div></>}
      </div> : <div className="room-card"><div className="field-label">{preview ? t.demo : t.code}<span className="mode-pill">{isDemo ? t.demo : t.live}</span></div><div className="room-number">{preview ? "PREVIEW" : room?.code}<button className="icon-button" disabled={preview} onClick={() => setModal("share")} aria-label={t.share}><QrCode size={20}/></button></div><div className="participants"><div><span className="person-icon">{language === "zh" ? "中" : "あ"}</span><span>{t.host}<small>{language === "zh" ? "中文" : "日本語"}</small></span><span className="online-dot"/></div><div><span className="person-icon lilac">{language === "zh" ? "あ" : "中"}</span><span>{t.guest}<small>{preview ? t.sample : approved ? (language === "zh" ? "日本語" : "中文") : t.waiting}</small></span><span className={`online-dot ${preview || (isHost ? room?.guestOnline && approved : room?.hostOnline) ? "" : "offline"}`}/></div></div>{!preview && room?.state !== "ended" && <button className="button secondary" onClick={() => setModal("share")}><QrCode size={17}/>{t.share}</button>}{room?.state === "ended" && <button className="button secondary" onClick={reset}>{t.leave}</button>}</div>}
      <div className="how-it-works"><span className="eyebrow">{language === "zh" ? "简单三步，自然交流" : "3 ステップで、自然な会話"}</span>{(language === "zh" ? ["创建房间，邀请对方", "一部手机收音，双方看字幕", "说中文或日语，自动翻译"] : ["ルームを作成し、相手を招待", "1 台で集音、2 台で字幕を確認", "中国語・日本語を自動翻訳"]).map((s, i) => <div key={s}><span>{i + 1}</span>{s}</div>)}</div><div className="sidebar-bottom"><ShieldCheck size={17}/><p>{language === "zh" ? "不保存原始录音" : "録音ファイルは保存しません"}<span>{language === "zh" ? "结束后清除本次字幕" : "終了後に字幕を消去します"}</span></p><button className="icon-button" aria-label={t.config} onClick={() => setModal("guide")}><ArrowUpRight size={17}/></button></div>
    </aside><main className="conversation"><div className="conversation-heading"><div><span className="eyebrow">LIVE CONVERSATION</span><h2>{language === "zh" ? "面对面，也听得懂" : "向き合って、わかり合う"}</h2></div><button className="settings-button" onClick={() => setModal("settings")}><Settings2 size={17}/><span>{t.settings}</span></button></div>
      {!configured && !checking && <div className="notice"><span className="notice-dot"/>{t.unconfigured}<button onClick={() => setModal("guide")}>{language === "zh" ? "了解" : "詳細"}<ArrowUpRight size={12}/></button></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label={t.close} onClick={() => setError("")}><X size={16}/></button></div>}
      {room?.guestStatus === "pending" && isHost && <div className="approval"><Users size={20}/><span>{language === "zh" ? "一位参与者申请加入" : "参加リクエストが届きました"}</span><button disabled={busy} onClick={() => void perform(() => action("approve"))}>{t.approve}</button><button className="decline" disabled={busy} onClick={() => void perform(() => action("reject"))}>{t.reject}</button></div>}
      <div className="caption-stage"><section className="caption-panel opponent"><div className="panel-heading"><div><span className="speaker-avatar">{language === "zh" ? "あ" : "中"}</span><span>{t.theirs}<small>{language === "zh" ? "日本語 → 中文" : "中文 → 日本語"}</small></span></div><span className="panel-tag">{language === "zh" ? "译文优先" : "翻訳を表示"}</span></div><div className="caption-scroll" ref={upperRef} aria-label={t.theirs}>{renderCaptions(false)}</div></section><div className="divider"><Languages size={16}/></div><section className="caption-panel self"><div className="panel-heading"><div><span className="speaker-avatar">{language === "zh" ? "中" : "あ"}</span><span>{t.mine}<small>{language === "zh" ? "中文 → 日本語" : "日本語 → 中文"}</small></span></div><span className="panel-tag">{language === "zh" ? "原文优先" : "原文を表示"}</span></div><div className="caption-scroll" ref={lowerRef} aria-label={t.mine}>{renderCaptions(true)}</div></section></div>
      {uncertain && <div className="uncertain" role="status">{t.uncertain} {uncertain}</div>}
      <div className="control-bar"><div className="connection-state"><span className={`status-orb ${running && online ? "active" : ""} ${!online ? "disconnected" : ""}`}><Radio size={18}/></span><div><strong role="status">{status}</strong><small>{active ? (isDemo ? t.demoNote : isHost ? t.mic : t.remoteMic) : t.hint}</small></div></div><div className="control-actions">{room?.startedAt && <span className="elapsed">{elapsed}</span>}{listening && <div className="volume-bars" aria-label="收音音量 / マイク音量">{[0,1,2,3,4].map(i => <span key={i} style={{ height: `${6 + Math.min(18, level * (24 + i * 7))}px` }}/>)}</div>}
        {!active ? <button className="button primary" onClick={() => { setPreview(true); setPreviewRunning(true); setPreviewCaptions([]); }}><Play size={16}/>{t.quick}</button> : room?.state === "ended" ? <button className="button secondary" onClick={reset}>{t.leave}</button> : <>{running ? <button className="button secondary" disabled={busy || !online} onClick={() => void pause()}><Pause size={17}/>{t.pause}</button> : (isHost || preview) ? <button className="button primary" disabled={busy || !online || (!preview && !approved)} onClick={() => void start()}>{busy ? <LoaderCircle size={17} className="spin"/> : <Play size={17}/>} {room?.state === "paused" || preview ? t.resume : t.start}</button> : <span className="guest-wait">{room?.guestStatus === "pending" ? t.pending : language === "zh" ? "等待房主开始" : "ホストの開始を待っています"}</span>}<button className="button end-button" disabled={busy} onClick={() => { if (session?.role === "guest" && room?.guestStatus === "pending") void perform(async () => { await request("/api/room", { action:"cancel-join", roomId:session.roomId }, session); reset(); }); else setModal("end"); }}><Square size={14}/>{session?.role === "guest" && room?.guestStatus === "pending" ? (language === "zh" ? "取消加入" : "参加を取り消す") : t.end}</button></>}
      </div></div><div className="stage-footnote"><span><MicOff size={12}/>{language === "zh" ? "字幕模式 · 无语音外放" : "字幕モード · 音声の再生なし"}</span><span>{t.mapping}</span></div>
    </main></div>
    <footer className="page-footer"><span>语间 kotoba</span><span>{language === "zh" ? "让语言靠近，让交流自然。" : "言葉をこえて、もっと近くに。"}</span><span>V0.1 · 中文 / 日本語</span></footer>
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className="modal" role="dialog" aria-modal="true" aria-label={modal === "share" ? t.share : modal === "settings" ? t.settings : modal === "end" ? t.end : t.config} onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label={t.close} onClick={() => setModal(null)}><X size={20}/></button>
      {modal === "share" && <><span className="modal-icon"><QrCode size={26}/></span><h2>{t.share}</h2><p>{t.shareHint}</p><div className="qr-box">{qr ? <img src={qr} alt="加入房间二维码 / 参加用 QR コード" width={220} height={220}/> : <LoaderCircle className="spin"/>}</div><div className="share-code">{room?.code}</div><button className="button primary" onClick={() => void perform(async () => { await navigator.clipboard.writeText(invite); setToast(t.copied); })}><Copy size={17}/>{language === "zh" ? "复制邀请链接" : "招待リンクをコピー"}</button><input className="invite-url" aria-label="邀请链接 / 招待リンク" readOnly value={invite} onFocus={e => e.target.select()}/><p className="small-note">{t.auth}</p></>}
      {modal === "settings" && <><span className="modal-icon"><Settings2 size={26}/></span><h2>{t.settings}</h2><label className="field-label">{t.font}</label><div className="font-options">{[t.regular,t.large,t.extra].map((v,i) => <button key={i} className={i === fontSize ? "selected" : ""} onClick={() => setFontSize(i)}><span style={{fontSize:18+i*4}}>Aa</span>{v}</button>)}</div><p className="small-note">{t.mapping}</p><div className="setting-detail"><Languages size={20}/><div>{language === "zh" ? "上方看对方，下方看自己" : "上に相手、下に自分"}<small>{language === "zh" ? "对方译文大字显示，自己的话原文优先。" : "相手の翻訳と、自分の原文を大きく表示。"}</small></div></div></>}
      {modal === "end" && <><span className="modal-icon"><Square size={24}/></span><h2>{t.end}</h2><p>{t.endConfirm}</p><button className="button primary" onClick={() => void end()}>{t.confirm}</button><button className="button secondary" onClick={() => setModal(null)}>{t.cancel}</button></>}
      {modal === "guide" && <><span className="modal-icon"><Languages size={26}/></span><h2>{language === "zh" ? "开始使用语间" : "語間の使い方"}</h2><div className="guide-content"><h3>{language === "zh" ? "现在可以体验什么？" : "今すぐ試せること"}</h3><p>{language === "zh" ? "无需密钥即可体验示例字幕，也可以创建演示房间，邀请第二部手机验证同步。演示不采集声音，不会进行真实翻译。" : "キーなしでサンプル字幕とルームの同期を試せます。デモでは録音・実際の翻訳を行いません。"}</p><h3>{language === "zh" ? "启用真实语音翻译" : "音声翻訳を有効にする"}</h3><p>{language === "zh" ? "在服务端配置 Azure Speech 与 Translator 凭据后，首页会开放“真实翻译”。密钥无需输入网页，也不要发到聊天里。详细步骤见项目 README。" : "サーバーに Azure Speech と Translator を設定すると音声翻訳が有効になります。キーをこの画面やチャットに入力しないでください。手順は README にあります。"}</p><h3>{language === "zh" ? "面对面收音" : "対面での集音"}</h3><p>{language === "zh" ? "房主手机放在两人之间，屏幕保持亮着，双方轮流说中文或日语。切到后台会暂停收音，需要返回后主动继续。每个房间最多使用 30 分钟。" : "ホストのスマホを2人の間に置き、画面を点灯したまま交互に話してください。バックグラウンドでは集音を停止します。ルームは最大30分です。"}</p><p className="small-note">{t.auth}</p><a href="/SETUP.html" target="_blank" rel="noreferrer" className="guide-link">{language === "zh" ? "打开完整配置与测试说明" : "設定とテストのガイドを開く"}<ArrowUpRight size={16}/></a></div></>}
    </section></div>}
  </div>;
}
