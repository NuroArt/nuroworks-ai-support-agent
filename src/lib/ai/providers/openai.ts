import {
  ProviderError,
  isRetryableStatus,
  type AIProvider,
  type ChatMessage,
  type ContentBlock,
  type GenerateOptions,
  type GenerateResult,
  type Usage,
} from '../types';

const CHAT_API = 'https://api.openai.com/v1/chat/completions';
const EMBED_API = 'https://api.openai.com/v1/embeddings';

/**
 * OpenAI — the fallback chat provider, and the only embeddings source.
 *
 * Even when Claude handles every conversation, this provider is still required:
 * Anthropic publishes no embeddings endpoint, so retrieval depends on it.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai' as const;
  readonly supportsEmbeddings = true;

  constructor(
    private readonly apiKey: string,
    readonly defaultChatModel = 'gpt-4o-mini',
    readonly fastModel = 'gpt-4o-mini',
    private readonly embeddingModel = 'text-embedding-3-small',
  ) {}

  private headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
  }

  /**
   * Translate the neutral block format into OpenAI's, which differs in every
   * particular: tool calls live on the assistant message rather than in its
   * content, results are their own `tool` role, and arguments are a JSON string.
   */
  private toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];

    for (const m of messages) {
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content });
        continue;
      }

      if (m.role === 'assistant') {
        const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const calls = m.content.filter((b) => b.type === 'tool_use');
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length
            ? {
                tool_calls: calls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
                })),
              }
            : {}),
        });
        continue;
      }

      // Each tool_result becomes its own message with the `tool` role.
      const results = m.content.filter((b) => b.type === 'tool_result');
      for (const r of results) {
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content });
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) out.push({ role: 'user', content: text });
    }

    return out;
  }

  async generate(o: GenerateOptions): Promise<GenerateResult> {
    const model = o.model ?? this.defaultChatModel;
    // Tool use is resolved non-streaming, same as the Claude provider.
    const stream = Boolean(o.onDelta) && !o.tools?.length;

    const res = await fetch(CHAT_API, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model,
        max_tokens: o.maxTokens ?? 1024,
        temperature: o.temperature ?? 0.3,
        // OpenAI takes the system prompt as the first message, unlike Claude.
        // OpenAI takes the system prompt as the first message, unlike Claude.
        messages: [{ role: 'system', content: o.system }, ...this.toOpenAIMessages(o.messages)],
        ...(o.tools?.length
          ? {
              tools: o.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.input_schema },
              })),
            }
          : {}),
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
      signal: o.signal,
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProviderError(
        `openai ${res.status}: ${detail}`, 'openai', res.status, isRetryableStatus(res.status),
      );
    }

    if (!stream) {
      const data = (await res.json()) as {
        choices: {
          message: {
            content: string | null;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };

      const choice = data.choices[0];
      const text = choice?.message?.content?.trim() ?? '';

      const toolCalls = (choice?.message?.tool_calls ?? []).map((c) => {
        let input: unknown = {};
        // Arguments arrive as a JSON string and the model occasionally emits
        // malformed JSON. An empty object lets schema validation produce a
        // useful message instead of throwing here.
        try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = {}; }
        return { id: c.id, name: c.function.name, input };
      });

      const raw: ContentBlock[] = [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })),
      ];

      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
        model: data.model ?? model,
        provider: 'openai',
        // Normalised to Anthropic's vocabulary so the loop has one condition.
        stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : choice?.finish_reason,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        raw,
      };
    }

    if (!res.body) throw new ProviderError('openai: no response body', 'openai', undefined, true);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let evt: {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          evt = JSON.parse(payload) as typeof evt;
        } catch {
          continue;
        }

        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) { text += delta; o.onDelta?.(delta); }
        if (evt.usage) {
          usage.inputTokens = evt.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = evt.usage.completion_tokens ?? usage.outputTokens;
        }
      }
    }

    return { text: text.trim(), usage, model, provider: 'openai' };
  }

  async embed(texts: string[]) {
    if (texts.length === 0) {
      return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 }, model: this.embeddingModel };
    }

    const vectors: number[][] = [];
    let inputTokens = 0;

    // Batched; 96 keeps each request well inside the endpoint's token limit.
    for (let i = 0; i < texts.length; i += 96) {
      const res = await fetch(EMBED_API, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.embeddingModel, input: texts.slice(i, i + 96) }),
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 400);
        throw new ProviderError(
          `openai embeddings ${res.status}: ${detail}`, 'openai', res.status, isRetryableStatus(res.status),
        );
      }

      const data = (await res.json()) as {
        data: { index: number; embedding: number[] }[];
        usage?: { prompt_tokens?: number };
      };
      // Order is documented but not guaranteed across retries; sort to be safe.
      data.data.sort((a, b) => a.index - b.index).forEach((d) => vectors.push(d.embedding));
      inputTokens += data.usage?.prompt_tokens ?? 0;
    }

    return { vectors, usage: { inputTokens, outputTokens: 0 }, model: this.embeddingModel };
  }
}
