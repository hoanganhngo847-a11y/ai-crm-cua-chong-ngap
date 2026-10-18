import fs from 'node:fs';

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Patch anchor not found: ${label}`);
  const next = source.replace(search, replacement);
  if (next === source) throw new Error(`Patch did not change file: ${label}`);
  return next;
}

function patchInboxView() {
  const file = 'features/inbox/components/inbox-view.tsx';
  let source = fs.readFileSync(file, 'utf8');

  source = replaceOnce(
    source,
    "import MessageContent from './message-content';\n",
    "import MessageContent from './message-content';\nimport ZaloComposer from './zalo-composer';\n",
    'InboxView composer import'
  );

  const handlerAnchor = `  const isSendingCurrent = Boolean(selectedConversationId && sendingByConversation[selectedConversationId]);`;
  const handlerBlock = `  const handleQuickSend = async (text: string): Promise<boolean> => {
    if (!selectedConversationId || sendingByConversation[selectedConversationId]) return false;
    const convId = selectedConversationId;
    const cleanText = text.trim();
    if (!cleanText) return false;

    const commandId = crypto.randomUUID();
    setSendingByConversation((prev) => ({ ...prev, [convId]: true }));
    setSendErrorByConversation((prev) => ({ ...prev, [convId]: null }));

    try {
      const res = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          content: cleanText,
          client_command_id: commandId,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        const message = json?.message || json?.error || \`Gửi tin nhắn thất bại (HTTP \${res.status})\`;
        setSendErrorByConversation((prev) => ({ ...prev, [convId]: message }));
        return false;
      }

      void fetchMessages(convId, { silent: true });
      void fetchConversations({ silent: true });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Lỗi kết nối khi gửi tin nhắn';
      setSendErrorByConversation((prev) => ({ ...prev, [convId]: message }));
      return false;
    } finally {
      setSendingByConversation((prev) => ({ ...prev, [convId]: false }));
    }
  };

  const handleSendMedia = async (files: File[], caption: string): Promise<boolean> => {
    if (!selectedConversationId || files.length === 0) return false;
    const convId = selectedConversationId;
    const conversation = conversations.find((item) => item.id === convId);
    if (!conversation || conversation.channel !== 'zalo') {
      setSendErrorByConversation((prev) => ({
        ...prev,
        [convId]: 'Gửi ảnh/tệp trực tiếp hiện chỉ hỗ trợ hội thoại Zalo.',
      }));
      return false;
    }
    if (sendingByConversation[convId]) return false;

    setSendingByConversation((prev) => ({ ...prev, [convId]: true }));
    setSendErrorByConversation((prev) => ({ ...prev, [convId]: null }));

    try {
      const formData = new FormData();
      formData.set('conversation_id', convId);
      formData.set('caption', caption.trim());
      files.forEach((file) => formData.append('files', file, file.name));

      const res = await fetch('/api/inbox/zalo-zcajs/media', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        const message = json?.message || json?.error || \`Gửi ảnh/tệp thất bại (HTTP \${res.status})\`;
        setSendErrorByConversation((prev) => ({ ...prev, [convId]: message }));
        return false;
      }

      setDraftsByConversation((prev) => ({ ...prev, [convId]: '' }));
      const preview = caption.trim() || (files.length === 1 ? '[Đã gửi 1 tệp]' : \`[Đã gửi \${files.length} tệp]\`);
      setConversations((prev) =>
        prev.map((item) => item.id === convId ? { ...item, last_message: preview } : item)
      );

      // The ZCAJS self-listener returns the canonical provider media payload (including CDN URL).
      // Reconcile shortly after acceptance in addition to realtime, without re-sending the media.
      setTimeout(() => {
        if (activeConversationRef.current === convId) void fetchMessages(convId, { silent: true });
        void fetchConversations({ silent: true });
      }, 700);
      setTimeout(() => {
        if (activeConversationRef.current === convId) void fetchMessages(convId, { silent: true });
      }, 1800);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Lỗi kết nối khi gửi ảnh/tệp';
      setSendErrorByConversation((prev) => ({ ...prev, [convId]: message }));
      return false;
    } finally {
      setSendingByConversation((prev) => ({ ...prev, [convId]: false }));
    }
  };

${handlerAnchor}`;
  source = replaceOnce(source, handlerAnchor, handlerBlock, 'InboxView media handlers');

  const composerStart = `                  <div className="flex items-end gap-2">\n                    <textarea`;
  const startIndex = source.indexOf(composerStart);
  if (startIndex < 0) throw new Error('Patch anchor not found: old composer start');

  const composerEnd = `                  <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">\n                    <span>Quy tắc 5 phút: Nếu Sale trả lời, AI tự động nhường quyền xử lý.</span>\n                    <span className="text-slate-400">Shift + Enter để xuống dòng</span>\n                  </div>`;
  const endIndex = source.indexOf(composerEnd, startIndex);
  if (endIndex < 0) throw new Error('Patch anchor not found: old composer end');

  const composerReplacement = `                  <ZaloComposer
                    channel={selectedConversation.channel}
                    draft={currentDraft}
                    disabled={isSendingCurrent}
                    aiLoading={isLoadingAiCurrent}
                    customerName={selectedConversation.customer_name}
                    customerPhone={selectedConversation.customer_phone}
                    onDraftChange={handleDraftChange}
                    onSendText={() => handleSendMessage()}
                    onQuickSend={handleQuickSend}
                    onSendMedia={handleSendMedia}
                    onRequestAi={handleRequestAiSuggestion}
                  />

                  <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
                    <span>Quy tắc 5 phút: Nếu Sale trả lời, AI tự động nhường quyền xử lý.</span>
                    <span className="text-slate-400">Khung chat hỗ trợ dán ảnh trực tiếp từ clipboard trên Zalo.</span>
                  </div>`;

  source = source.slice(0, startIndex) + composerReplacement + source.slice(endIndex + composerEnd.length);
  fs.writeFileSync(file, source);
}

function patchWorker() {
  const file = 'zalo-zcajs-worker/src/index.mjs';
  let source = fs.readFileSync(file, 'utf8');

  source = replaceOnce(
    source,
    `import http from 'http';\n`,
    `import http from 'http';\nimport fs from 'fs/promises';\nimport os from 'os';\nimport path from 'path';\n`,
    'worker fs imports'
  );

  source = replaceOnce(
    source,
    `const MAX_BODY_BYTES = 64 * 1024;\n`,
    `const MAX_BODY_BYTES = 64 * 1024;\nconst MAX_MEDIA_BODY_BYTES = 30 * 1024 * 1024;\nconst MAX_MEDIA_FILES = 5;\nconst MAX_MEDIA_FILE_BYTES = 10 * 1024 * 1024;\nconst MAX_MEDIA_TOTAL_BYTES = 20 * 1024 * 1024;\n`,
    'worker media limits'
  );

  source = replaceOnce(
    source,
    `async function readJson(req) {\n`,
    `async function readJson(req, maxBodyBytes = MAX_BODY_BYTES) {\n`,
    'worker readJson signature'
  );
  source = replaceOnce(
    source,
    `    if (total > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');\n`,
    `    if (total > maxBodyBytes) throw new Error('BODY_TOO_LARGE');\n`,
    'worker readJson limit'
  );

  const requestHandlerAnchor = `function requestHandler(req, res) {`;
  const mediaHandler = `function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'audio/mpeg') return '.mp3';
  if (mime === 'application/pdf') return '.pdf';
  return '';
}

function safeMediaFilename(name, mimeType, index) {
  const raw = path.basename(String(name || \`attachment-\${index + 1}\`));
  const sanitized = raw.replace(/[^a-zA-Z0-9._()\\- ]+/g, '_').replace(/\\.{2,}/g, '.').slice(0, 120);
  const existingExt = path.extname(sanitized);
  const fallbackExt = extensionForMime(mimeType);
  return sanitized || \`attachment-\${index + 1}\${fallbackExt || '.bin'}\`;
}

function decodeBase64File(value) {
  if (typeof value !== 'string' || !value) throw new Error('INVALID_BASE64');
  const normalized = value.replace(/\\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('INVALID_BASE64');
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) throw new Error('EMPTY_FILE');
  return buffer;
}

async function handleSendMedia(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, {
      outcome: 'REJECTED',
      errorCode: 'UNAUTHORIZED',
      errorMessage: 'Worker authentication failed.',
    });
  }

  let body;
  try {
    body = await readJson(req, MAX_MEDIA_BODY_BYTES);
  } catch (error) {
    return json(res, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, {
      outcome: 'REJECTED',
      errorCode: 'INVALID_MEDIA_PAYLOAD',
      errorMessage: 'Media request body is invalid.',
    });
  }

  if (!body || body.companyId !== COMPANY_ID) {
    return json(res, 403, {
      outcome: 'REJECTED',
      errorCode: 'COMPANY_MISMATCH',
      errorMessage: 'Worker is not configured for this company.',
    });
  }

  const recipientZaloId = typeof body.recipientZaloId === 'string' ? body.recipientZaloId.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const files = Array.isArray(body.files) ? body.files : [];

  if (!recipientZaloId || files.length === 0 || files.length > MAX_MEDIA_FILES) {
    return json(res, 400, {
      outcome: 'REJECTED',
      errorCode: 'INVALID_ARGUMENT',
      errorMessage: 'recipientZaloId and 1-5 files are required.',
    });
  }
  if (!api || !loggedIn) {
    return json(res, 503, {
      outcome: 'REJECTED',
      errorCode: 'ZCAJS_NOT_LOGGED_IN',
      errorMessage: 'Zalo session is not ready.',
    });
  }

  let totalBytes = 0;
  const decoded = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const item = files[index] || {};
      const buffer = decodeBase64File(item.dataBase64);
      if (buffer.length > MAX_MEDIA_FILE_BYTES) throw new Error('FILE_TOO_LARGE');
      totalBytes += buffer.length;
      if (totalBytes > MAX_MEDIA_TOTAL_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
      decoded.push({
        name: safeMediaFilename(item.name, item.mimeType, index),
        mimeType: String(item.mimeType || 'application/octet-stream'),
        buffer,
      });
    }
  } catch (error) {
    return json(res, 413, {
      outcome: 'REJECTED',
      errorCode: error instanceof Error ? error.message : 'INVALID_MEDIA_FILE',
      errorMessage: 'One or more media files are invalid or too large.',
    });
  }

  let tempDir;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-media-'));
    const localPaths = [];
    for (let index = 0; index < decoded.length; index += 1) {
      const item = decoded[index];
      let fileName = item.name;
      if (!path.extname(fileName)) fileName += extensionForMime(item.mimeType) || '.bin';
      const localPath = path.join(tempDir, \`\${index}-\${fileName}\`);
      await fs.writeFile(localPath, item.buffer, { flag: 'wx' });
      localPaths.push(localPath);
    }

    // Deliberately do not register this send in the text echo-suppression maps.
    // The self-listener event contains Zalo's canonical CDN/attachment payload, which
    // the CRM needs in order to render the sent media in the unified timeline.
    const result = await api.sendMessage(
      { msg: text || '', attachments: localPaths },
      recipientZaloId,
      MessageType.DirectMessage
    );

    const providerMessageIds = [
      result?.message?.msgId,
      ...(Array.isArray(result?.attachment) ? result.attachment.map((item) => item?.msgId) : []),
    ]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);

    if (providerMessageIds.length === 0) {
      return json(res, 502, {
        outcome: 'UNCERTAIN',
        errorCode: 'MISSING_PROVIDER_MSG_ID',
        errorMessage: 'ZCAJS returned without stable media message ids.',
      });
    }

    return json(res, 200, {
      outcome: 'ACCEPTED',
      providerMessageIds,
    });
  } catch (error) {
    return json(res, 502, {
      outcome: 'UNCERTAIN',
      errorCode: 'ZCAJS_MEDIA_SEND_ERROR',
      errorMessage: error instanceof Error ? error.message : 'ZCAJS media send failed.',
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

${requestHandlerAnchor}`;
  source = replaceOnce(source, requestHandlerAnchor, mediaHandler, 'worker media handler');

  source = replaceOnce(
    source,
    `  if (req.method === 'POST' && url.pathname === '/v1/send') {\n    void handleSend(req, res);\n    return;\n  }\n`,
    `  if (req.method === 'POST' && url.pathname === '/v1/send-media') {\n    void handleSendMedia(req, res);\n    return;\n  }\n\n  if (req.method === 'POST' && url.pathname === '/v1/send') {\n    void handleSend(req, res);\n    return;\n  }\n`,
    'worker media route'
  );

  fs.writeFileSync(file, source);
}

patchInboxView();
patchWorker();
console.log('Applied Zalo composer/media patch.');
