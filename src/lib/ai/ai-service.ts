import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { ClaudeProvider } from './providers/claude';
import { OpenAIProvider } from './providers/openai';
import { executeTool, toClaudeTools, type ToolContext } from '@/lib/tools/registry';
import {
  INTENTS,
  ProviderError,
  type AIProvider,
  type ChatMessage,
  type GenerateOptions,
  type GenerateResult,
  type ContentBlock,
  type Intent,
  type Usage,
} from './types';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
/** Ceiling on tool round-trips. A model that has not answered by now is looping. */
const MAX_TOOL_ITERATIONS = 6;

/**
 * The only AI entry point in the application.
 *
 * Nothing else imports a provider directly, so switching from Claude to OpenAI
 * is one environment variable. The service owns retries, provider fallback,
 * model selection and usage accounting so no caller has to think about them.
 */
export class AIService {
  private readonly primary: AIProvider;
  private readonly fallback: AIProvider | null;
  private readonly embedder: AIProvider | null;

  constructor() {
    const e = env();

    const claude = e.ANTHROPIC_API_KEY
      ? new ClaudeProvider(e.ANTHROPIC_API_KEY, e.CHAT_MODEL, e.FAST_MODEL)
      : null;
    const openai = e.OPENAI_API_KEY
      ? new OpenAIProvider(e.OPENAI_API_KEY, e.OPENAI_CHAT_MODEL, e.OPENAI_CHAT_MODEL, e.EMBEDDING_MODEL)
      : null;

    if (e.AI_PROVIDER === 'openai') {
      this.primary = openai ?? claude!;
      this.fallback = openai ? claude : null;
    } else {
      this.primary = claude ?? openai!;
      this.fallback = claude ? openai : null;
    }

    // Embeddings always go to whichever provider has them. Claude has none.
    this.embedder = [this.primary, this.fallback].find((p) => p?.supportsEmbeddings) ?? null;

    log.info('ai service ready', {
      primary: this.primary.name,
      fallback: this.fallback?.name ?? 'none',
      embedder: this.embedder?.name ?? 'none',
    });
  }

  get primaryName() { return this.primary.name; }
  get fallbackName() { return this.fallback?.name ?? null; }

  private async record(operation: string, provider: string, model: string, usage: Usage) {
    // Accounting must never break the request that produced it.
    try {
      await db.tokenUsage.create({
        data: {
          operation, provider, model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      });
    } catch (e) {
      log.warn('could not record token usage', { operation, reason: String(e) });
    }
  }

  /**
   * Retry the same provider on transient failures, then fall back to the other
   * one. A 401 or a malformed request is not retried — repeating it just burns
   * latency and ends in the same error.
   */
  private async attempt(provider: AIProvider, opts: GenerateOptions): Promise<GenerateResult> {
    let lastError: unknown;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        return await provider.generate(opts);
      } catch (e) {
        lastError = e;
        const retryable = e instanceof ProviderError ? e.retryable : false;
        if (!retryable || i === MAX_ATTEMPTS - 1) break;

        // Exponential backoff with jitter, so concurrent retries do not
        // synchronise into a second thundering herd.
        const delay = BASE_BACKOFF_MS * 2 ** i + Math.random() * 200;
        log.warn('retrying ai call', { provider: provider.name, attempt: i + 1, delayMs: Math.round(delay) });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async generateResponse(
    opts: GenerateOptions & { operation?: string },
  ): Promise<GenerateResult> {
    const operation = opts.operation ?? 'chat';

    try {
      const result = await this.attempt(this.primary, opts);
      void this.record(operation, result.provider, result.model, result.usage);
      return result;
    } catch (primaryError) {
      if (!this.fallback) throw primaryError;

      log.warn('primary provider failed, falling back', {
        primary: this.primary.name,
        fallback: this.fallback.name,
        reason: primaryError instanceof Error ? primaryError.message.slice(0, 200) : 'unknown',
      });

      // The fallback is a different vendor, so a model id for one is
      // meaningless to the other. Drop it and let the provider choose.
      const { model: _ignored, ...rest } = opts;
      const result = await this.attempt(this.fallback, rest);
      void this.record(`${operation}:fallback`, result.provider, result.model, result.usage);
      return result;
    }
  }


  /**
   * The tool-use loop.
   *
   * Claude decides whether to answer or to call a tool. Every tool_use block is
   * executed, the results go back in one user message, and the loop repeats
   * until the model stops asking. Bounded by MAX_TOOL_ITERATIONS so a model
   * that keeps calling tools cannot spend without limit.
   */
  async runWithTools(opts: {
    system: string;
    messages: ChatMessage[];
    ctx: ToolContext;
    maxTokens?: number;
    effort?: GenerateOptions['effort'];
  }): Promise<{ text: string; toolsUsed: string[]; iterations: number }> {
    const tools = await toClaudeTools();
    const history: ChatMessage[] = [...opts.messages];
    const toolsUsed: string[] = [];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const result = await this.generateResponse({
        system: opts.system,
        messages: history,
        tools,
        maxTokens: opts.maxTokens ?? 1024,
        effort: opts.effort,
        operation: i === 0 ? 'chat' : 'chat:tool_turn',
      });

      if (result.stopReason !== 'tool_use' || !result.toolCalls?.length) {
        return { text: result.text, toolsUsed, iterations: i + 1 };
      }

      // The assistant turn must be preserved verbatim, tool_use blocks included,
      // or the tool_result ids below reference nothing.
      history.push({
        role: 'assistant',
        content: (result.raw ?? result.toolCalls.map((c) => ({
          type: 'tool_use' as const, id: c.id, name: c.name, input: c.input,
        }))) as ContentBlock[],
      });

      // Parallel calls are run together and returned in a single user message,
      // which is what the API requires.
      const results = await Promise.all(
        result.toolCalls.map((call) => {
          toolsUsed.push(call.name);
          return executeTool(call, opts.ctx);
        }),
      );

      history.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }

    // Out of iterations. Ask for a plain answer with tools withheld, so the
    // user gets something rather than silence.
    log.warn('tool loop hit its ceiling', {
      userId: opts.ctx.userId, iterations: MAX_TOOL_ITERATIONS, toolsUsed,
    });

    const final = await this.generateResponse({
      system:
        opts.system +
        '\n\nYou have used your tool budget. Answer now from what the tool results already ' +
        'gave you. If you still cannot resolve it, say so and suggest opening a ticket.',
      messages: history,
      maxTokens: opts.maxTokens ?? 1024,
      operation: 'chat:tool_exhausted',
    });

    return { text: final.text, toolsUsed, iterations: MAX_TOOL_ITERATIONS };
  }

  /** Always OpenAI. Claude has no embeddings endpoint. */
  async embedText(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.embedder?.embed) {
      throw new Error(
        'No embeddings provider configured. Set OPENAI_API_KEY — ' +
        'Claude has no embeddings endpoint, so retrieval requires it.',
      );
    }
    const { vectors, usage, model } = await this.embedder.embed(texts);
    void this.record('embed', this.embedder.name, model, usage);
    return vectors;
  }

  /** Condense a transcript for an admin. Uses the fast model — this is not hard work. */
  async summarizeConversation(transcript: string): Promise<string> {
    const { text } = await this.generateResponse({
      system:
        'Summarise this support conversation in two or three sentences: what the user wanted, ' +
        'what was tried, and where it stands. Plain text only.',
      messages: [{ role: 'user', content: transcript.slice(-8000) }],
      model: this.primary.fastModel,
      maxTokens: 220,
      temperature: 0,
      effort: 'low',
      operation: 'summarize',
    });
    return text;
  }

  /** One line for the ticket list and the staff-group post. */
  async generateTicketSummary(transcript: string, fallback: string): Promise<string> {
    try {
      const { text } = await this.generateResponse({
        system:
          "Summarise the user's support problem in one sentence, under 120 characters. " +
          'State the problem only. No greeting, no preamble, no quotes.',
        messages: [{ role: 'user', content: transcript.slice(-4000) }],
        model: this.primary.fastModel,
        maxTokens: 80,
        temperature: 0,
        effort: 'low',
        operation: 'ticket_summary',
      });
      const cleaned = text.replace(/^["'\s]+|["'\s]+$/g, '');
      return cleaned.length > 4 ? cleaned.slice(0, 160) : fallback.slice(0, 160);
    } catch (e) {
      // A ticket must open even when every model is down.
      log.warn('ticket summary failed, using fallback', { reason: String(e) });
      return fallback.slice(0, 160);
    }
  }

  /**
   * Route a message without burning a full model call on "hi".
   * Falls back to `question`, which is the safe default: it sends the message
   * through retrieval rather than escalating or ignoring it.
   */
  async classifyIntent(message: string): Promise<Intent> {
    try {
      const { text } = await this.generateResponse({
        system:
          'Classify the user message into exactly one label and reply with that label alone.\n\n' +
          'question - asking how something works or why something failed\n' +
          'needs_human - explicitly asking for a person, an agent, or a ticket\n' +
          'status_check - asking about an existing ticket or request\n' +
          'chitchat - greeting, thanks, or small talk\n' +
          'other - anything else',
        messages: [{ role: 'user', content: message.slice(0, 1000) }],
        model: this.primary.fastModel,
        maxTokens: 12,
        temperature: 0,
        effort: 'low',
        operation: 'classify',
      });

      const label = text.toLowerCase().replace(/[^a-z_]/g, '') as Intent;
      return (INTENTS as readonly string[]).includes(label) ? label : 'question';
    } catch (e) {
      log.warn('intent classification failed, treating as question', { reason: String(e) });
      return 'question';
    }
  }

  /** Spend by operation, for the dashboard. */
  async usageSummary(sinceDays = 30) {
    const since = new Date(Date.now() - sinceDays * 24 * 3600_000);
    const rows = await db.tokenUsage.groupBy({
      by: ['operation', 'provider', 'model'],
      where: { createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      operation: r.operation,
      provider: r.provider,
      model: r.model,
      calls: r._count._all,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
    }));
  }
}

let instance: AIService | null = null;

/** Constructed lazily so importing this module never throws at build time. */
export function ai(): AIService {
  if (!instance) instance = new AIService();
  return instance;
}

export type { ChatMessage, GenerateResult, Intent };
