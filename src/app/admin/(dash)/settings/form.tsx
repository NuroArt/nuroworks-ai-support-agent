'use client';

import { useState } from 'react';
import { saveSettings } from './actions';

export function SettingsForm({
  initial,
}: {
  initial: { systemPrompt: string; confidenceFloor: number; escalationEnabled: boolean };
}) {
  const [saved, setSaved] = useState(false);

  return (
    <form
      action={async (fd) => { await saveSettings(fd); setSaved(true); }}
      className="mt-8 space-y-6"
    >
      <div>
        <label className="block text-sm font-medium">System prompt override</label>
        <p className="mb-2 text-xs text-muted">Leave empty to use the built-in prompt.</p>
        <textarea
          name="systemPrompt"
          defaultValue={initial.systemPrompt}
          rows={7}
          className="w-full rounded-lg border border-line bg-[#0C1424] p-3 font-mono text-xs text-white"
        />
      </div>

      <div>
        <label className="block text-sm font-medium">Confidence floor</label>
        <p className="mb-2 text-xs text-muted">
          Below this retrieval score the bot offers a human instead of answering. 0.28 is a sensible
          default; raise it if the bot answers things it should not.
        </p>
        <input
          type="number" name="confidenceFloor" step="0.01" min="0" max="1"
          defaultValue={initial.confidenceFloor}
          className="w-32 rounded-lg border border-line bg-[#0C1424] px-3 py-2 text-sm text-white"
        />
      </div>

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox" name="escalationEnabled"
          defaultChecked={initial.escalationEnabled}
          className="h-4 w-4 accent-[#00D4FF]"
        />
        Offer to create a ticket when confidence is low
      </label>

      <div className="flex items-center gap-3">
        <button className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-[#06121F] hover:brightness-110">
          Save settings
        </button>
        {saved && <span className="text-xs text-accent">Saved</span>}
      </div>
    </form>
  );
}
