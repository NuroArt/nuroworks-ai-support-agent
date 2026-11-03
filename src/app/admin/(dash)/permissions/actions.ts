'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { log } from '@/lib/log';
import type { PermissionLevel } from '@/generated/prisma/client';

const LEVELS = ['READ_ONLY', 'SUPPORT', 'OPERATIONS', 'SUPER'];

export async function setAgentPermission(form: FormData) {
  // Server actions are public endpoints; without this anyone could POST here.
  if (!(await isAuthenticated())) throw new Error('unauthorized');

  const level = String(form.get('level'));
  if (!LEVELS.includes(level)) throw new Error('invalid level');

  await db.adminSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', agentPermission: level as PermissionLevel },
    update: { agentPermission: level as PermissionLevel },
  });

  log.warn('agent permission level changed', { level });
  revalidatePath('/admin/permissions');
}

export async function setToolPolicy(form: FormData) {
  if (!(await isAuthenticated())) throw new Error('unauthorized');

  const toolName = String(form.get('toolName'));
  const enabled = form.get('enabled') === 'true';
  const approvalRaw = String(form.get('approvalRequired') ?? 'inherit');
  const approvalRequired = approvalRaw === 'inherit' ? null : approvalRaw === 'true';

  await db.toolPolicy.upsert({
    where: { toolName },
    create: { toolName, enabled, approvalRequired },
    update: { enabled, approvalRequired },
  });

  log.warn('tool policy changed', { toolName, enabled, approvalRequired });
  revalidatePath('/admin/permissions');
}
