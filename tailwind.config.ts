import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:      '#0F172A',
        surface: '#151F38',
        line:    '#24304C',
        primary: '#00D4FF',
        accent:  '#22C55E',
        muted:   '#7C8BAA',
      },
    },
  },
  plugins: [],
} satisfies Config;
