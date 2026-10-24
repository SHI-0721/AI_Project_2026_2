export type Language = "zh" | "ja";
export type RoomMode = "demo" | "live";
export type RoomState = "waiting" | "ready" | "running" | "paused" | "ended";

export type Session = {
  roomId: string;
  token: string;
  role: "host" | "guest";
  language: Language;
  code: string;
};

export type Caption = {
  id: string;
  revision: number;
  sourceLanguage: Language;
  text: string;
  translation: string;
  isFinal: boolean;
  translationState: "pending" | "done" | "error";
  createdAt: number;
};

export type RoomSnapshot = {
  id: string;
  code: string;
  state: RoomState;
  mode: RoomMode;
  hostLanguage: Language;
  guestLanguage: Language | null;
  guestStatus: "none" | "pending" | "approved";
  hostOnline: boolean;
  guestOnline: boolean;
  captions: Caption[];
  startedAt: number | null;
  expiresAt: number;
  demoIndex: number;
  generation: number;
};
