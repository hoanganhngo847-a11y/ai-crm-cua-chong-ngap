import fs from 'node:fs';

const file = 'src/apis/listen.ts';
let source = fs.readFileSync(file, 'utf8');
if (!source.includes('CRM_GROUP_HISTORY_RECOVERY')) {
  const replace = (anchor, replacement) => {
    if (!source.includes(anchor)) throw new Error('Group history patch anchor missing: ' + anchor);
    source = source.replace(anchor, replacement);
  };
  replace('    private oldMessageRequestId = 0;', `    private oldMessageRequestId = 0;
    // CRM_GROUP_HISTORY_RECOVERY: bounded pagination per command, every reconnect/poll.
    private historyPages = new Map<number, number>();
    private historyCursors = new Map<number, string>();`);
  // WebSocket errors must reach the worker and close the socket so its existing
  // reconnect path runs; the pinned listener otherwise has no error handler.
  replace('        ws.onclose = () => {', `        ws.onerror = (event) => {
            this.onErrorCallback(event.error);
            this.emit("error", event.error);
            ws.close();
        };

        ws.onclose = () => {`);
  replace('if (cmd == 510 && s == 1)', 'if ((cmd == 510 || cmd == 511) && s == 1)');
  replace('const msgs = Array.isArray(parsedData?.msgs) ? parsedData.msgs : [];', `const raw = cmd == 511 ? parsedData?.groupMsgs : parsedData?.msgs;
                    const msgs = Array.isArray(raw) ? raw : [];`);
  replace('const messageObject = new Message(msg);\n                        if (messageObject.isSelf', 'const messageObject = cmd == 511 ? new GroupMessage(msg) : new Message(msg);\n                        (messageObject as any).__zaloRecovered = true;\n                        if (messageObject.isSelf');
  // Seven days is a recovery window, not a promise of complete Zalo history.
  replace('if (Date.now() - messageMs > 24 * 60 * 60 * 1000) continue;', 'if (Date.now() - messageMs > 7 * 24 * 60 * 60 * 1000) continue;');
  const boundary = '                if (n == 1 && cmd == 601 && s == 0) {';
  replace(boundary, `                if ((cmd == 510 || cmd == 511) && s == 1) {
                    const payload = (await decodeEventData(parsed, this.cipherKey)).data;
                    const batch = cmd == 511 ? payload?.groupMsgs : payload?.msgs;
                    if (Array.isArray(batch) && batch.length) {
                        const oldest = batch.reduce((a: any, b: any) => Number(a.ts) < Number(b.ts) ? a : b);
                        const ts = Number(oldest.ts);
                        const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
                        const cursor = String(oldest.msgId || "");
                        const pages = this.historyPages.get(cmd) || 0;
                        if (cursor && cursor !== this.historyCursors.get(cmd) && pages < 100 && ms >= Date.now() - 7 * 24 * 60 * 60 * 1000) {
                            this.historyCursors.set(cmd, cursor);
                            this.historyPages.set(cmd, pages + 1);
                            this.requestOldDirectMessages(cmd, cursor);
                        }
                    }
                }

` + boundary);
  replace('private requestOldDirectMessages() {', `private requestOldDirectMessages(command?: number, lastId: string | null = null) {
        if (!command) {
            this.historyPages.clear();
            this.historyCursors.clear();
            this.requestOldDirectMessages(510);
            this.requestOldDirectMessages(511);
            return;
        }`);
  replace('            lastId: null,', '            lastId,');
  replace('frame.writeUInt16LE(510, 1);', 'frame.writeUInt16LE(command, 1);');
  fs.writeFileSync(file, source);
}
