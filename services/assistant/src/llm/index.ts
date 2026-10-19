// Provider selection by configuration (SystemDesign §7 "Model Providers"), mirroring Python Settings.llm_provider:
//   provider: LEADMAKER_ASSISTANT_LLM_PROVIDER || LEADMAKER_LLM_PROVIDER || auto
//     auto -> gemini when GEMINI_API_KEY/GOOGLE_API_KEY is set, else anthropic when ANTHROPIC_API_KEY is set, else
//     openai_compat when LEADMAKER_LLM_BASE_URL is set, else none (the assistant reports "not configured")
//   model: LEADMAKER_ASSISTANT_LLM_MODEL || LEADMAKER_LLM_MODEL (unless the assistant overrides the provider) || the default
// LEADMAKER_LLM_BASE_URL redirects Gemini only when gemini is chosen explicitly (in auto mode it is meant for
// openai_compat, and a Gemini key must never be sent to it). The fake needs LEADMAKER_ALLOW_FAKE_LLM=1 in production.
import { AnthropicProvider } from './anthropic.ts';
import { FakeProvider } from './fake.ts';
import { GeminiProvider } from './gemini.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import type { LlmProvider, ProviderName } from './types.ts';

export * from './types.ts';
export { toGeminiSchema, toJsonSchemaForProvider } from './schema.ts';

export const PROVIDER_NAMES: readonly ProviderName[] = ['gemini', 'anthropic', 'openai_compat', 'fake'];
// Gemini: the demo's free tier. gemini-3.5-flash-lite answers in 2-4 s and has a much larger free daily quota; the
// bigger gemini-3.8-flash (20 requests a day, 12-60 s on the free tier, measured 2026-10-19) is its fallback.
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  gemini: 'gemini-3.5-flash-lite', anthropic: 'claude-haiku-5-5', openai_compat: '', fake: 'fake-1',
};
/** LEADMAKER_ASSISTANT_FALLBACK_MODELS when unset ("none" turns fallbacks off). */
export const DEFAULT_FALLBACKS: Record<ProviderName, string> = {
  gemini: 'gemini-3.8-flash:20', anthropic: '', openai_compat: '', fake: '',
};

const val = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** The configured provider name (before auto resolution), lower-cased. */
export function providerSetting(env: NodeJS.ProcessEnv = process.env): string {
  return (val(env.LEADMAKER_ASSISTANT_LLM_PROVIDER) ?? val(env.LEADMAKER_LLM_PROVIDER) ?? 'auto').toLowerCase();
}

/** The provider auto/explicit selection resolves to, or null when nothing is configured. Throws on an unknown name. */
export function resolveProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName | null {
  const setting = providerSetting(env);
  if ((PROVIDER_NAMES as readonly string[]).includes(setting)) return setting as ProviderName;
  if (setting !== 'auto') {
    throw new Error(`LEADMAKER_ASSISTANT_LLM_PROVIDER / LEADMAKER_LLM_PROVIDER must be auto or one of ${PROVIDER_NAMES.join(', ')}`);
  }
  if (val(env.GEMINI_API_KEY) ?? val(env.GOOGLE_API_KEY)) return 'gemini';
  if (val(env.ANTHROPIC_API_KEY)) return 'anthropic';
  if (val(env.LEADMAKER_LLM_BASE_URL)) return 'openai_compat';
  return null;
}

export interface CreateProviderOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
}

export function createProvider(env: NodeJS.ProcessEnv = process.env, opts: CreateProviderOptions = {}): LlmProvider | null {
  const name = resolveProviderName(env);
  if (!name) return null;
  // LEADMAKER_LLM_MODEL names the shared provider's model: it does not apply when the assistant overrides the provider.
  const override = val(env.LEADMAKER_ASSISTANT_LLM_PROVIDER)?.toLowerCase();
  const shared = override === undefined || override === (val(env.LEADMAKER_LLM_PROVIDER)?.toLowerCase() ?? 'auto');
  const model = val(env.LEADMAKER_ASSISTANT_LLM_MODEL) ?? (shared ? val(env.LEADMAKER_LLM_MODEL) : undefined) ?? DEFAULT_MODELS[name];
  switch (name) {
    case 'gemini': {
      const explicit = providerSetting(env) === 'gemini';
      // Gemini 3 models think by default and thinking counts against maxOutputTokens: answer-first is "low".
      // ASSISTANT_GEMINI_THINKING_LEVEL overrides it ("off" sends no thinkingConfig).
      const level = val(env.ASSISTANT_GEMINI_THINKING_LEVEL) ?? (/^gemini-3/.test(model) ? 'low' : undefined);
      return new GeminiProvider({
        apiKey: val(env.GEMINI_API_KEY) ?? val(env.GOOGLE_API_KEY),
        model,
        baseUrl: explicit ? val(env.LEADMAKER_LLM_BASE_URL) : undefined,
        thinkingLevel: level && level !== 'off' ? level : undefined,
        fetch: opts.fetch,
        now: opts.now,
      });
    }
    case 'anthropic':
      return new AnthropicProvider({ apiKey: val(env.ANTHROPIC_API_KEY), model, fetch: opts.fetch });
    case 'openai_compat':
      return new OpenAICompatProvider({ baseUrl: val(env.LEADMAKER_LLM_BASE_URL), apiKey: val(env.LEADMAKER_LLM_API_KEY), model, fetch: opts.fetch });
    case 'fake':
      return new FakeProvider({
        model,
        allowed: env.LEADMAKER_ALLOW_FAKE_LLM === '1' || env.NODE_ENV !== 'production',
        delayMs: Number(env.LEADMAKER_FAKE_LLM_DELAY_MS) || 0,
        now: opts.now,
      });
  }
}

/** Secret values configured for the providers: redact.ts scrubs them from every log line and error. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'LEADMAKER_LLM_API_KEY', 'INTERNAL_TOKEN']
    .map((k) => val(env[k]))
    .filter((v): v is string => !!v && v.length >= 8);
}
