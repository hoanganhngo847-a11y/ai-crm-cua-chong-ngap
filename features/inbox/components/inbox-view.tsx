'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import type { Conversation, InboxMessage, InboxChannel } from '../types/inbox.types';

interface InboxViewProps {
  userRole?: string | null;
  userFullName?: string | null;
  initialCustomerId?: string | null;
}

export default function InboxView({ initialCustomerId }: InboxViewProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loadingConversations, setLoadingConversations] = useState<boolean>(true);
  const [loadingMessages, setLoadingMessages] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);
  const [replyText, setReplyText] = useState<string>('');

  // Filters
  const [channelFilter, setChannelFilter] = useState<InboxChannel | 'all'>('all');
  const [search, setSearch] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // 1. Fetch Conversations
  const fetchConversations = useCallback(async () => {
    try {
      setLoadingConversations(true);
      const params = new URLSearchParams();
      if (channelFilter !== 'all') params.set('channel', channelFilter);
      if (search.trim()) params.set('search', search.trim());

      const res = await fetch(`/api/inbox?${params.toString()}`);
      const json = await res.json();

      if (json.success && Array.isArray(json.data)) {
        setConversations(json.data);

        // Auto-select first conversation or initial customer conversation
        if (json.data.length > 0) {
          if (initialCustomerId) {
            const match = json.data.find((c: Conversation) => c.customer_id === initialCustomerId);
            setSelectedConversationId(match ? match.id : json.data[0].id);
          } else if (!selectedConversationId) {
            setSelectedConversationId(json.data[0].id);
          }
        }
      }
    } catch (err) {
      console.error('Lỗi khi tải danh sách hội thoại:', err);
    } finally {
      setLoadingConversations(false);
    }
  }, [channelFilter, search, initialCustomerId, selectedConversationId]);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      if (isMounted) await fetchConversations();
    };
    void load();
    return () => {
      isMounted = false;
    };
  }, [fetchConversations]);

  // 2. Fetch Messages when selectedConversationId changes
  const fetchMessages = useCallback(async (convId: string) => {
    try {
      setLoadingMessages(true);
      const res = await fetch(`/api/inbox?conversation_id=${convId}`);
      const json = await res.json();

      if (json.success && json.data) {
        setMessages(json.data.messages || []);

        // Cập nhật lại unread count trên UI
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, unread_count: 0 } : c))
        );
      }
    } catch (err) {
      console.error('Lỗi khi tải tin nhắn:', err);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      if (isMounted && selectedConversationId) {
        await fetchMessages(selectedConversationId);
      }
    };
    void load();
    return () => {
      isMounted = false;
    };
  }, [selectedConversationId, fetchMessages]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 3. Send Message Action
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedConversationId || !replyText.trim() || sending) return;

    const text = replyText.trim();
    setSending(true);

    try {
      const res = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: selectedConversationId,
          content: text,
        }),
      });

      const json = await res.json();
      if (json.success && json.data) {
        setMessages((prev) => [...prev, json.data]);
        setReplyText('');

        // Cập nhật tin nhắn mới nhất trong danh sách cột trái
        setConversations((prev) =>
          prev.map((c) =>
            c.id === selectedConversationId
              ? { ...c, last_message: text, updated_at: json.data.created_at }
              : c
          )
        );
      }
    } catch (err) {
      console.error('Lỗi khi gửi tin nhắn:', err);
    } finally {
      setSending(false);
    }
  };

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId);

  return (
    <div className="h-[calc(100vh-8.5rem)] flex flex-col bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl">
      {/* Top Header Bar */}
      <div className="px-6 py-3.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow-md">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-bold text-white flex items-center gap-2">
              <span>Hộp Thư Tích Hợp Đa Kênh</span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 font-medium">
                Facebook & Zalo OA
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Màn hình chung cho Sale tư vấn, chốt đơn và giám sát AI phản hồi sau 5 phút.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchConversations()}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition text-xs flex items-center gap-1.5 border border-slate-700"
            title="Làm mới hộp thư"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="hidden sm:inline">Làm mới</span>
          </button>
        </div>
      </div>

      {/* 3-Column Workspace */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-12 overflow-hidden">
        {/* ================================================================== */}
        {/* CỘT TRÁI (3.5 cols): Danh sách hội thoại & Bộ lọc                  */}
        {/* ================================================================== */}
        <div className="md:col-span-4 lg:col-span-3 border-r border-slate-800 flex flex-col bg-slate-900/50">
          {/* Filter Bar */}
          <div className="p-3 border-b border-slate-800 space-y-2.5">
            {/* Search */}
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm theo tên hoặc mã KH..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <svg
                className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>

            {/* Channel Tabs */}
            <div className="grid grid-cols-3 gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
              <button
                onClick={() => setChannelFilter('all')}
                className={`py-1 rounded-lg font-medium transition ${
                  channelFilter === 'all'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Tất cả
              </button>
              <button
                onClick={() => setChannelFilter('zalo')}
                className={`py-1 rounded-lg font-medium transition flex items-center justify-center gap-1 ${
                  channelFilter === 'zalo'
                    ? 'bg-cyan-950/60 text-cyan-300 border border-cyan-800/50'
                    : 'text-slate-400 hover:text-cyan-300'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                Zalo OA
              </button>
              <button
                onClick={() => setChannelFilter('facebook')}
                className={`py-1 rounded-lg font-medium transition flex items-center justify-center gap-1 ${
                  channelFilter === 'facebook'
                    ? 'bg-blue-950/60 text-blue-300 border border-blue-800/50'
                    : 'text-slate-400 hover:text-blue-300'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                Facebook
              </button>
            </div>
          </div>

          {/* Conversations List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50">
            {loadingConversations ? (
              <div className="p-3 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-14 bg-slate-800/40 rounded-xl animate-pulse" />
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Không tìm thấy cuộc trò chuyện nào.
              </div>
            ) : (
              conversations.map((conv) => {
                const isSelected = conv.id === selectedConversationId;
                const isZalo = conv.channel === 'zalo';

                return (
                  <div
                    key={conv.id}
                    onClick={() => setSelectedConversationId(conv.id)}
                    className={`p-3.5 transition cursor-pointer relative flex flex-col gap-1 ${
                      isSelected
                        ? 'bg-slate-800/80 border-l-4 border-blue-500'
                        : 'hover:bg-slate-800/30'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {/* Channel Badge Icon */}
                        <span
                          className={`w-5 h-5 rounded-lg flex items-center justify-center text-[10px] font-bold ${
                            isZalo
                              ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                              : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                          }`}
                          title={isZalo ? 'Zalo OA' : 'Facebook Messenger'}
                        >
                          {isZalo ? 'Z' : 'F'}
                        </span>
                        <span className="font-semibold text-white text-xs truncate max-w-[120px]">
                          {conv.customer_name}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-slate-500">
                          {new Date(conv.updated_at).toLocaleTimeString('vi-VN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {conv.unread_count > 0 && (
                          <span className="w-4 h-4 rounded-full bg-rose-600 text-white font-bold text-[10px] flex items-center justify-center">
                            {conv.unread_count}
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">
                      {conv.last_message}
                    </p>

                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      <span className="font-mono text-slate-400 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">
                        {conv.customer_code}
                      </span>
                      {conv.status === 'AI_HANDLING' && (
                        <span className="text-purple-400 bg-purple-950/40 px-1.5 py-0.5 rounded border border-purple-800/40">
                          AI hỗ trợ
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ================================================================== */}
        {/* CỘT GIỮA (5.5 cols): Khung tin nhắn & Ô nhập trả lời              */}
        {/* ================================================================== */}
        <div className="md:col-span-8 lg:col-span-6 flex flex-col bg-slate-950 border-r border-slate-800">
          {selectedConversation ? (
            <>
              {/* Chat Header */}
              <div className="p-3.5 px-5 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-white">
                    {selectedConversation.customer_name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white text-sm">
                        {selectedConversation.customer_name}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                          selectedConversation.channel === 'zalo'
                            ? 'bg-cyan-950/50 text-cyan-300 border-cyan-800/50'
                            : 'bg-blue-950/50 text-blue-300 border-blue-800/50'
                        }`}
                      >
                        {selectedConversation.channel === 'zalo' ? 'Zalo OA' : 'Facebook'}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400 font-mono">
                      {selectedConversation.customer_code}
                    </span>
                  </div>
                </div>

                <div className="text-xs text-slate-400 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Trực tuyến</span>
                </div>
              </div>

              {/* Chat Stream */}
              <div className="flex-1 p-4 overflow-y-auto space-y-3.5 bg-slate-950">
                {loadingMessages ? (
                  <div className="space-y-3">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="h-12 bg-slate-900 rounded-xl animate-pulse" />
                    ))}
                  </div>
                ) : messages.length === 0 ? (
                  <div className="text-center py-12 text-xs text-slate-500">
                    Chưa có tin nhắn nào trong cuộc hội thoại này.
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isSaleMsg = msg.sender_type === 'sale';
                    const isAiMsg = msg.sender_type === 'ai';

                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${
                          isSaleMsg ? 'items-end' : 'items-start'
                        }`}
                      >
                        {/* Sender Label */}
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mb-1 px-1">
                          {isAiMsg && (
                            <span className="px-1.5 py-0.2 rounded bg-purple-900/60 border border-purple-700/50 text-purple-300 font-semibold flex items-center gap-1">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                              </svg>
                              AI Trợ lý (5 phút)
                            </span>
                          )}
                          {isSaleMsg && (
                            <span className="text-blue-400 font-medium">Bạn (Sale)</span>
                          )}
                          {!isSaleMsg && !isAiMsg && (
                            <span className="text-slate-300 font-medium">{msg.sender_name}</span>
                          )}
                          <span>•</span>
                          <span>
                            {new Date(msg.created_at).toLocaleTimeString('vi-VN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>

                        {/* Message Bubble */}
                        <div
                          className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-xs sm:text-sm leading-relaxed ${
                            isSaleMsg
                              ? 'bg-blue-600 text-white rounded-tr-none shadow-md shadow-blue-600/10'
                              : isAiMsg
                                ? 'bg-purple-950/40 border border-purple-700/40 text-purple-100 rounded-tl-none'
                                : 'bg-slate-800 text-slate-100 border border-slate-700/60 rounded-tl-none'
                          }`}
                        >
                          {msg.content}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Message Input Box */}
              <div className="p-3 border-t border-slate-800 bg-slate-900/80">
                <form onSubmit={handleSendMessage} className="space-y-2">
                  <div className="flex items-end gap-2">
                    <textarea
                      rows={2}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      placeholder="Nhập nội dung tư vấn phản hồi (Nhấn Enter để gửi)..."
                      className="flex-1 bg-slate-950 border border-slate-700/80 rounded-xl p-2.5 text-xs sm:text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                    />

                    <button
                      type="submit"
                      disabled={sending || !replyText.trim()}
                      className="px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-lg shadow-blue-600/20"
                    >
                      {sending ? (
                        <span>Gửi...</span>
                      ) : (
                        <>
                          <span>Gửi</span>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                          </svg>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
                    <span>Quy tắc 5 phút: Nếu Sale trả lời, AI tự động nhường quyền xử lý.</span>
                    <span className="text-slate-400">Shift + Enter để xuống dòng</span>
                  </div>
                </form>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center p-8 text-slate-500 text-xs">
              Vui lòng chọn một cuộc hội thoại từ danh sách bên trái để bắt đầu chat.
            </div>
          )}
        </div>

        {/* ================================================================== */}
        {/* CỘT PHẢI (3 cols): Thông tin vắn tắt khách hàng                    */}
        {/* ================================================================== */}
        <div className="hidden lg:block lg:col-span-3 p-4 bg-slate-900/40 overflow-y-auto space-y-4 text-xs">
          {selectedConversation ? (
            <>
              {/* Profile Card */}
              <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl text-center space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 mx-auto flex items-center justify-center text-white font-bold text-base shadow-lg shadow-blue-600/20">
                  {selectedConversation.customer_name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="font-bold text-white text-sm">
                    {selectedConversation.customer_name}
                  </h3>
                  <span className="font-mono text-slate-400 text-xs">
                    {selectedConversation.customer_code}
                  </span>
                </div>

                <Link
                  href={`/customers/${selectedConversation.customer_id}`}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600/10 border border-blue-500/30 text-blue-400 hover:bg-blue-600 hover:text-white font-medium transition"
                >
                  <span>Xem Hồ Sơ 360</span>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </Link>
              </div>

              {/* Details List */}
              <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-3">
                <h4 className="font-semibold text-slate-300 uppercase tracking-wider text-[10px]">
                  Thông tin liên hệ
                </h4>

                <div className="space-y-2 text-slate-300">
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Số điện thoại:</span>
                    <span className="font-mono text-amber-300">
                      {selectedConversation.customer_phone || 'Chưa có'}
                    </span>
                  </div>

                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Kênh hội thoại:</span>
                    <span className="capitalize font-medium text-white">
                      {selectedConversation.channel === 'zalo' ? 'Zalo OA' : 'Facebook Messenger'}
                    </span>
                  </div>

                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Nguồn ban đầu:</span>
                    <span className="font-medium text-white">
                      {selectedConversation.customer_source || 'MANUAL'}
                    </span>
                  </div>

                  <div className="flex justify-between py-1">
                    <span className="text-slate-500">Giai đoạn:</span>
                    <span className="font-semibold text-blue-400">
                      {selectedConversation.customer_stage || 'LEAD_NEW'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Quick Business Note */}
              <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-2xl space-y-2">
                <div className="flex items-center gap-1.5 text-slate-300 font-semibold text-[11px]">
                  <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>Quy trình nghiệp vụ</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Khi khách hỏi giá hoặc lịch khảo sát, AI sẽ ghi nhận thông số. Khảo sát đo đạc thực tế do Kỹ thuật viên phụ trách, giá được tính tự động từ bảng giá chính sách.
                </p>
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-slate-500">Chưa chọn khách hàng.</div>
          )}
        </div>
      </div>
    </div>
  );
}
