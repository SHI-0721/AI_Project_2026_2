import type { Language } from "./types";

export const LANGUAGE_CODES = ["zh", "ja", "ko", "en"] as const;
export const LANGUAGE_NAMES: Record<Language, string> = { zh: "中文", ja: "日本語", ko: "한국어", en: "English" };
export const SPEECH_LOCALES: Record<Language, string> = { zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", en: "en-US" };
export const TRANSLATOR_CODES: Record<Language, string> = { zh: "zh-Hans", ja: "ja", ko: "ko", en: "en" };
export function isLanguage(value: unknown): value is Language {
  return value === "zh" || value === "ja" || value === "ko" || value === "en";
}
