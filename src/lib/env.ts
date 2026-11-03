import { z } from 'zod';

/**
 * Fail at boot with a readable message rather than at 2am with `undefined is
 * not a string`. Every secret the app needs is declared here and nowhere else.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Secret echoed back by Telegram on every webhook call. Rejects forged posts. */
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  /** Numeric id of the staff group. Negative for supergroups. */
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),

  /** Claude is primary. OpenAI is the fallback, and the only embeddings source. */
  AI_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  /** Claude model for conversation. */
  CHAT_MODEL: z.string().default('claude-sonnet-5-5'),
  /** Cheaper Claude model for classification and summaries. */
  FAST_MODEL: z.string().default('claude-haiku-5-5'),
  /** Used when OpenAI serves a request, as fallback or as primary. */
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  ADMIN_PASSWORD: z.string().min(8),
  /** Used to sign the admin session cookie. */
  ADMIN_SESSION_SECRET: z.string().min(32),

  APP_URL: z.string().url().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

let cached: z.infer<typeof schema> | null = null;

export function env() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  cached = parsed.data;

  // Embeddings are OpenAI-only. Anthropic publishes no embeddings endpoint, so
  // retrieval needs an OpenAI key even when every conversation runs on Claude.
  if (!cached.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is required for knowledge-base embeddings, even with ' +
      'AI_PROVIDER=anthropic. Claude has no embeddings endpoint.'
    );
  }
  if (cached.AI_PROVIDER === 'anthropic' && !cached.ANTHROPIC_API_KEY) {
    throw new Error('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.');
  }
  return cached;
}
