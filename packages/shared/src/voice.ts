export type VoiceProviderName = "openai-realtime" | "nova-sonic";

export interface VoiceSessionConfig {
  provider: VoiceProviderName;
  model: string;
  clientSecret?: string;
  expiresAt?: string;
}

export interface VoiceProvider {
  readonly name: VoiceProviderName;
  readonly displayName: string;
}

export const OPENAI_REALTIME_PROVIDER: VoiceProvider = {
  name: "openai-realtime",
  displayName: "OpenAI Realtime",
};

export const NOVA_SONIC_PROVIDER: VoiceProvider = {
  name: "nova-sonic",
  displayName: "Amazon Nova 2 Sonic",
};

export const DEFAULT_VOICE_PROVIDER = OPENAI_REALTIME_PROVIDER;

export const OPENAI_REALTIME_MINI_MODEL = "gpt-realtime-2.1-mini";
export const OPENAI_REALTIME_FLAGSHIP_MODEL = "gpt-realtime-2.1";
