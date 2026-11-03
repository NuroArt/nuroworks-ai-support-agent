import {
  ProviderError,
  isRetryableStatus,
  type AIProvider,
  type ChatMessage,
  type ContentBlock,
  type GenerateOptions,
  type GenerateResult,
} from '../types';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

type ClaudeBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Anthropic Claude — the primary provider.
 *
 * Model IDs are pinned snapshots (claude-sonnet-5-5, claude-haiku-5-5) and are
 * configurable through CHAT_MODEL and FAST_MODEL, so a newer model is a config
 * change rather than a code change.
 *
 * Claude has no embeddings endpoint, so `supportsEmbeddings` is false and
 * `embed` is deliberately absent. AIService routes embedding work to OpenAI.
 */
export class ClaudeProvider implements AIProvider {
  readonly name = 'claude' as const;
  readonly supportsEmbeddings = false;

  constructor(
    private readonly apiKey: string,
    readonly defaultChatModel = 'claude-sonnet-5-5',
    readonly fastModel = 'claude-haiku-5-5',
  ) {}

  private headers() {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': VERSION,
    };
  }

  /** Our neutral blocks happen to match Anthropic's shape, so this is a pass-through. */
  private toClaudeMessages(messages: ChatMessage[]) {
    return messages.map((m) => ({ role: m.role, content: m.content as string | ClaudeBlock[] }));
  }

  private body(o: GenerateOptions, stream: boolean) {
    return JSON.stringify({
      model: o.model ?? this.defaultChatModel,
      max_tokens: o.maxTokens ?? 1024,
      temperature: o.temperature,
      // Claude takes the system prompt as its own field, not as a message.
      system: o.system,
      messages: this.toClaudeMessages(o.messages),
      ...(o.tools?.length ? { tools: o.tools } : {}),
      // Sonnet 5.5 defaults to `high` effort, which is slow and costly for
      // support replies. Callers set it explicitly where it matters.
      ...(o.effort ? { output_config: { effort: o.effort } } : {}),
      ...(stream ? { stream: true } : {}),
    });
  }

  async generate(o: GenerateOptions): Promise<GenerateResult> {
    const model = o.model ?? this.defaultChatModel;
    // Streaming and tool use are not combined: the loop needs the complete
    // tool_use block before it can act, so streaming buys nothing there.
    return o.onDelta && !o.tools?.length ? this.stream(o, model) : this.once(o, model);
  }

  private async once(o: GenerateOptions, model: string): Promise<GenerateResult> {
    const res = await fetch(API, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(o, false),
      signal: o.signal,
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProviderError(
        `claude ${res.status}: ${detail}`, 'claude', res.status, isRetryableStatus(res.status),
      );
    }

    const data = (await res.json()) as {
      content: ClaudeBlock[];
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
      stop_reason?: string;
    };

    const toolCalls = data.content
      .filter((c): c is Extract<ClaudeBlock, { type: 'tool_use' }> => c.type === 'tool_use')
      .map((c) => ({ id: c.id, name: c.name, input: c.input }));

    return {
      text: data.content
        .filter((c): c is Extract<ClaudeBlock, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text).join('').trim(),
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      model: data.model ?? model,
      provider: 'claude',
      stopReason: data.stop_reason,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: data.content as ContentBlock[],
    };
  }

  /**
   * Server-sent events. Only text deltas are surfaced; thinking blocks and
   * other event types are ignored because this path never uses tools.
   */
  private async stream(o: GenerateOptions, model: string): Promise<GenerateResult> {
    const res = await fetch(API, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(o, true),
      signal: o.signal,
    });

    if (!res.ok || !res.body) {
      const detail = res.body ? (await res.text()).slice(0, 400) : 'no response body';
      throw new ProviderError(
        `claude ${res.status}: ${detail}`, 'claude', res.status, isRetryableStatus(res.status),
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let stopReason: string | undefined;
    const usage = { inputTokens: 0, outputTokens: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line, and a frame can span reads.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (evt.type === 'content_block_delta') {
          const delta = evt.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            text += delta.text;
            o.onDelta?.(delta.text);
          }
        } else if (evt.type === 'message_start') {
          const m = evt.message as { usage?: { input_tokens?: number } } | undefined;
          usage.inputTokens = m?.usage?.input_tokens ?? 0;
        } else if (evt.type === 'message_delta') {
          const u = evt.usage as { output_tokens?: number } | undefined;
          const d = evt.delta as { stop_reason?: string } | undefined;
          usage.outputTokens = u?.output_tokens ?? usage.outputTokens;
          stopReason = d?.stop_reason ?? stopReason;
        } else if (evt.type === 'error') {
          const e = evt.error as { message?: string } | undefined;
          throw new ProviderError(`claude stream: ${e?.message ?? 'unknown'}`, 'claude', undefined, true);
        }
      }
    }

    return { text: text.trim(), usage, model, provider: 'claude', stopReason };
  }
}
