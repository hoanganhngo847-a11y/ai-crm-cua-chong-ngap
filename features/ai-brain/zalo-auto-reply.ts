/**
 * Global operator switch for automated AI replies on Zalo.
 *
 * The durable source of truth is `ai_brain_live_settings.enabled` for channel
 * ZALO (AI Control Center). This environment switch is an additional emergency
 * brake so an operator can stop AI Zalo replies before a deployment finishes or
 * when the database setting must remain untouched.
 *
 * Default is enabled so existing installations/tests are unchanged.
 */
export function isZaloAiAutoReplyEnabled(): boolean {
  const raw = String(process.env.ZALO_AI_AUTO_REPLY_ENABLED || '')
    .trim()
    .toLowerCase();
  if (!raw) return true;
  return !['false', '0', 'off', 'no', 'disabled'].includes(raw);
}

export const ZALO_AI_AUTO_REPLY_DISABLED = 'AI_ZALO_AUTO_REPLY_DISABLED';
