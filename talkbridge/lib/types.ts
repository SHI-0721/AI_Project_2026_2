export type Language = "zh" | "ja" | "ko" | "en";
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
  speakerId?: string | null;
  speakerSide?: "a" | "b" | null;
  targetLanguage?: Language | null;
  text: string;
  translation: string;
  isFinal: boolean;
  edited: boolean;
  translationState: "pending" | "done" | "error";
  createdAt: number;
};

export type RoomSnapshot = {
  id: string;
  code: string;
  state: RoomState;
  mode: RoomMode;
  deviceMode: "paired" | "solo" | "remote";
  hostLanguage: Language;
  guestLanguage: Language | null;
  guestStatus: "none" | "pending" | "approved";
  hostOnline: boolean;
  guestOnline: boolean;
  hostListening: boolean;
  guestListening: boolean;
  hostCaptureGeneration: number;
  guestCaptureGeneration: number;
  captions: Caption[];
  startedAt: number | null;
  expiresAt: number;
  demoIndex: number;
  generation: number;
};
