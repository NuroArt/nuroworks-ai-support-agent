import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

const COOKIE = 'nw_admin';
const MAX_AGE = 60 * 60 * 12;

function sign(payload: string): string {
  return createHmac('sha256', env().ADMIN_SESSION_SECRET).update(payload).digest('hex');
}

/** Constant-time compare — a plain === leaks the password through timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyPassword(input: string): boolean {
  return safeEqual(input, env().ADMIN_PASSWORD);
}

export async function createSession() {
  const expires = Date.now() + MAX_AGE * 1000;
  const payload = String(expires);
  const jar = await cookies();
  jar.set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return false;
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return false;
  if (!safeEqual(mac, sign(payload))) return false;
  return Number(payload) > Date.now();
}
