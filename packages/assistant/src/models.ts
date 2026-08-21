export interface GeminiQuota {
  rpm: number;
  tpm: number;
  rpd: number;
  usedRpm?: number;
  usedTpm?: number;
  usedRpd?: number;
}

export interface AssistantModel {
  id: string;
  label: string;
  category: string;
  quota: GeminiQuota;
  supported: boolean;
  note?: string;
}

/**
 * 這份清單沿用 warehouse-inventory 的 AI Studio snapshot，供 Sandbox 選模型。
 * quota 是當時的快照，不代表 Gemini 現在的即時配額；真正請求仍以 API 回應為準。
 */
export const ASSISTANT_MODELS: AssistantModel[] = [
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", category: "Text-out models", quota: { rpm: 5, tpm: 250000, rpd: 20, usedRpm: 4, usedTpm: 15600, usedRpd: 19 }, supported: true },
  { id: "antigravity", label: "Antigravity", category: "Agents", quota: { rpm: 60, tpm: 100000, rpd: 100 }, supported: false, note: "不支援 Gemini generateContent" },
  { id: "deep-research-pro-preview", label: "Deep Research Pro Preview", category: "Agents", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-2-flash", label: "Gemini 2 Flash", category: "Text-out models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-2-flash-lite", label: "Gemini 2 Flash Lite", category: "Text-out models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "computer-use-preview", label: "Computer Use Preview", category: "Other models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", category: "Text-out models", quota: { rpm: 5, tpm: 250000, rpd: 20 }, supported: false, note: "目前帳號回傳 404，暫停選用" },
  { id: "nano-banana", label: "Nano Banana (Gemini 2.5 Flash Preview Image)", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", category: "Text-out models", quota: { rpm: 10, tpm: 250000, rpd: 20 }, supported: true },
  { id: "gemini-2.5-flash-tts", label: "Gemini 2.5 Flash TTS", category: "Multi-modal generative models", quota: { rpm: 3, tpm: 10000, rpd: 10 }, supported: false },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", category: "Text-out models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-2.5-pro-tts", label: "Gemini 2.5 Pro TTS", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-3-flash", label: "Gemini 3 Flash", category: "Text-out models", quota: { rpm: 5, tpm: 250000, rpd: 20 }, supported: true },
  { id: "nano-banana-pro", label: "Nano Banana Pro (Gemini 3 Pro Image)", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", category: "Text-out models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "nano-banana-2", label: "Nano Banana 2 (Gemini 3.1 Flash Image)", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", category: "Text-out models", quota: { rpm: 15, tpm: 250000, rpd: 500 }, supported: true },
  { id: "nano-banana-2-lite", label: "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-3.1-flash-tts", label: "Gemini 3.1 Flash TTS", category: "Multi-modal generative models", quota: { rpm: 3, tpm: 10000, rpd: 10 }, supported: false },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", category: "Text-out models", quota: { rpm: 5, tpm: 250000, rpd: 20 }, supported: true },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", category: "Text-out models", quota: { rpm: 15, tpm: 250000, rpd: 500 }, supported: true },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", category: "Text-out models", quota: { rpm: 5, tpm: 250000, rpd: 20 }, supported: true },
  { id: "gemini-embedding-1", label: "Gemini Embedding 1", category: "Other models", quota: { rpm: 100, tpm: 30000, rpd: 1000 }, supported: false },
  { id: "gemini-embedding-2", label: "Gemini Embedding 2", category: "Other models", quota: { rpm: 100, tpm: 30000, rpd: 1000 }, supported: false },
  { id: "gemini-omni-flash", label: "Gemini Omni Flash", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-robotics-er-1.5-preview", label: "Gemini Robotics ER 1.5 Preview", category: "Other models", quota: { rpm: 10, tpm: 250000, rpd: 20 }, supported: false },
  { id: "gemini-robotics-er-1.6-preview", label: "Gemini Robotics ER 1.6 Preview", category: "Other models", quota: { rpm: 5, tpm: 250000, rpd: 20 }, supported: false },
  { id: "gemini-robotics-er-2-preview", label: "Gemini Robotics ER 2 Preview", category: "Other models", quota: { rpm: 5, tpm: 250000, rpd: 20 }, supported: false },
  { id: "gemma-4-26b-a4b-it", label: "Gemma 4 26B", category: "Other models", quota: { rpm: 30, tpm: 16000, rpd: 14400 }, supported: true },
  { id: "gemma-4-31b-it", label: "Gemma 4 31B", category: "Other models", quota: { rpm: 30, tpm: 16000, rpd: 14400 }, supported: true },
  { id: "lyria-3-clip", label: "Lyria 3 Clip", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "lyria-3-pro", label: "Lyria 3 Pro", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "veo-3-fast-generate", label: "Veo 3 Fast Generate", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "veo-3-generate", label: "Veo 3 Generate", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "veo-3-lite-generate", label: "Veo 3 Lite Generate", category: "Multi-modal generative models", quota: { rpm: 0, tpm: 0, rpd: 0 }, supported: false },
  { id: "gemini-2.5-flash-native-audio-dialog", label: "Gemini 2.5 Flash Native Audio Dialog", category: "Live API", quota: { rpm: 0, tpm: 1000000, rpd: 0 }, supported: false },
  { id: "gemini-3-flash-live", label: "Gemini 3 Flash Live", category: "Live API", quota: { rpm: 0, tpm: 65000, rpd: 0 }, supported: false },
  { id: "gemini-3.5-live-translate", label: "Gemini 3.5 Live Translate", category: "Live API", quota: { rpm: 0, tpm: 20000, rpd: 0 }, supported: false },
];

export const DEFAULT_ASSISTANT_MODEL = "gemini-3.6-flash";
