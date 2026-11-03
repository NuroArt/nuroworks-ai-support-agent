'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export async function saveSettings(form: FormData) {
  // Server actions are public endpoints. Without this check anyone could POST here.
  if (!(await isAuthenticated())) throw new Error('unauthorized');

  const raw = Number(form.get('confidenceFloor'));
  const floor = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.28;

  await db.adminSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      systemPrompt: String(form.get('systemPrompt') ?? '').slice(0, 8000),
      confidenceFloor: floor,
      escalationEnabled: form.get('escalationEnabled') === 'on',
    },
    update: {
      systemPrompt: String(form.get('systemPrompt') ?? '').slice(0, 8000),
      confidenceFloor: floor,
      escalationEnabled: form.get('escalationEnabled') === 'on',
    },
  });

  revalidatePath('/admin/settings');
}
