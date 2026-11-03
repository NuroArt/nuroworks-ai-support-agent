import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@prisma/client'],
};

export default config;
