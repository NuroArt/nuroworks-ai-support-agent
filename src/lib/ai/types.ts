/**
 * Content is a plain string for ordinary turns, or an array of blocks once tool
 * use is in play. The blocks are kept provider-neutral here and translated by
 * each provider, because Anthropic and OpenAI disagree on every detail of them.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type GenerateOptions = {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Overrides the provider's configured chat model for this call. */
  model?: string;
  /** Claude only. Lower effort is faster and cheaper; ignored by OpenAI. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Receives text as it arrives. Passing this switches the call to streaming. */
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Advertised to the model. Omit to disable tool use for this call. */
  tools?: ToolSpec[];
};

export type GenerateResult = {
  text: string;
  usage: Usage;
  model: string;
  provider: string;
  /** Populated when the model asked for tools instead of answering. */
  toolCalls?: { id: string; name: string; input: unknown }[];
  /** 'tool_use' means the loop must run the tools and call again. */
  stopReason?: string;
  /** The assistant turn exactly as the provider returned it, to append to history. */
  raw?: ContentBlock[];
};

export interface AIProvider {
  readonly name: 'claude' | 'openai';
  /** Whether this provider can produce embeddings. Claude cannot. */
  readonly supportsEmbeddings: boolean;
  readonly defaultChatModel: string;
  /** A cheaper, faster model for classification and summarisation. */
  readonly fastModel: string;

  generate(opts: GenerateOptions): Promise<GenerateResult>;
  embed?(texts: string[]): Promise<{ vectors: number[][]; usage: Usage; model: string }>;
}

/**
 * Thrown with `retryable` so the service knows whether another attempt could
 * possibly succeed. A 401 never will; a 529 usually does.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const INTENTS = [
  'question',        // wants an answer from the knowledge base
  'needs_human',     // explicitly asking for a person or a ticket
  'status_check',    // asking about an existing ticket
  'chitchat',        // greeting, thanks, small talk
  'other',
] as const;

export type Intent = (typeof INTENTS)[number];

/** Retryable only on transient conditions. 4xx other than 429 is a bug, not luck. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 ||
         status === 503 || status === 504 || status === 529;
}
