import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 does not load .env on its own. Node 22 can, and using the built-in
 * avoids adding dotenv just for the CLI. In production the variables are
 * already in the environment, so a missing file is not an error.
 */
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env — expected in Docker and CI */
}

/**
 * The connection URL lives here for migration and introspection commands.
 * The runtime client gets it from the driver adapter in src/lib/db.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
