/**
 * Customer opt-out detection for Zalo care (PROJECT_MASTER §13: stop when the customer asks).
 *
 * Matching is done on whole words of diacritic-free text. Substring matching is unsafe in
 * Vietnamese: "huy" is contained in "chuyển", so "chuyển khoản" must NOT stop care.
 */

// Phrases that express "stop messaging me" anywhere in the message.
const OPT_OUT_PHRASES = [
  'dung lam phien',
  'ngung lam phien',
  'dung gui',
  'ngung gui',
  'dung nhan tin',
  'ngung nhan tin',
  'khong nhan tin nua',
  'khong muon nhan tin',
  'khong co nhu cau',
  'huy dang ky',
  'huy nhan tin',
  'tu choi nhan tin',
  'unsubscribe',
  'stop',
];

// Short command-style replies that mean opt-out only when they are the whole message.
const OPT_OUT_COMMANDS = new Set(['huy', 'dung', 'ngung', 'tu choi', 'khong', 'stop']);

export function normalizeForIntent(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function detectCareOptOut(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = normalizeForIntent(text);
  if (!normalized) return false;
  if (OPT_OUT_COMMANDS.has(normalized)) return true;

  const padded = ` ${normalized} `;
  return OPT_OUT_PHRASES.some((phrase) => padded.includes(` ${phrase} `));
}
