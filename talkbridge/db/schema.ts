import { integer, sqliteTable, text, primaryKey, index } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  hostTokenHash: text("host_token_hash").notNull(),
  guestTokenHash: text("guest_token_hash"),
  hostLanguage: text("host_language").notNull(),
  guestLanguage: text("guest_language"),
  guestStatus: text("guest_status").notNull().default("none"),
  mode: text("mode").notNull(),
  deviceMode: text("device_mode").notNull().default("paired"),
  state: text("state").notNull().default("waiting"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  startedAt: integer("started_at"),
  hostSeenAt: integer("host_seen_at").notNull(),
  guestSeenAt: integer("guest_seen_at"),
  hostListening: integer("host_listening").notNull().default(0),
  guestListening: integer("guest_listening").notNull().default(0),
  hostCaptureGeneration: integer("host_capture_generation").notNull().default(0),
  guestCaptureGeneration: integer("guest_capture_generation").notNull().default(0),
  demoIndex: integer("demo_index").notNull().default(0),
  generation: integer("generation").notNull().default(0),
  lastTranslationAt: integer("last_translation_at").notNull().default(0),
}, (table) => [index("rooms_expiry").on(table.expiresAt)]);

export const captions = sqliteTable("captions", {
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  revision: integer("revision").notNull(),
  sourceLanguage: text("source_language").notNull(),
  speakerId: text("speaker_id"),
  speakerSide: text("speaker_side"),
  targetLanguage: text("target_language"),
  text: text("text").notNull(),
  translation: text("translation").notNull().default(""),
  isFinal: integer("is_final").notNull(),
  edited: integer("edited").notNull().default(0),
  translationState: text("translation_state").notNull(),
  createdAt: integer("created_at").notNull(),
  generation: integer("generation").notNull(),
}, (table) => [primaryKey({ columns: [table.roomId, table.id] })]);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
