/** Shared by history and realtime. Only group messages carry the author prefix.
 * Ordinary text such as "Giá: 500k" must never be parsed as an author in a DM.
 */
export function presentGroupMessage(content: string, isGroup: boolean, author?: string) {
  if (!isGroup) return { content, senderName: undefined };
  if (author) {
    const prefix = `${author}:`;
    const legacyPrefix = /^([^\r\n]{1,200}?):(?:\s+|\r?\n)([\s\S]*)$/.exec(content);
    return { senderName: author, content: content.startsWith(prefix) ? content.slice(prefix.length).replace(/^\s+/, '') : legacyPrefix?.[2] ?? content };
  }
  const match = /^([^\r\n]{1,200}?):(?:\s+|\r?\n)([\s\S]*)$/.exec(content);
  return match ? { senderName: match[1].trim(), content: match[2] } : { senderName: undefined, content };
}
