import { env } from "cloudflare:workers";
import type { Caption, Language, RoomSnapshot, Session } from "./types";

type RoomRow = {
  id: string; code: string; host_token_hash: string; guest_token_hash: string | null;
  host_language: Language; guest_language: Language | null;
  guest_status: "none" | "pending" | "approved";
  mode: "demo" | "live"; state: RoomSnapshot["state"];
  created_at: number; expires_at: number; started_at: number | null;
  host_seen_at: number; guest_seen_at: number | null;
  demo_index: number; generation: number; last_translation_at: number;
};
type CaptionRow = {
  id: string; revision: number; source_language: Language; text: string;
  translation: string; is_final: number; translation_state: Caption["translationState"];
  created_at: number;
};
type Input = Record<string, unknown>;
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
  INVALID_LANGUAGE: "中国語または日本語を選択してください。",
  RATE_LIMIT: "操作が多すぎます。少し待ってからお試しください。",
  UNAUTHORIZED: "このルームにアクセスできません。もう一度参加してください。",
  ROOM_NOT_FOUND: "ルームが見つからないか、有効期限が切れています。",
  ROOM_EXPIRED: "30 分の制限時間になりました。新しいルームを作成してください。",
  INVALID_MODE: "デモまたは音声翻訳を選択してください。",
  SPEECH_NOT_CONFIGURED: "音声サービスが未設定です。デモをご利用ください。",
  INVALID_CODE: "8 桁のルームコードを入力してください。",
  SAME_LANGUAGE: "相手とは異なる言語を選択してください。",
  ROOM_FULL: "ルームは満員、または参加承認待ちです。",
  ROOM_ENDED: "会話は終了しました。",
  AWAITING_APPROVAL: "ホストの参加承認をお待ちください。",
  HOST_ONLY: "音声を収録するホストだけがこの操作を行えます。",
  INVALID_STATE: "現在の状態ではこの操作を行えません。",
  NOT_READY: "相手が承認済みでオンラインになっていることを確認してください。",
  INVALID_ACTION: "不明な操作です。",
  STALE_UPDATE: "状態が更新されています。もう一度お試しください。",
  CAPTION_LIMIT: "字幕数の上限に達しました。新しいルームを作成してください。",
  INVALID_CAPTION: "字幕の形式が無効、または古い更新です。",
  SPEECH_AUTH_FAILED: "音声サービスの認証に失敗しました。設定をご確認ください。",
  SERVER_ERROR: "サービスを利用できません。しばらくしてからお試しください。",
};

export async function route(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiError) return response({ error: error.message, errorJa: errorsJa[error.code] || errorsJa.SERVER_ERROR, code: error.code }, error.status);
    // Do not echo database errors, provider responses, request bodies, or credentials.
    return response({ error: "服务暂时不可用，请稍后重试。", errorJa: errorsJa.SERVER_ERROR, code: "SERVER_ERROR" }, 503);
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
  if (value !== "zh" && value !== "ja") throw new ApiError(400, "INVALID_LANGUAGE", "请选择中文或日语。");
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
      AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state='paused' AND captions.generation<rooms.generation)`)
      .bind(roomId, roomId),
  ];
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
  if (room.state === "running" && (room.host_seen_at < Date.now() - ONLINE_MS || !room.guest_seen_at || room.guest_seen_at < Date.now() - ONLINE_MS)) {
    await db().batch([
      db().prepare(`UPDATE rooms SET state='paused',generation=generation+1 WHERE id=? AND state='running'
        AND (host_seen_at<? OR guest_seen_at IS NULL OR guest_seen_at<?)`)
        .bind(id, Date.now() - ONLINE_MS, Date.now() - ONLINE_MS),
      ...pausedCaptionCleanup(id),
    ]);
    room = (await db().prepare("SELECT * FROM rooms WHERE id=?").bind(id).first<RoomRow>())!;
  }
  return { room, role } as { room: RoomRow; role: "host" | "guest" };
}

async function snapshot(roomId: string, role: "host" | "guest"): Promise<RoomSnapshot> {
  const room = await db().prepare("SELECT * FROM rooms WHERE id=?").bind(roomId).first<RoomRow>();
  if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "房间已关闭。");
  const results = role === "guest" && room.guest_status !== "approved" ? [] :
    (await db().prepare("SELECT * FROM captions WHERE room_id=? ORDER BY created_at,id LIMIT 400")
      .bind(room.id).all<CaptionRow>()).results;
  return {
    id: room.id, code: room.code, state: room.state, mode: room.mode,
    hostLanguage: room.host_language, guestLanguage: room.guest_language, guestStatus: room.guest_status,
    hostOnline: room.host_seen_at >= Date.now() - ONLINE_MS,
    guestOnline: Boolean(room.guest_seen_at && room.guest_seen_at >= Date.now() - ONLINE_MS),
    captions: results.map((item) => ({
      id: item.id, revision: item.revision, sourceLanguage: item.source_language, text: item.text,
      translation: item.translation, isFinal: Boolean(item.is_final), translationState: item.translation_state,
      createdAt: item.created_at,
    })),
    startedAt: room.started_at, expiresAt: room.expires_at, demoIndex: room.demo_index, generation: room.generation,
  };
}

export async function getRoom(request: Request) {
  const { room, role } = await authorize(request, new URL(request.url).searchParams.get("roomId"));
  const field = role === "host" ? "host_seen_at" : "guest_seen_at";
  await db().prepare(`UPDATE rooms SET ${field}=? WHERE id=?`).bind(Date.now(), room.id).run();
  return response({ room: await snapshot(room.id, role) });
}

export async function postRoom(request: Request) {
  const input = await readInput(request);
  if (input.action === "create") {
    await cleanup();
    await rateLimit("create:" + await callerKey(request), 12, 60 * 60_000);
    const lang = language(input.language);
    if (input.mode !== "demo" && input.mode !== "live") throw new ApiError(400, "INVALID_MODE", "请选择演示或真实翻译。");
    if (input.mode === "live" && !speechReady()) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "尚未配置语音服务，请先体验演示模式。");
    const now = Date.now(), id = crypto.randomUUID(), rawToken = token();
    const code = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    await db().prepare(`INSERT INTO rooms (id,code,host_token_hash,host_language,mode,created_at,expires_at,host_seen_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, code, await hash(rawToken), lang, input.mode, now, now + SESSION_MS, now).run();
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
    if (room.host_language === lang) throw new ApiError(400, "SAME_LANGUAGE", "双方需要选择不同语言。");
    const rawToken = token();
    const result = await db().prepare(`UPDATE rooms SET guest_token_hash=?,guest_language=?,guest_status='pending',guest_seen_at=?,generation=generation+1
      WHERE id=? AND guest_status='none' AND state!='ended' AND expires_at>?`)
      .bind(await hash(rawToken), lang, Date.now(), room.id, Date.now()).run();
    if (!result.meta.changes) throw new ApiError(409, "ROOM_FULL", "房间已有另一位参与者或待确认的加入请求。");
    const session: Session = { roomId: room.id, token: rawToken, role: "guest", language: lang, code: room.code };
    return response({ session, room: await snapshot(room.id, "guest") });
  }
  const { room, role } = await authorize(request, input.roomId);
  if (room.state === "ended") throw new ApiError(409, "ROOM_ENDED", "对话已经结束。");
  if (input.action === "cancel-join") {
    if (role !== "guest" || room.guest_status !== "pending") throw new ApiError(409, "INVALID_STATE", "只有待确认的参与者可以取消加入。");
    const result = await db().prepare(`UPDATE rooms SET guest_token_hash=NULL,guest_language=NULL,guest_status='none',guest_seen_at=NULL,generation=generation+1
      WHERE id=? AND guest_status='pending' AND guest_token_hash=? AND state!='ended'`)
      .bind(room.id, room.guest_token_hash).run();
    if (!result.meta.changes) throw new ApiError(409, "INVALID_STATE", "加入状态已改变，请刷新页面。");
    return response({ left: true });
  }
  if (role === "guest" && room.guest_status !== "approved") throw new ApiError(403, "AWAITING_APPROVAL", "请等待房主确认加入。");
  await rateLimit("room:" + room.id, 200, 60_000);
  if (["approve", "reject", "start", "caption", "discard-caption", "demo-next"].includes(String(input.action)) && role !== "host") {
    throw new ApiError(403, "HOST_ONLY", "只有收音端可以执行此操作。");
  }
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
      const result = await db().prepare(`UPDATE rooms SET state='running',started_at=COALESCE(started_at,?),host_seen_at=?,generation=generation+1
        WHERE id=? AND guest_status='approved' AND state IN ('ready','paused') AND guest_seen_at>?`)
        .bind(Date.now(), Date.now(), room.id, Date.now() - ONLINE_MS).run();
      if (!result.meta.changes) throw new ApiError(409, "NOT_READY", "请确认另一位参与者已加入并保持在线。");
      break;
    }
    case "pause":
      await db().batch([
        db().prepare("UPDATE rooms SET state='paused',generation=generation+1 WHERE id=? AND state='running'").bind(room.id),
        ...pausedCaptionCleanup(room.id),
      ]);
      break;
    case "end":
      await db().batch([
        db().prepare("UPDATE rooms SET state='ended',generation=generation+1 WHERE id=?").bind(room.id),
        db().prepare("DELETE FROM captions WHERE room_id=?").bind(room.id),
      ]);
      break;
    case "demo-next":
      await nextDemo(room, input);
      break;
    case "caption":
      await saveCaption(room, input);
      break;
    case "discard-caption":
      if (room.mode !== "live" || room.state !== "running") throw new ApiError(409, "INVALID_STATE", "当前未开启真实收音。");
      if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || input.generation !== room.generation) {
        throw new ApiError(400, "INVALID_CAPTION", "字幕格式无效或已过期。");
      }
      await db().prepare(`DELETE FROM captions WHERE room_id=? AND id=? AND generation=? AND is_final=0
        AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state='running' AND generation=?)`)
        .bind(room.id, input.id, room.generation, room.id, room.generation).run();
      break;
    default:
      throw new ApiError(400, "INVALID_ACTION", "未知操作。");
  }
  return response({ room: await snapshot(room.id, role) });
}

const demoLines: [Language, string, string][] = [
  ["ja", "こんにちは。今日は来てくれてありがとうございます。", "你好，谢谢你今天过来。"],
  ["zh", "很高兴见到你，我们终于可以轻松聊天了。", "お会いできてうれしいです。これで気軽に話せますね。"],
  ["ja", "この近くに、おすすめのカフェはありますか？", "这附近有什么推荐的咖啡馆吗？"],
  ["zh", "前面那家很不错，步行大概五分钟。", "この先のお店がおすすめです。歩いて五分くらいです。"],
  ["ja", "いいですね。明日の午後三時はどうですか？", "听起来不错，明天下午三点怎么样？"],
  ["zh", "可以，那我们明天下午三点在门口见。", "大丈夫です。では、明日の午後三時に入口で会いましょう。"],
];

async function nextDemo(room: RoomRow, input: Input) {
  if (room.mode !== "demo" || room.state !== "running") throw new ApiError(409, "INVALID_STATE", "请先开始演示对话。");
  if (input.expectedDemoIndex !== room.demo_index) throw new ApiError(409, "STALE_UPDATE", "演示已更新，请刷新状态。");
  if (room.demo_index >= 800) throw new ApiError(409, "CAPTION_LIMIT", "本次对话已达到字幕上限，请创建新房间。");
  const step = room.demo_index, final = step % 2 === 1, line = demoLines[Math.floor(step / 2) % demoLines.length];
  const text = final ? line[1] : Array.from(line[1]).slice(0, Math.ceil(Array.from(line[1]).length / 2)).join("");
  const translated = final ? line[2] : "";
  const results = await db().batch([
    db().prepare("UPDATE rooms SET demo_index=demo_index+1 WHERE id=? AND demo_index=? AND state='running' AND generation=?")
      .bind(room.id, step, room.generation),
    db().prepare(`INSERT INTO captions (room_id,id,revision,source_language,text,translation,is_final,translation_state,created_at,generation)
      SELECT id,?,?,?,?,?,?,?,?,generation FROM rooms WHERE id=? AND demo_index=? AND state='running' AND generation=?
      ON CONFLICT(room_id,id) DO UPDATE SET revision=excluded.revision,text=excluded.text,translation=excluded.translation,
      is_final=excluded.is_final,translation_state=excluded.translation_state WHERE captions.revision<excluded.revision`)
      .bind("demo-" + Math.floor(step / 2), final ? 2 : 1, line[0], text, translated, final ? 1 : 0,
        final ? "done" : "pending", Date.now(), room.id, step + 1, room.generation),
  ]);
  if (!results[0].meta.changes) throw new ApiError(409, "STALE_UPDATE", "演示已更新，请刷新状态。");
}

async function saveCaption(room: RoomRow, input: Input) {
  if (room.mode !== "live" || room.state !== "running") throw new ApiError(409, "INVALID_STATE", "当前未开启真实收音。");
  if (!speechReady()) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "尚未配置语音服务。");
  const source = language(input.sourceLanguage);
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
  const changed = await db().prepare(`INSERT INTO captions (room_id,id,revision,source_language,text,translation,is_final,translation_state,created_at,generation)
    SELECT id,?,?,?,?,?,?,?, ?,generation FROM rooms WHERE id=? AND state='running' AND generation=? AND expires_at>?
    ON CONFLICT(room_id,id) DO UPDATE SET revision=excluded.revision,source_language=excluded.source_language,text=excluded.text,
    translation='',is_final=excluded.is_final,translation_state='pending',generation=excluded.generation
    WHERE captions.revision<excluded.revision AND captions.is_final=0`)
    .bind(input.id, input.revision, source, input.text.trim(), "", input.isFinal ? 1 : 0, "pending", Date.now(), room.id, room.generation, Date.now()).run();
  if (!changed.meta.changes) return;
  // ponytail: one translation stream per room; isolate streams when multi-microphone mode is added.
  const claimed = await db().prepare("UPDATE rooms SET last_translation_at=? WHERE id=? AND (last_translation_at<? OR ?=1)")
    .bind(Date.now(), room.id, Date.now() - 1500, input.isFinal ? 1 : 0).run();
  if (!claimed.meta.changes) return;
  let translated = "", state: "done" | "error" = "done";
  try {
    const target = source === "zh" ? "ja" : "zh-Hans";
    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${source === "zh" ? "zh-Hans" : "ja"}&to=${target}`;
    const result = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY!,
        ...(env.AZURE_TRANSLATOR_REGION === "global" ? {} : { "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION! }) },
      body: JSON.stringify([{ Text: input.text.trim() }]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) throw new Error();
    const data = await result.json() as { translations?: { text?: string }[] }[];
    translated = data[0]?.translations?.[0]?.text || "";
    if (!translated) throw new Error();
  } catch { state = "error"; }
  await db().prepare(`UPDATE captions SET translation=?,translation_state=? WHERE room_id=? AND id=? AND revision=? AND generation=?
    AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND state='running' AND generation=? AND expires_at>?)`)
    .bind(translated, state, room.id, input.id, input.revision, room.generation, room.id, room.generation, Date.now()).run();
}

export async function speechToken(request: Request) {
  const input = await readInput(request);
  const { room, role } = await authorize(request, input.roomId);
  if (role !== "host" || room.state !== "running" || room.mode !== "live") {
    throw new ApiError(403, "HOST_ONLY", "只有正在收音的房主可以获取语音授权。");
  }
  if (!speechReady()) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "尚未配置语音服务。");
  await rateLimit("speech-token:" + room.id, 5, 60_000);
  const result = await fetch(`https://${env.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: "POST", headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY! }, signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new ApiError(502, "SPEECH_AUTH_FAILED", "语音服务授权失败，请检查服务配置。");
  return response({ token: await result.text(), region: env.AZURE_SPEECH_REGION, expiresAt: Date.now() + 9 * 60_000 });
}
