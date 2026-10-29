/**
 * Customer 360 outreach tracking.
 *
 * A channel counts as reached when either:
 * - the CRM observed a real outbound message/call on that channel, or
 * - a sale manually marked it (for example after sending a Zalo friend request
 *   from a phone number the customer shared on Facebook).
 *
 * Automatic evidence wins over a manual mark so a sale cannot hide an actual
 * outbound message by unchecking the cell.
 */
export const OUTREACH_CHANNELS = ['FACEBOOK', 'ZALO'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];
export type OutreachSource = 'AUTO' | 'MANUAL' | null;

export interface OutreachState {
  reached: boolean;
  at: string | null;
  source: OutreachSource;
}

export const OUTREACH_CHANNEL_LABELS: Record<OutreachChannel, string> = {
  FACEBOOK: 'Facebook',
  ZALO: 'Zalo',
};

export function resolveOutreachState(
  manualAt: string | null | undefined,
  autoAt: string | null | undefined
): OutreachState {
  if (autoAt) return { reached: true, at: autoAt, source: 'AUTO' };
  if (manualAt) return { reached: true, at: manualAt, source: 'MANUAL' };
  return { reached: false, at: null, source: null };
}

export function canToggleOutreach(state: OutreachState): boolean {
  return !state.reached || state.source === 'MANUAL';
}

export function formatOutreachDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleDateString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return null;
  }
}
