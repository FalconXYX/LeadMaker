// The assistant's provider-agnostic model interface (SystemDesign §7 "Model Providers"). One streaming chat call
// with tools; each provider maps it to its own wire format and classifies its errors into the classes below,
// which the engine maps to user-facing codes. Mirrors the Python layer in leadmaker/llm (same error taxonomy).

export type ProviderName = 'gemini' | 'anthropic' | 'openai_compat' | 'fake';

/** A tool the model may call; parameters is a JSON schema (converted per provider). */
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** The tool's name (tool messages). */
  name?: string;
  isError?: boolean;
  /** Provider-native turn for replay (Gemini thought signatures, Anthropic content blocks). */
  raw?: unknown;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  toolChoice: 'auto' | 'none' | 'required';
  maxOutputTokens: number;
}

export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  /** Cumulative for the call so far; may repeat as it grows (the engine charges the latest one). */
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'end'; stopReason: string; raw?: unknown };

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** `${name}:${model}`: budgets and logs key on it. */
  readonly fingerprint: string;
  isConfigured(): { ok: true } | { ok: false; reason: string };
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>;
}

type ErrorOpts = { provider: string; status?: number };

/** Base class. Messages are for logs only (after redaction); users always get fixed copy. */
export class LlmError extends Error {
  provider: string;
  status?: number;

  constructor(message: string, opts: ErrorOpts) {
    super(message);
    this.name = new.target.name;
    this.provider = opts.provider;
    this.status = opts.status;
  }
}

/** The daily (free tier) or billing quota is spent: stop calling until resetsAt. */
export class LlmQuotaExceeded extends LlmError {
  resetsAt: Date | null;
  scope: 'daily' | 'billing';

  constructor(message: string, opts: ErrorOpts & { resetsAt?: Date | null; scope?: 'daily' | 'billing' }) {
    super(message, opts);
    this.resetsAt = opts.resetsAt ?? null;
    this.scope = opts.scope ?? 'daily';
  }
}

/** Per-minute throttling (429); retryAfterMs from the provider's hint when it gave one. */
export class LlmRateLimited extends LlmError {
  retryAfterMs: number | null;

  constructor(message: string, opts: ErrorOpts & { retryAfterMs?: number | null }) {
    super(message, opts);
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** Bad or missing key, disabled API, unknown model: every call would fail the same way. */
export class LlmAuthError extends LlmError {}

/** The model answered but the output is unusable (safety block, truncation, malformed tool call). */
export class LlmOutputError extends LlmError {}

/** 5xx, network failures and other API errors. */
export class LlmApiError extends LlmError {}

/** The provider call ran past its deadline. */
export class LlmTimeoutError extends LlmError {}
