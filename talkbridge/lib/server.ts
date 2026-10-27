import { env } from "cloudflare:workers";
import type { Caption, Language, RoomSnapshot, Session } from "./types";
import { isLanguage, TRANSLATOR_CODES } from "./languages";

type RoomRow = {
  id: string; code: string; host_token_hash: string; guest_token_hash: string | null;
  host_language: Language; guest_language: Language | null;
  guest_status: "none" | "pending" | "approved";
  mode: "demo" | "live"; device_mode: RoomSnapshot["deviceMode"]; state: RoomSnapshot["state"];
  created_at: number; expires_at: number; started_at: number | null;
  host_seen_at: number; guest_seen_at: number | null;
  host_listening: number; guest_listening: number; host_capture_generation: number; guest_capture_generation: number;
  demo_index: number; generation: number; last_translation_at: number;
};
type CaptionRow = {
  id: string; revision: number; source_language: Language; text: string;
  translation: string; is_final: number; translation_state: Caption["translationState"];
  created_at: number; edited: number;
  speaker_id: string | null; speaker_side: "a" | "b" | null; target_language: Language | null;
};
type Input = Record<string, unknown>;
type Role = "host" | "guest";
type TranslationTiming = { translationMs: number | null; translationReused: boolean };
const ONLINE_MS = 20_000;
const SESSION_MS = 30 * 60_000;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

const errorsJa: Record<string, string> = {
  INVALID_INPUT: "リクエストの形式が正しくありません。",
  DATABASE_UNAVAILABLE: "ルームサービスの設定が完了していません。",
  INVALID_LANGUAGE: "中国語・日本語・韓国語・英語から選択してください。",
  RATE_LIMIT: "操作が多すぎます。少し待ってからお試しください。",
  UNAUTHORIZED: "このルームにアクセスできません。もう一度参加してください。",
  ROOM_NOT_FOUND: "ルームが見つからないか、有効期限が切れています。",
  ROOM_EXPIRED: "30 分の制限時間になりました。新しいルームを作成してください。",
  INVALID_MODE: "デモまたは音声翻訳を選択してください。",
  SPEECH_NOT_CONFIGURED: "音声サービスが未設定です。デモをご利用ください。",
  INVALID_CODE: "8 桁のルームコードを入力してください。",
  SAME_LANGUAGE: "相手とは異なる言語を選択してください。",
  ROOM_FULL: "ルームは満員、または参加承認待ちです。",
  SOLO_PRIVATE: "この会話は1台の端末専用です。",
  ROOM_ENDED: "会話は終了しました。",
  AWAITING_APPROVAL: "ホストの参加承認をお待ちください。",
  HOST_ONLY: "音声を収録するホストだけがこの操作を行えます。",
  GUEST_ONLY: "ホストが退出する場合は、会話を終了してください。",
  INVALID_STATE: "現在の状態ではこの操作を行えません。",
  NOT_READY: "相手が参加してオンラインになっていることを確認してください。",
  INVALID_ACTION: "不明な操作です。",
  STALE_UPDATE: "状態が更新されています。もう一度お試しください。",
  CAPTION_LIMIT: "字幕数の上限に達しました。新しいルームを作成してください。",
  INVALID_CAPTION: "字幕の形式が無効、または古い更新です。",
  CAPTION_OWNER_ONLY: "自分の言語の字幕だけを修正できます。",
  SPEECH_AUTH_FAILED: "音声サービスの認証に失敗しました。設定をご確認ください。",
  SERVER_ERROR: "サービスを利用できません。しばらくしてからお試しください。",
};

const errorsKo: Record<string, string> = {
  INVALID_INPUT: "요청 형식이 올바르지 않습니다.", DATABASE_UNAVAILABLE: "대화방 서비스 설정이 완료되지 않았습니다.",
  INVALID_LANGUAGE: "중국어, 일본어, 한국어, 영어 중에서 선택해 주세요.", RATE_LIMIT: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  UNAUTHORIZED: "이 대화방에 접근할 수 없습니다. 다시 참여해 주세요.", ROOM_NOT_FOUND: "대화방이 없거나 만료되었습니다.",
  ROOM_EXPIRED: "30분 제한에 도달했습니다. 새 대화방을 만들어 주세요.", INVALID_MODE: "데모 또는 실시간 번역을 선택해 주세요.",
  SPEECH_NOT_CONFIGURED: "음성 서비스가 설정되지 않았습니다. 데모를 이용해 주세요.", INVALID_CODE: "8자리 대화방 코드를 입력해 주세요.",
  SAME_LANGUAGE: "상대방과 다른 언어를 선택해 주세요.", ROOM_FULL: "대화방이 가득 찼습니다.", ROOM_ENDED: "대화가 종료되었습니다.",
  SOLO_PRIVATE: "이 대화는 한 대의 기기에서만 이용할 수 있습니다.",
  AWAITING_APPROVAL: "방장의 참여 승인을 기다려 주세요.", HOST_ONLY: "마이크를 사용하는 방장만 실행할 수 있습니다.",
  GUEST_ONLY: "방장은 나가기 대신 대화를 종료해 주세요.", INVALID_STATE: "현재 상태에서는 실행할 수 없습니다.",
  NOT_READY: "상대방이 참여하여 온라인 상태인지 확인해 주세요.", INVALID_ACTION: "알 수 없는 작업입니다.",
  STALE_UPDATE: "내용이 변경되었습니다. 최신 상태를 확인한 후 다시 시도해 주세요.", CAPTION_LIMIT: "자막 수 제한에 도달했습니다. 새 대화방을 만들어 주세요.",
  INVALID_CAPTION: "자막 형식이 올바르지 않거나 오래된 요청입니다.", CAPTION_OWNER_ONLY: "자신의 언어로 된 자막만 수정할 수 있습니다.",
  SPEECH_AUTH_FAILED: "음성 서비스 인증에 실패했습니다. 설정을 확인해 주세요.", SERVER_ERROR: "서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
};

const errorsEn: Record<string, string> = {
  INVALID_INPUT: "Invalid request format.", DATABASE_UNAVAILABLE: "The room service is not configured.",
  INVALID_LANGUAGE: "Choose Chinese, Japanese, Korean, or English.", RATE_LIMIT: "Too many requests. Please try again shortly.",
  UNAUTHORIZED: "You cannot access this room. Please rejoin.", ROOM_NOT_FOUND: "This room does not exist or has expired.",
  ROOM_EXPIRED: "The 30-minute session has expired. Please create a new room.", INVALID_MODE: "Choose a supported conversation mode.",
  SPEECH_NOT_CONFIGURED: "Speech translation is not configured. Please try the demo.", INVALID_CODE: "Enter an 8-character room code.",
  SAME_LANGUAGE: "Choose a different language from your partner.", ROOM_FULL: "This room is full.", ROOM_ENDED: "This conversation has ended.",
  SOLO_PRIVATE: "This conversation is for one device only.", AWAITING_APPROVAL: "Please wait for the host to approve your request.",
  HOST_ONLY: "Only the host using the microphone can do this.", GUEST_ONLY: "The host must end the conversation to leave.",
  INVALID_STATE: "This action is unavailable in the current state.", NOT_READY: "Your partner must join and stay online first.",
  INVALID_ACTION: "Unknown action.", STALE_UPDATE: "This content has changed. Check the latest version and try again.",
  CAPTION_LIMIT: "The caption limit has been reached. Please create a new room.", INVALID_CAPTION: "Invalid or outdated caption.",
  CAPTION_OWNER_ONLY: "You can only edit captions in your own language.", SPEECH_AUTH_FAILED: "Speech authorization failed. Check the service settings.",
  SERVER_ERROR: "The service is unavailable. Please try again shortly.",
};

export async function route(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiError) return response({ error: error.message, errorJa: errorsJa[error.code] || errorsJa.SERVER_ERROR, errorKo: errorsKo[error.code] || errorsKo.SERVER_ERROR, errorEn: errorsEn[error.code] || errorsEn.SERVER_ERROR, code: error.code }, error.status);
    // Do not echo database errors, provider responses, request bodies, or credentials.
    return response({ error: "服务暂时不可用，请稍后重试。", errorJa: errorsJa.SERVER_ERROR, errorKo: errorsKo.SERVER_ERROR, errorEn: errorsEn.SERVER_ERROR, code: "SERVER_ERROR" }, 503);
  }
}

function db() {
  if (!env.DB) throw new ApiError(503, "DATABASE_UNAVAILABLE", "房间服务尚未配置完成。");
  return env.DB;
}

export function speechReady() {
  return Boolean(env.AZURE_SPEECH_KEY && /^[a-z0-9-]+$/.test(env.AZURE_SPEECH_REGION || "")
    && env.AZURE_TRANSLATOR_KEY && env.AZURE_TRANSLATOR_REGION);
}

export async function readInput(request: Request): Promise<Input> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(415, "INVALID_INPUT", "请使用 JSON 请求。");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_INPUT", "请求内容为空。");
  const decoder = new TextDecoder();
  let body = "", bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 8000) {
      await reader.cancel();
      throw new ApiError(413, "INVALID_INPUT", "请求内容过长。");
    }
    body += decoder.decode(part.value, { stream: true });
  }
  body += decoder.decode();
  try {
    const input: unknown = JSON.parse(body);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    return input as Input;
  } catch { throw new ApiError(400, "INVALID_INPUT", "请求格式不正确。"); }
}

function language(value: unknown): Language {
  if (!isLanguage(value)) throw new ApiError(400, "INVALID_LANGUAGE", "请选择中文、日语、韩语或英语。");
  return value;
}

async function hash(value: string) {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function token() { return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""); }

async function rateLimit(key: string, max: number, duration: number) {
  const now = Date.now();
  const row = await db().prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
    expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`)
    .bind(key, now + duration, now, now).first<{ count: number }>();
  if (!row || row.count > max) throw new ApiError(429, "RATE_LIMIT", "操作太频繁，请稍后重试。");
}

async function callerKey(request: Request) {
  return hash(request.headers.get("oai-authenticated-user-id") || request.headers.get("cf-connecting-ip") || "local-preview");
}

async function cleanup() {
  const now = Date.now();
  await db().batch([
    db().prepare("DELETE FROM captions WHERE room_id IN (SELECT id FROM rooms WHERE expires_at<=?)").bind(now),
    db().prepare("DELETE FROM rooms WHERE expires_at<=?").bind(now),
    db().prepare("DELETE FROM rate_limits WHERE expires_at<=?").bind(now),
  ]);
}

function pausedCaptionCleanup(roomId: string) {
  return [
    db().prepare(`DELETE FROM captions WHERE room_id=? AND is_final=0
      AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state='paused' AND captions.generation<rooms.generation)`)
      .bind(roomId, roomId),
    db().prepare(`UPDATE captions SET translation_state='error' WHERE room_id=? AND is_final=1 AND translation_state='pending'
      AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state='paused' AND captions.generation<rooms.generation
        AND (device_mode='paired' OR captions.target_language IS NOT NULL))`)
      .bind(roomId, roomId),
  ];
}

function checkCapture(room: RoomRow, role: Role, input: Input, listening = true) {
  if (input.generation !== room.generation || input.captureGeneration !== room[`${role}_capture_generation`]) {
    throw new ApiError(409, "STALE_UPDATE", "收音状态已改变，请同步后重试。");
  }
  if (listening && (!room[`${role}_listening`] || room.guest_status !== "approved")) {
    throw new ApiError(409, "INVALID_STATE", "请先开启本机收音。");
  }
}

function checkRemoteCaptionId(room: RoomRow, role: Role, input: Input) {
  checkCapture(room, role, input);
  const prefix = `${role === "host" ? "h" : "g"}-${room[`${role}_capture_generation`]}-`;
  if (typeof input.id !== "string" || !input.id.startsWith(prefix) || input.id.length <= prefix.length) {
    throw new ApiError(400, "INVALID_CAPTION", "字幕必须属于本机当前的收音会话。");
  }
}

async function pauseRemoteCapture(room: RoomRow, role: Role, offline = false) {
  const other = role === "host" ? "guest" : "host", side = role === "host" ? "a" : "b";
  const currentGeneration = room[`${role}_capture_generation`], tokenHash = room[`${role}_token_hash`];
  const stopped = `EXISTS(SELECT 1 FROM rooms WHERE id=? AND device_mode='remote' AND generation=?
    AND ${role}_token_hash=? AND ${role}_listening=0 AND ${role}_capture_generation=?)`;
  await db().batch([
    db().prepare(`UPDATE rooms SET ${role}_listening=0,${role}_capture_generation=${role}_capture_generation+1,
      state=CASE WHEN ${other}_listening=1 THEN 'running' ELSE 'paused' END
      WHERE id=? AND device_mode='remote' AND state='running' AND generation=? AND ${role}_token_hash=?
        AND ${role}_listening=1 AND ${role}_capture_generation=? ${offline ? `AND (${role}_seen_at IS NULL OR ${role}_seen_at<?)` : ""}`)
      .bind(room.id, room.generation, tokenHash, currentGeneration, ...(offline ? [Date.now() - ONLINE_MS] : [])),
    db().prepare(`DELETE FROM captions WHERE room_id=? AND speaker_side=? AND is_final=0 AND ${stopped}`)
      .bind(room.id, side, room.id, room.generation, tokenHash, currentGeneration + 1),
    db().prepare(`UPDATE captions SET translation_state='error' WHERE room_id=? AND speaker_side=? AND is_final=1
      AND translation_state='pending' AND ${stopped}`)
      .bind(room.id, side, room.id, room.generation, tokenHash, currentGeneration + 1),
  ]);
}

export async function authorize(request: Request, id: unknown) {
  if (typeof id !== "string" || id.length > 64) throw new ApiError(400, "INVALID_INPUT", "房间编号无效。");
  const rawToken = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!rawToken) throw new ApiError(401, "UNAUTHORIZED", "请重新加入房间。");
  let room = await db().prepare("SELECT * FROM rooms WHERE id=?").bind(id).first<RoomRow>();
  if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "房间不存在或已经过期。");
  const tokenHash = await hash(rawToken);
  const role = tokenHash === room.host_token_hash ? "host" : tokenHash === room.guest_token_hash ? "guest" : null;
  if (!role) throw new ApiError(403, "UNAUTHORIZED", "你无权访问这个房间，请重新加入。");
  if (room.expires_at <= Date.now()) {
    await cleanup();
    throw new ApiError(410, "ROOM_EXPIRED", "本次会话已到 30 分钟，请创建新房间。");
  }
  if (room.device_mode === "remote" && room.state === "running") {
    for (const participant of ["host", "guest"] as const) {
      if (room[`${participant}_listening`] && (room[`${participant}_seen_at`] ?? 0) < Date.now() - ONLINE_MS) {
        await pauseRemoteCapture(room, participant, true);
      }
    }
    room = (await db().prepare("SELECT * FROM rooms WHERE id=?").bind(id).first<RoomRow>())!;
    if (!room || room[`${role}_token_hash`] !== tokenHash) throw new ApiError(403, "UNAUTHORIZED", "你已离开房间，请重新加入。");
  } else if (room.state === "running" && (room.host_seen_at < Date.now() - ONLINE_MS || (room.device_mode !== "solo" && (!room.guest_seen_at || room.guest_seen_at < Date.now() - ONLINE_MS)))) {
    const tokenField = role === "host" ? "host_token_hash" : "guest_token_hash";
    await db().batch([
      db().prepare(`UPDATE rooms SET state='paused',generation=generation+1 WHERE id=? AND state='running'
        AND generation=? AND ${tokenField}=? AND (host_seen_at<? OR (device_mode!='solo' AND (guest_seen_at IS NULL OR guest_seen_at<?)))`)
        .bind(id, room.generation, tokenHash, Date.now() - ONLINE_MS, Date.now() - ONLINE_MS),
      ...pausedCaptionCleanup(id),
    ]);
    room = (await db().prepare("SELECT * FROM rooms WHERE id=?").bind(id).first<RoomRow>())!;
    if (!room || (role === "host" ? room.host_token_hash : room.guest_token_hash) !== tokenHash) {
      throw new ApiError(403, "UNAUTHORIZED", "你已离开房间，请重新加入。");
    }
  }
  return { room, role } as { room: RoomRow; role: "host" | "guest" };
}

async function snapshot(roomId: string, role: "host" | "guest", expectedGuestHash?: string | null): Promise<RoomSnapshot> {
  const room = await db().prepare("SELECT * FROM rooms WHERE id=?").bind(roomId).first<RoomRow>();
  if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "房间已关闭。");
  if (role === "guest" && (!expectedGuestHash || room.guest_token_hash !== expectedGuestHash)) {
    throw new ApiError(403, "UNAUTHORIZED", "你已离开房间，请重新加入。");
  }
  const results = role === "guest" && room.guest_status !== "approved" ? [] :
    (await db().prepare(`SELECT captions.* FROM captions JOIN rooms ON rooms.id=captions.room_id
      WHERE room_id=? AND (?='host' OR rooms.guest_token_hash=?) ORDER BY captions.created_at,captions.id LIMIT 400`)
      .bind(room.id, role, expectedGuestHash || "").all<CaptionRow>()).results;
  return {
    id: room.id, code: room.code, state: room.state, mode: room.mode, deviceMode: room.device_mode,
    hostLanguage: room.host_language, guestLanguage: room.guest_language, guestStatus: room.guest_status,
    hostOnline: room.host_seen_at >= Date.now() - ONLINE_MS,
    guestOnline: Boolean(room.guest_seen_at && room.guest_seen_at >= Date.now() - ONLINE_MS),
    hostListening: Boolean(room.host_listening), guestListening: Boolean(room.guest_listening),
    hostCaptureGeneration: room.host_capture_generation, guestCaptureGeneration: room.guest_capture_generation,
    captions: results.map((item) => ({
      id: item.id, revision: item.revision, sourceLanguage: item.source_language, text: item.text,
      translation: item.translation, isFinal: Boolean(item.is_final), translationState: item.translation_state,
      createdAt: item.created_at, edited: Boolean(item.edited),
      speakerId: item.speaker_id, speakerSide: item.speaker_side,
      targetLanguage: item.target_language ?? (room.device_mode === "solo" ? null : targetLanguage(room, item.source_language)),
    })),
    startedAt: room.started_at, expiresAt: room.expires_at, demoIndex: room.demo_index, generation: room.generation,
  };
}

export async function getRoom(request: Request) {
  const { room, role } = await authorize(request, new URL(request.url).searchParams.get("roomId"));
  const field = role === "host" ? "host_seen_at" : "guest_seen_at";
  const tokenField = role === "host" ? "host_token_hash" : "guest_token_hash";
  const updated = await db().prepare(`UPDATE rooms SET ${field}=? WHERE id=? AND ${tokenField}=?`)
    .bind(Date.now(), room.id, role === "host" ? room.host_token_hash : room.guest_token_hash).run();
  if (!updated.meta.changes) throw new ApiError(403, "UNAUTHORIZED", "你已离开房间，请重新加入。");
  // Existing V0.1 guests can resume with their token without a now-removed approval step.
  if (role === "guest" && room.guest_status === "pending") {
    await db().prepare(`UPDATE rooms SET guest_status='approved',state='ready',generation=generation+1
      WHERE id=? AND guest_status='pending' AND guest_token_hash=? AND state IN ('waiting','ready')`)
      .bind(room.id, room.guest_token_hash).run();
  }
  return response({ room: await snapshot(room.id, role, room.guest_token_hash) });
}

export async function postRoom(request: Request) {
  const input = await readInput(request);
  if (input.action === "create") {
    await cleanup();
    await rateLimit("create:" + await callerKey(request), 12, 60 * 60_000);
    const lang = language(input.language);
    const deviceMode = input.deviceMode ?? "paired";
    if (deviceMode !== "paired" && deviceMode !== "solo" && deviceMode !== "remote") throw new ApiError(400, "INVALID_MODE", "请选择支持的对话模式。");
    const otherLanguage = deviceMode === "solo" ? language(input.otherLanguage) : null;
    if (input.mode !== "demo" && input.mode !== "live") throw new ApiError(400, "INVALID_MODE", "请选择演示或真实翻译。");
    if (deviceMode === "remote" && input.mode !== "live") throw new ApiError(400, "INVALID_MODE", "远程双端收音仅支持真实翻译。");
    if (input.mode === "live" && !speechReady()) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "尚未配置语音服务，请先体验演示模式。");
    const now = Date.now(), id = crypto.randomUUID(), rawToken = token();
    const code = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    await db().prepare(`INSERT INTO rooms (id,code,host_token_hash,host_language,mode,created_at,expires_at,host_seen_at,device_mode,guest_language,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id, code, await hash(rawToken), lang, input.mode, now, now + SESSION_MS, now, deviceMode, otherLanguage, deviceMode === "solo" ? "ready" : "waiting").run();
    const session: Session = { roomId: id, token: rawToken, role: "host", language: lang, code };
    return response({ session, room: await snapshot(id, "host") }, 201);
  }
  if (input.action === "join") {
    await cleanup();
    await rateLimit("join:" + await callerKey(request), 20, 60_000);
    if (typeof input.code !== "string" || !/^[A-Fa-f0-9]{8}$/.test(input.code)) throw new ApiError(400, "INVALID_CODE", "请输入 8 位房间码。");
    const lang = language(input.language);
    const room = await db().prepare("SELECT * FROM rooms WHERE code=? AND state!='ended' AND expires_at>?")
      .bind(input.code.toUpperCase(), Date.now()).first<RoomRow>();
    if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "房间不存在或已经结束。");
    if (room.device_mode === "solo") throw new ApiError(403, "SOLO_PRIVATE", "单手机对话不允许其他设备加入。");
    if (room.host_language === lang) throw new ApiError(400, "SAME_LANGUAGE", "双方需要选择不同语言。");
    const rawToken = token();
    const guestHash = await hash(rawToken);
    const result = await db().prepare(`UPDATE rooms SET guest_token_hash=?,guest_language=?,guest_status='approved',state='ready',guest_seen_at=?,generation=generation+1,
      host_listening=0,guest_listening=0,host_capture_generation=host_capture_generation+1,guest_capture_generation=guest_capture_generation+1
      WHERE id=? AND device_mode IN ('paired','remote') AND guest_status='none' AND state IN ('waiting','ready','paused') AND expires_at>?`)
      .bind(guestHash, lang, Date.now(), room.id, Date.now()).run();
    if (!result.meta.changes) throw new ApiError(409, "ROOM_FULL", "房间已有另一位参与者或待确认的加入请求。");
    const session: Session = { roomId: room.id, token: rawToken, role: "guest", language: lang, code: room.code };
    return response({ session, room: await snapshot(room.id, "guest", guestHash) });
  }
  const { room, role } = await authorize(request, input.roomId);
  if (room.state === "ended") throw new ApiError(409, "ROOM_ENDED", "对话已经结束。");
  if (input.action === "leave") {
    if (role !== "guest") throw new ApiError(403, "GUEST_ONLY", "房主离开请结束对话。");
    const results = await db().batch([
      db().prepare(`UPDATE rooms SET guest_token_hash=NULL,guest_language=NULL,guest_status='none',guest_seen_at=NULL,
        state='waiting',generation=generation+1,demo_index=0,started_at=NULL,last_translation_at=0,
        host_listening=0,guest_listening=0,host_capture_generation=host_capture_generation+1,guest_capture_generation=guest_capture_generation+1
        WHERE id=? AND guest_token_hash=? AND state!='ended'`)
        .bind(room.id, room.guest_token_hash),
      // A new participant must not receive the previous participant's transcript.
      db().prepare(`DELETE FROM captions WHERE room_id=? AND EXISTS(
        SELECT 1 FROM rooms WHERE id=? AND guest_status='none' AND state='waiting')`).bind(room.id, room.id),
    ]);
    if (!results[0].meta.changes) throw new ApiError(409, "INVALID_STATE", "加入状态已改变，请重新连接。");
    return response({ left: true });
  }
  if (input.action === "cancel-join") {
    if (role !== "guest" || room.guest_status !== "pending") throw new ApiError(409, "INVALID_STATE", "只有待确认的参与者可以取消加入。");
    const result = await db().prepare(`UPDATE rooms SET guest_token_hash=NULL,guest_language=NULL,guest_status='none',guest_seen_at=NULL,generation=generation+1
      WHERE id=? AND guest_status='pending' AND guest_token_hash=? AND state!='ended'`)
      .bind(room.id, room.guest_token_hash).run();
    if (!result.meta.changes) throw new ApiError(409, "INVALID_STATE", "加入状态已改变，请刷新页面。");
    return response({ left: true });
  }
  if (role === "guest" && room.guest_status !== "approved") throw new ApiError(403, "AWAITING_APPROVAL", "请等待房主确认加入。");
  await rateLimit("room:" + room.id + (room.device_mode === "remote" ? ":" + role : ""), 200, 60_000);
  const tokenField = role === "host" ? "host_token_hash" : "guest_token_hash";
  const tokenHash = role === "host" ? room.host_token_hash : room.guest_token_hash;
  if (["approve", "reject", "demo-next", ...(room.device_mode === "remote" ? [] : ["start", "caption", "discard-caption"])].includes(String(input.action)) && role !== "host") {
    throw new ApiError(403, "HOST_ONLY", "只有收音端可以执行此操作。");
  }
  let timing: TranslationTiming | undefined;
  switch (input.action) {
    case "approve": {
      const result = await db().prepare("UPDATE rooms SET guest_status='approved',state='ready',generation=generation+1 WHERE id=? AND guest_status='pending' AND state IN ('waiting','ready')")
        .bind(room.id).run();
      if (!result.meta.changes) throw new ApiError(409, "INVALID_STATE", "当前没有待确认的加入请求。");
      break;
    }
    case "reject":
      await db().prepare(`UPDATE rooms SET guest_token_hash=NULL,guest_language=NULL,guest_status='none',guest_seen_at=NULL,generation=generation+1
        WHERE id=? AND guest_status='pending'`).bind(room.id).run();
      break;
    case "start": {
      if (room.mode === "live" && !speechReady()) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "尚未配置语音服务。");
      if (room.device_mode === "remote") {
        checkCapture(room, role, input, false);
        const result = await db().prepare(`UPDATE rooms SET state='running',started_at=COALESCE(started_at,?),${role}_seen_at=?,
          ${role}_listening=1,${role}_capture_generation=${role}_capture_generation+1
          WHERE id=? AND device_mode='remote' AND state IN ('ready','paused','running') AND guest_status='approved'
            AND generation=? AND ${role}_token_hash=? AND ${role}_listening=0 AND ${role}_capture_generation=? AND expires_at>?`)
          .bind(Date.now(), Date.now(), room.id, room.generation, tokenHash, input.captureGeneration, Date.now()).run();
        if (!result.meta.changes) throw new ApiError(409, "NOT_READY", "请确认对方已加入，并同步本机收音状态后重试。");
        break;
      }
      const result = await db().prepare(`UPDATE rooms SET state='running',started_at=COALESCE(started_at,?),host_seen_at=?,generation=generation+1
        WHERE id=? AND state IN ('ready','paused') AND (device_mode='solo' OR (guest_status='approved' AND guest_seen_at>?))`)
        .bind(Date.now(), Date.now(), room.id, Date.now() - ONLINE_MS).run();
      if (!result.meta.changes) throw new ApiError(409, "NOT_READY", "请确认另一位参与者已加入并保持在线。");
      break;
    }
    case "pause":
      if (room.device_mode === "remote") {
        checkCapture(room, role, input, false);
        await pauseRemoteCapture(room, role);
        break;
      }
      await db().batch([
        db().prepare(`UPDATE rooms SET state='paused',generation=generation+1 WHERE id=? AND state='running' AND generation=? AND ${tokenField}=?`)
          .bind(room.id, room.generation, tokenHash),
        ...pausedCaptionCleanup(room.id),
      ]);
      break;
    case "end":
      await db().batch([
        db().prepare(`UPDATE rooms SET state='ended',generation=generation+1,host_listening=0,guest_listening=0,
          host_capture_generation=host_capture_generation+1,guest_capture_generation=guest_capture_generation+1
          WHERE id=? AND generation=? AND ${tokenField}=?`)
          .bind(room.id, room.generation, tokenHash),
        db().prepare(`DELETE FROM captions WHERE room_id=? AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state='ended' AND ${tokenField}=?)`)
          .bind(room.id, room.id, tokenHash),
      ]);
      break;
    case "demo-next":
      await nextDemo(room, input);
      break;
    case "caption":
      timing = await saveCaption(room, input, role);
      break;
    case "edit-caption":
    case "retry-translation":
      timing = await correctCaption(room, role, input);
      break;
    case "discard-caption":
      if (room.mode !== "live" || room.state !== "running") throw new ApiError(409, "INVALID_STATE", "当前未开启真实收音。");
      if (room.device_mode === "remote") checkRemoteCaptionId(room, role, input);
      if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || input.generation !== room.generation) {
        throw new ApiError(400, "INVALID_CAPTION", "字幕格式无效或已过期。");
      }
      await db().prepare(`DELETE FROM captions WHERE room_id=? AND id=? AND generation=? AND is_final=0
        AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state='running' AND generation=?
          ${room.device_mode === "remote" ? `AND ${role}_listening=1 AND ${role}_capture_generation=? AND ${role}_token_hash=?` : ""})`)
        .bind(room.id, input.id, room.generation, room.id, room.generation,
          ...(room.device_mode === "remote" ? [input.captureGeneration, tokenHash] : [])).run();
      break;
    default:
      throw new ApiError(400, "INVALID_ACTION", "未知操作。");
  }
  return response({ room: await snapshot(room.id, role, room.guest_token_hash), ...(timing ? { timing } : {}) });
}

const demoLines: Record<Language, string>[] = [
  { ja: "こんにちは。今日は来てくれてありがとうございます。", zh: "你好，谢谢你今天过来。", ko: "안녕하세요. 오늘 와 주셔서 감사합니다.", en: "Hello. Thank you for coming today." },
  { zh: "很高兴见到你，我们终于可以轻松聊天了。", ja: "お会いできてうれしいです。これで気軽に話せますね。", ko: "만나서 반가워요. 이제 편하게 이야기할 수 있겠네요.", en: "It's great to meet you. Now we can talk more easily." },
  { ja: "この近くに、おすすめのカフェはありますか？", zh: "这附近有什么推荐的咖啡馆吗？", ko: "이 근처에 추천할 만한 카페가 있나요?", en: "Can you recommend a cafe nearby?" },
  { zh: "前面那家很不错，步行大概五分钟。", ja: "この先のお店がおすすめです。歩いて五分くらいです。", ko: "앞에 있는 카페가 좋아요. 걸어서 오 분 정도예요.", en: "The one ahead is good. It's about a five-minute walk." },
  { ja: "いいですね。明日の午後三時はどうですか？", zh: "听起来不错，明天下午三点怎么样？", ko: "좋아요. 내일 오후 세 시는 어때요?", en: "Sounds good. How about three tomorrow afternoon?" },
  { zh: "可以，那我们明天下午三点在门口见。", ja: "大丈夫です。では、明日の午後三時に入口で会いましょう。", ko: "좋아요. 그럼 내일 오후 세 시에 입구에서 만나요.", en: "Sure. Let's meet at the entrance at three tomorrow afternoon." },
];

async function nextDemo(room: RoomRow, input: Input) {
  if (room.mode !== "demo" || room.state !== "running") throw new ApiError(409, "INVALID_STATE", "请先开始演示对话。");
  if (input.expectedDemoIndex !== room.demo_index) throw new ApiError(409, "STALE_UPDATE", "演示已更新，请刷新状态。");
  if (room.demo_index >= 800) throw new ApiError(409, "CAPTION_LIMIT", "本次对话已达到字幕上限，请创建新房间。");
  const step = room.demo_index, final = step % 2 === 1, line = demoLines[Math.floor(step / 2) % demoLines.length];
  const source = Math.floor(step / 2) % 2 === 0 ? room.guest_language! : room.host_language;
  const side = room.device_mode === "solo" ? (Math.floor(step / 2) % 2 === 0 ? "b" : "a") : null;
  const target = targetLanguage(room, source, side)!;
  const text = final ? line[source] : Array.from(line[source]).slice(0, Math.ceil(Array.from(line[source]).length / 2)).join("");
  const translated = final ? line[target] : "";
  const results = await db().batch([
    db().prepare("UPDATE rooms SET demo_index=demo_index+1 WHERE id=? AND demo_index=? AND state='running' AND generation=?")
      .bind(room.id, step, room.generation),
    db().prepare(`INSERT INTO captions (room_id,id,revision,source_language,text,translation,is_final,translation_state,created_at,generation,speaker_side,speaker_id,target_language)
      SELECT id,?,?,?,?,?,?,?,?,generation,?,?,? FROM rooms WHERE id=? AND demo_index=? AND state='running' AND generation=?
      ON CONFLICT(room_id,id) DO UPDATE SET revision=excluded.revision,text=excluded.text,translation=excluded.translation,
      is_final=excluded.is_final,translation_state=excluded.translation_state WHERE captions.revision<excluded.revision`)
      .bind("demo-" + Math.floor(step / 2), final ? 2 : 1, source, text, translated, final ? 1 : 0,
        final ? "done" : "pending", Date.now(), side, side ? `demo-${side}` : null, target, room.id, step + 1, room.generation),
  ]);
  if (!results[0].meta.changes) throw new ApiError(409, "STALE_UPDATE", "演示已更新，请刷新状态。");
}

async function saveCaption(room: RoomRow, input: Input, role: Role) {
  if (room.mode !== "live" || room.state !== "running") throw new ApiError(409, "INVALID_STATE", "当前未开启真实收音。");
  if (!speechReady()) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "尚未配置语音服务。");
  const source = language(input.sourceLanguage);
  const remote = room.device_mode === "remote", remoteSide = role === "host" ? "a" : "b";
  if (remote) {
    checkRemoteCaptionId(room, role, input);
    if (source !== room[`${role}_language`] || (input.speakerSide !== undefined && input.speakerSide !== remoteSide)
      || (input.speakerId !== undefined && input.speakerId !== null && input.speakerId !== role)) {
      throw new ApiError(400, "INVALID_CAPTION", "只能提交本机语言和身份的字幕。");
    }
  }
  const side = remote ? remoteSide : room.device_mode === "solo" ? speakerSide(input.speakerSide) : null;
  const speakerId = remote ? role : room.device_mode === "solo" ? input.speakerId ?? null : null;
  if (speakerId !== null && (typeof speakerId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(speakerId))) {
    throw new ApiError(400, "INVALID_CAPTION", "说话人标签无效。");
  }
  const target = targetLanguage(room, source, side);
  if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || Number(input.revision) > 10000
    || typeof input.text !== "string" || !input.text.trim() || input.text.length > 1000
    || typeof input.isFinal !== "boolean" || input.generation !== room.generation) {
    throw new ApiError(400, "INVALID_CAPTION", "字幕格式无效或已过期。");
  }
  const count = await db().prepare("SELECT count(*) AS n FROM captions WHERE room_id=?").bind(room.id).first<{ n: number }>();
  if (count && count.n >= 400 && !(await db().prepare("SELECT id FROM captions WHERE room_id=? AND id=?").bind(room.id, input.id).first())) {
    throw new ApiError(409, "CAPTION_LIMIT", "本次对话已达到字幕上限，请结束并创建新房间。");
  }
  // Compare against the current row atomically; a pre-read could reuse a superseded translation.
  const reusable = "captions.text=excluded.text AND captions.source_language=excluded.source_language AND captions.target_language=excluded.target_language AND captions.generation=excluded.generation AND captions.translation_state='done' AND captions.translation!=''";
  const changed = await db().prepare(`INSERT INTO captions (room_id,id,revision,source_language,text,translation,is_final,translation_state,created_at,generation,speaker_id,speaker_side,target_language)
    SELECT id,?,?,?,?,?,?,?, ?,generation,?,?,? FROM rooms WHERE id=? AND state='running' AND generation=? AND expires_at>?
      AND ((SELECT count(*) FROM captions WHERE room_id=rooms.id)<400 OR EXISTS(SELECT 1 FROM captions WHERE room_id=rooms.id AND id=?))
      ${remote ? `AND ${role}_listening=1 AND ${role}_capture_generation=? AND ${role}_token_hash=?` : ""}
    ON CONFLICT(room_id,id) DO UPDATE SET revision=excluded.revision,source_language=excluded.source_language,text=excluded.text,
    translation=CASE WHEN ${reusable} THEN captions.translation ELSE '' END,is_final=excluded.is_final,
    translation_state=CASE WHEN ${reusable} THEN 'done' ELSE 'pending' END,generation=excluded.generation,
    speaker_id=excluded.speaker_id,speaker_side=excluded.speaker_side,target_language=excluded.target_language
    WHERE captions.revision<excluded.revision AND captions.is_final=0 RETURNING translation_state`)
    .bind(input.id, input.revision, source, input.text.trim(), "", input.isFinal ? 1 : 0, "pending", Date.now(), speakerId, side, target, room.id, room.generation, Date.now(), input.id,
      ...(remote ? [input.captureGeneration, room[`${role}_token_hash`]] : []))
    .first<{ translation_state: Caption["translationState"] }>();
  if (!changed) {
    const capacity = await db().prepare("SELECT count(*) AS n FROM captions WHERE room_id=?").bind(room.id).first<{ n: number }>();
    if (capacity && capacity.n >= 400 && !(await db().prepare("SELECT id FROM captions WHERE room_id=? AND id=?").bind(room.id, input.id).first())) {
      throw new ApiError(409, "CAPTION_LIMIT", "本次对话已达到字幕上限，请结束并创建新房间。");
    }
    return;
  }
  if (target === null) return;
  if (changed.translation_state === "done") return { translationMs: null, translationReused: true };
  if (remote) {
    const claimed = await db().prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at WHERE expires_at<=? OR ?=1 RETURNING count`)
      .bind(`translation:${room.id}:${room.generation}:${role}:${input.captureGeneration}`, Date.now() + 700, Date.now(), input.isFinal ? 1 : 0).first();
    if (!claimed) return;
  } else {
    const claimed = await db().prepare("UPDATE rooms SET last_translation_at=? WHERE id=? AND (last_translation_at<? OR ?=1)")
      .bind(Date.now(), room.id, Date.now() - 700, input.isFinal ? 1 : 0).run();
    if (!claimed.meta.changes) return;
  }
  return translateCaption(room, input.id, Number(input.revision), source, target, input.text.trim(), false, role);
}

function speakerSide(value: unknown): "a" | "b" | null {
  if (value === undefined || value === null) return null;
  if (value !== "a" && value !== "b") throw new ApiError(400, "INVALID_CAPTION", "请选择说话人 A 或 B。");
  return value;
}

function targetLanguage(room: RoomRow, source: Language, side: "a" | "b" | null = null): Language | null {
  if (!room.guest_language || (source !== room.host_language && source !== room.guest_language)) {
    throw new ApiError(400, "INVALID_LANGUAGE", "字幕语言必须属于当前对话的两种语言。");
  }
  if (room.device_mode === "solo") return side === "a" ? room.guest_language : side === "b" ? room.host_language : null;
  return source === room.host_language ? room.guest_language : room.host_language;
}

async function correctCaption(room: RoomRow, role: "host" | "guest", input: Input) {
  if (!["running", "paused"].includes(room.state) || !room.guest_language) {
    throw new ApiError(409, "INVALID_STATE", "请在对话开始后修改已完成的字幕。");
  }
  if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || Number(input.revision) >= 10000) {
    throw new ApiError(400, "INVALID_CAPTION", "字幕格式无效或已过期。");
  }
  const caption = await db().prepare("SELECT * FROM captions WHERE room_id=? AND id=?").bind(room.id, input.id).first<CaptionRow>();
  if (!caption || !caption.is_final) throw new ApiError(409, "INVALID_CAPTION", "只能修改已完成的字幕。");
  if (room.device_mode !== "solo" && caption.source_language !== (role === "host" ? room.host_language : room.guest_language)) {
    throw new ApiError(403, "CAPTION_OWNER_ONLY", "只能修改自己语言的字幕。");
  }
  if (room.device_mode === "remote" && (caption.speaker_side !== (role === "host" ? "a" : "b")
    || (input.speakerSide !== undefined && input.speakerSide !== caption.speaker_side))) {
    throw new ApiError(403, "CAPTION_OWNER_ONLY", "只能修改本机发出的字幕，不能更换说话人。");
  }
  if (caption.revision !== input.revision) throw new ApiError(409, "STALE_UPDATE", "字幕已更新，请查看最新内容后重试。");
  const retry = input.action === "retry-translation";
  if (retry && caption.translation_state !== "error") throw new ApiError(409, "INVALID_STATE", "只能重试翻译失败的字幕。");
  if (!retry && (typeof input.text !== "string" || !input.text.trim() || input.text.length > 1000)) {
    throw new ApiError(400, "INVALID_CAPTION", "原文不能为空，且不能超过 1000 个字符。");
  }
  const text = retry ? caption.text : (input.text as string).trim();
  const side = room.device_mode === "solo" && !retry && input.speakerSide !== undefined ? speakerSide(input.speakerSide) : caption.speaker_side;
  if (room.device_mode === "solo" && !retry && input.speakerSide !== undefined && side === null) throw new ApiError(400, "INVALID_CAPTION", "请选择说话人 A 或 B。");
  const target = targetLanguage(room, caption.source_language, side);
  if (!retry && text === caption.text && side === caption.speaker_side) return;
  const revision = caption.revision + 1;
  const tokenField = role === "host" ? "host_token_hash" : "guest_token_hash";
  const tokenHash = role === "host" ? room.host_token_hash : room.guest_token_hash;
  const changed = await db().prepare(`UPDATE captions SET text=?,revision=?,edited=?,translation='',translation_state='pending',generation=?,speaker_side=?,target_language=?
    WHERE room_id=? AND id=? AND revision=? AND is_final=1 AND source_language=?
    AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state IN ('running','paused') AND generation=? AND expires_at>?
      AND ${tokenField}=? AND guest_token_hash IS ?)`)
    .bind(text, revision, retry ? caption.edited : 1, room.generation, side, target, room.id, input.id, caption.revision, caption.source_language,
      room.id, room.generation, Date.now(), tokenHash, room.guest_token_hash).run();
  if (!changed.meta.changes) throw new ApiError(409, "STALE_UPDATE", "字幕或会话已更新，请查看最新状态后重试。");
  if (target === null) return;
  return translateCaption(room, input.id, revision, caption.source_language, target, text, true, role);
}

async function translateCaption(room: RoomRow, id: string, revision: number, source: Language, target: Language, text: string, correction: boolean, role: Role) {
  let translated = "", state: "done" | "error" = "done";
  let translationMs: number | null = null;
  try {
    if (source === target) {
      translated = text;
    } else if (room.mode === "demo") {
      translated = ({ zh: "【演示】原文已更新，未执行真实翻译。", ja: "【デモ】原文を更新しました。実際の翻訳は行っていません。", ko: "【데모】원문을 수정했습니다. 실제 번역은 하지 않았습니다.", en: "[Demo] Original updated. No real translation was performed." })[target];
    } else {
      const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${TRANSLATOR_CODES[source]}&to=${TRANSLATOR_CODES[target]}`;
      const started = performance.now();
      try {
        const result = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY!,
            ...(env.AZURE_TRANSLATOR_REGION === "global" ? {} : { "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION! }) },
          body: JSON.stringify([{ Text: text }]),
          signal: AbortSignal.timeout(10_000),
        });
        if (!result.ok) throw new Error();
        const data = await result.json() as { translations?: { text?: string }[] }[];
        translated = data[0]?.translations?.[0]?.text || "";
        if (!translated) throw new Error();
      } finally { translationMs = Math.max(0, Math.round(performance.now() - started)); }
    }
  } catch { state = "error"; }
  await db().prepare(`UPDATE captions SET translation=?,translation_state=? WHERE room_id=? AND id=? AND revision=? AND generation=?
    AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND expires_at>? AND guest_token_hash IS ?
      AND (${correction ? "state IN ('running','paused')" : "state='running' AND generation=?"})
      ${room.device_mode === "remote" && !correction ? `AND ${role}_listening=1 AND ${role}_capture_generation=? AND ${role}_token_hash=?` : ""})`)
    .bind(translated, state, room.id, id, revision, room.generation, room.id, Date.now(), room.guest_token_hash,
      ...(correction ? [] : [room.generation]),
      ...(room.device_mode === "remote" && !correction ? [room[`${role}_capture_generation`], room[`${role}_token_hash`]] : [])).run();
  return { translationMs, translationReused: false };
}

export async function speechToken(request: Request) {
  const input = await readInput(request);
  const { room, role } = await authorize(request, input.roomId);
  const remote = room.device_mode === "remote";
  if (remote) checkCapture(room, role, input);
  if ((!remote && role !== "host") || room.state !== "running" || room.mode !== "live") {
    throw new ApiError(403, "HOST_ONLY", "只有正在收音的房主可以获取语音授权。");
  }
  if (!speechReady()) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "尚未配置语音服务。");
  await rateLimit("speech-token:" + room.id + (remote ? ":" + role : ""), 5, 60_000);
  const result = await fetch(`https://${env.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: "POST", headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY! }, signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new ApiError(502, "SPEECH_AUTH_FAILED", "语音服务授权失败，请检查服务配置。");
  const issuedToken = await result.text();
  const current = await authorize(request, input.roomId);
  if (current.role !== role || (!remote && current.role !== "host") || current.room.state !== "running" || current.room.generation !== room.generation) {
    throw new ApiError(409, "INVALID_STATE", "收音状态已改变，请重新开始。");
  }
  if (remote) checkCapture(current.room, role, input);
  return response({ token: issuedToken, region: env.AZURE_SPEECH_REGION, expiresAt: Date.now() + 9 * 60_000 });
}
