import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NuroWorks AI Support Agent',
  description: 'AI support bot with knowledge base, ticketing, and human handoff.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-[#E6EDF8] antialiased">{children}</body>
    </html>
  );
}
