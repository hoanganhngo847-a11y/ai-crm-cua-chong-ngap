'use client';

import React, { useState } from 'react';
import type { CareAudienceGroup } from '../../../features/care/zalo/types';

interface Conversation {
  id: string;
  customerId: string;
  customerName: string;
  customerPhoneMasked: string;
  channel: 'ZALO';
  externalId: string;
  stage: string;
  unreadCount: number;
  lastMessageAt: string;
  avatarUrl?: string;
  notes?: string;
}

interface Message {
  id: string;
  conversationId: string;
  customerId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  actorType: 'CUSTOMER' | 'SALE' | 'AI_BOT';
  content: string;
  externalRef?: string;
  createdAt: string;
}

interface CampaignRow {
  campaignId: string;
  title: string;
  audienceGroup: CareAudienceGroup;
  audienceLabel: string;
  sentCount: number;
  deliveredCount: number;
  responseCount: number;
  convertedToSaleCount: number;
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
}

const INITIAL_CONVERSATIONS: Conversation[] = [
  {
    id: 'conv_001',
    customerId: 'cust_001',
    customerName: 'Phạm Minh Đức',
    customerPhoneMasked: '098***1234',
    channel: 'ZALO',
    externalId: 'zalo_user_pham_minh_duc_99',
    stage: 'LEAD_NEW',
    unreadCount: 1,
    lastMessageAt: 'Vừa xong',
    avatarUrl: '👨‍💼',
    notes: 'Biệt thự Thảo Điền Q2 - Gara ngập mùa triều cường',
  },
  {
    id: 'conv_002',
    customerId: 'cust_002',
    customerName: 'Trần Thị Thu Trang',
    customerPhoneMasked: '091***8888',
    channel: 'ZALO',
    externalId: 'zalo_user_thu_trang_77',
    stage: 'NEGOTIATING',
    unreadCount: 0,
    lastMessageAt: '15 phút trước',
    avatarUrl: '👩‍💼',
    notes: 'Nhà phố Bình Thạnh - Cần khảo sát cửa kính cường lực chống ngập',
  },
  {
    id: 'conv_003',
    customerId: 'cust_003',
    customerName: 'Hoàng Nam Group (Anh Tuấn)',
    customerPhoneMasked: '090***5678',
    channel: 'ZALO',
    externalId: 'zalo_user_hoang_nam_01',
    stage: 'PRICE_CALCULATED',
    unreadCount: 0,
    lastMessageAt: '2 giờ trước',
    avatarUrl: '🏢',
    notes: 'Tòa nhà văn phòng Q7 - Khẩu độ hầm 6m bản xếp tự động',
  },
];

const INITIAL_MESSAGES: Record<string, Message[]> = {
  conv_001: [
    {
      id: 'msg_101',
      conversationId: 'conv_001',
      customerId: 'cust_001',
      direction: 'INBOUND',
      actorType: 'CUSTOMER',
      content: 'Chào công ty, hầm nhà tôi ở Thảo Điền rộng 3.5m, cao 0.7m. Xin báo giá cửa chống ngập tự động ạ.',
      externalRef: 'zalo_in_001',
      createdAt: '10:45',
    },
  ],
  conv_002: [
    {
      id: 'msg_201',
      conversationId: 'conv_002',
      customerId: 'cust_002',
      direction: 'INBOUND',
      actorType: 'CUSTOMER',
      content: 'Bên mình có kỹ thuật viên qua khảo sát mặt bằng thực tế không em?',
      externalRef: 'zalo_in_002',
      createdAt: '09:20',
    },
    {
      id: 'msg_202',
      conversationId: 'conv_002',
      customerId: 'cust_002',
      direction: 'OUTBOUND',
      actorType: 'SALE',
      content: 'Dạ chào chị Trang, bên em có kỹ thuật viên qua đo đạc và tư vấn giải pháp tận nơi hoàn toàn miễn phí ạ!',
      externalRef: 'zalo_out_002',
      createdAt: '09:24',
    },
  ],
  conv_003: [
    {
      id: 'msg_301',
      conversationId: 'conv_003',
      customerId: 'cust_003',
      direction: 'INBOUND',
      actorType: 'CUSTOMER',
      content: 'Hồ sơ thiết kế và dự toán bên em gửi anh đã xem rồi, tuần sau thi công kịp không?',
      externalRef: 'zalo_in_003',
      createdAt: '08:10',
    },
    {
      id: 'msg_302',
      conversationId: 'conv_003',
      customerId: 'cust_003',
      direction: 'OUTBOUND',
      actorType: 'SALE',
      content: 'Dạ anh Tuấn, xưởng đã sẵn sàng phôi Inox 304, anh chốt cọc hợp đồng thì trong 3 ngày bên em xuống lắp đặt hoàn thiện ạ!',
      externalRef: 'zalo_out_003',
      createdAt: '08:15',
    },
  ],
};

const INITIAL_CAMPAIGNS: CampaignRow[] = [
  {
    campaignId: 'camp_001',
    title: 'Chăm sóc mùa mưa bão - Khách gọi nhỡ 3 lần',
    audienceGroup: 'UNREACHABLE_3_TIMES',
    audienceLabel: 'Khách gọi nhỡ 3 lần',
    sentCount: 45,
    deliveredCount: 44,
    responseCount: 14,
    convertedToSaleCount: 3,
    status: 'ACTIVE',
  },
  {
    campaignId: 'camp_002',
    title: 'Ưu đãi khảo sát miễn phí - Khách đang cân nhắc',
    audienceGroup: 'CONSIDERING',
    audienceLabel: 'Khách đang cân nhắc',
    sentCount: 32,
    deliveredCount: 32,
    responseCount: 18,
    convertedToSaleCount: 7,
    status: 'ACTIVE',
  },
  {
    campaignId: 'camp_003',
    title: 'Tặng gói bảo hành 3 năm - Khách đã báo giá chưa chốt',
    audienceGroup: 'QUOTED_NOT_CLOSED',
    audienceLabel: 'Đã báo giá chưa chốt',
    sentCount: 28,
    deliveredCount: 27,
    responseCount: 12,
    convertedToSaleCount: 6,
    status: 'ACTIVE',
  },
  {
    campaignId: 'camp_004',
    title: 'Bảo dưỡng định kỳ 12 tháng - Khách hàng cũ',
    audienceGroup: 'OLD_CUSTOMER',
    audienceLabel: 'Khách hàng cũ (Bảo trì)',
    sentCount: 60,
    deliveredCount: 59,
    responseCount: 22,
    convertedToSaleCount: 8,
    status: 'COMPLETED',
  },
];

export default function TestZaloDemoPage() {
  // State for Inbox
  const [conversations, setConversations] = useState<Conversation[]>(INITIAL_CONVERSATIONS);
  const [activeConvId, setActiveConvId] = useState<string>('conv_001');
  const [messagesMap, setMessagesMap] = useState<Record<string, Message[]>>(INITIAL_MESSAGES);
  const [replyInput, setReplyInput] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const [logs, setLogs] = useState<string[]>([
    '🟢 [System] Khởi tạo Zalo Omnichannel & Care Test Environment.',
    '📥 [inbox-service] getZaloConversations() -> Đã tải 3 hội thoại Zalo OA.',
    '📊 [analytics-service] getCampaignAnalytics() -> Đã tổng hợp 4 chiến dịch chăm sóc.',
  ]);

  // State for Campaigns
  const [campaigns, setCampaigns] = useState<CampaignRow[]>(INITIAL_CAMPAIGNS);

  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0];
  const activeMessages = messagesMap[activeConvId] || [];

  const addLog = (text: string) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    setLogs((prev) => [`[${time}] ${text}`, ...prev.slice(0, 19)]);
  };

  // Handle Sale send reply via sendZaloReply
  const handleSendReply = (customText?: string) => {
    const textToSend = customText || replyInput;
    if (!textToSend.trim()) return;

    setIsSending(true);
    addLog(`[inbox-service] Gọi hàm sendZaloReply() -> Khách: ${activeConv.customerName} (${activeConv.externalId})`);

    setTimeout(() => {
      const newMsgId = `msg_out_${Date.now()}`;
      const extRef = `zalo_oa_msg_${Math.floor(Math.random() * 90000) + 10000}`;

      const newMsg: Message = {
        id: newMsgId,
        conversationId: activeConvId,
        customerId: activeConv.customerId,
        direction: 'OUTBOUND',
        actorType: 'SALE',
        content: textToSend,
        externalRef: extRef,
        createdAt: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      };

      setMessagesMap((prev) => ({
        ...prev,
        [activeConvId]: [...(prev[activeConvId] || []), newMsg],
      }));

      // Mark unread as 0 and update lastMessageAt
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConvId
            ? { ...c, unreadCount: 0, lastMessageAt: 'Vừa xong' }
            : c
        )
      );

      setReplyInput('');
      setIsSending(false);
      addLog(`✅ [inbox-service] sendZaloReply() thành công! Interaction ID: ${newMsgId}, Zalo Ref: ${extRef}`);
    }, 450);
  };

  // Quick replies
  const quickTemplates = [
    'Dạ em chào anh/chị! Em gửi anh/chị bảng giá dự toán cửa chống ngập Inox 304 tiêu chuẩn gara nhé ạ.',
    'Bên em có kỹ thuật viên qua khảo sát mặt bằng và đo đạc miễn phí tận nơi, em lên lịch cho mình nhé?',
    'Em gửi anh/chị video thực tế cửa tự động nâng hạ khi nước ngập thử nghiệm đạt áp lực 1 mét nước ạ.',
  ];

  // Handle simulation of converting customer to sale
  const handleConvertSale = (campaignId: string) => {
    setCampaigns((prev) =>
      prev.map((c) => {
        if (c.campaignId === campaignId) {
          const newConverted = c.convertedToSaleCount + 1;
          addLog(
            `💰 [analytics-service] recordConversionToSale() -> Chiến dịch "${c.title}" ghi nhận 1 đơn chốt mới!`
          );
          return {
            ...c,
            convertedToSaleCount: newConverted,
          };
        }
        return c;
      })
    );
  };

  // Overall analytics calculations
  const totalSent = campaigns.reduce((acc, cur) => acc + cur.sentCount, 0);
  const totalDelivered = campaigns.reduce((acc, cur) => acc + cur.deliveredCount, 0);
  const totalResponses = campaigns.reduce((acc, cur) => acc + cur.responseCount, 0);
  const totalConverted = campaigns.reduce((acc, cur) => acc + cur.convertedToSaleCount, 0);

  const deliveryRate = totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) : '0';
  const responseRate = totalSent > 0 ? ((totalResponses / totalSent) * 100).toFixed(1) : '0';
  const conversionRate = totalResponses > 0 ? ((totalConverted / totalResponses) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-8 pb-12">
      {/* Page Header */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                Thành viên 3 (Hùng) • Zalo OA & Chăm sóc
              </span>
              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                LIVE DEMO
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
              Trung Tâm Kiểm Thử Zalo OA & Chăm Sóc Khách Hàng
            </h1>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Giao diện trực quan tích hợp Hộp thư Zalo (<code className="text-blue-300 font-mono text-xs">inbox-service</code>) và Thống kê chiến dịch tự động (<code className="text-indigo-300 font-mono text-xs">analytics-service</code>) theo đúng chuẩn kiến trúc Cửa Chống Ngập.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const sampleMsg = `Khách mới hỏi: "Gara nhà tôi 4m x 0.8m thì giá khoảng bao nhiêu em?" (${Date.now() % 1000})`;
                addLog(`⚡ [Webhook Inbound] Nhận sự kiện user_send_text từ Zalo OA -> Tạo/đồng bộ Conversation!`);
                const newMsgId = `msg_in_${Date.now()}`;
                setMessagesMap((prev) => ({
                  ...prev,
                  [activeConvId]: [
                    ...(prev[activeConvId] || []),
                    {
                      id: newMsgId,
                      conversationId: activeConvId,
                      customerId: activeConv.customerId,
                      direction: 'INBOUND',
                      actorType: 'CUSTOMER',
                      content: sampleMsg,
                      createdAt: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                    },
                  ],
                }));
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === activeConvId
                      ? { ...c, unreadCount: c.unreadCount + 1, lastMessageAt: 'Vừa xong' }
                      : c
                  )
                );
              }}
              className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-medium transition shadow-lg shadow-blue-600/20 flex items-center gap-2 cursor-pointer"
            >
              <span>+ Giả lập Webhook Khách nhắn</span>
            </button>
          </div>
        </div>
      </div>

      {/* SECTION 1: KHUNG CHAT ZALO (INBOX-SERVICE) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-white shadow-md shadow-blue-500/30">
              Z
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Khung Chat Zalo OA (Hộp thư tích hợp)</h2>
              <p className="text-xs text-slate-400">Kết nối trực tiếp logic xử lý của <code className="text-blue-400 font-mono">inbox-service.ts</code> & <code className="text-blue-400 font-mono">sendZaloReply</code></p>
            </div>
          </div>
          <span className="text-xs text-slate-400 bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
            Kênh: ZALO_OA | 1 Sale duy nhất xử lý
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl h-[620px]">
          {/* Conversation List (Sidebar) */}
          <div className="lg:col-span-4 border-r border-slate-800 flex flex-col bg-slate-900/60">
            <div className="p-4 border-b border-slate-800">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Danh sách hội thoại ({conversations.length})
                </span>
                <span className="text-[11px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-medium">
                  Zalo OA Ingest
                </span>
              </div>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Tìm khách hàng hoặc SĐT..."
                  className="w-full bg-slate-800/80 border border-slate-700/80 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
                  readOnly
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50">
              {conversations.map((conv) => {
                const isActive = conv.id === activeConvId;
                const lastMsg = messagesMap[conv.id]?.slice(-1)[0]?.content || 'Chưa có tin nhắn';

                return (
                  <button
                    key={conv.id}
                    onClick={() => {
                      setActiveConvId(conv.id);
                      addLog(`[inbox-service] getZaloMessagesByConversation() -> Đã tải lịch sử ${conv.customerName}`);
                    }}
                    className={`w-full text-left p-3.5 transition flex items-start gap-3 cursor-pointer ${
                      isActive
                        ? 'bg-blue-600/15 border-l-4 border-blue-500'
                        : 'hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-lg border border-slate-700 shrink-0">
                      {conv.avatarUrl}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-sm font-semibold truncate ${isActive ? 'text-blue-400' : 'text-slate-200'}`}>
                          {conv.customerName}
                        </span>
                        <span className="text-[11px] text-slate-500 shrink-0">{conv.lastMessageAt}</span>
                      </div>
                      <p className="text-xs text-slate-400 truncate mb-1.5">{lastMsg}</p>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono border border-slate-700/60">
                          {conv.stage}
                        </span>
                        {conv.unreadCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500 text-white font-bold ml-auto animate-bounce">
                            {conv.unreadCount} mới
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active Chat Window */}
          <div className="lg:col-span-8 flex flex-col bg-slate-950/40">
            {/* Chat Header */}
            <div className="p-4 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-xl">
                  {activeConv.avatarUrl}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-base">{activeConv.customerName}</span>
                    <span className="text-[10px] bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full font-mono">
                      ZALO_OA
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 flex items-center gap-2 mt-0.5">
                    <span>SĐT bảo mật: {activeConv.customerPhoneMasked}</span>
                    <span>•</span>
                    <span className="text-amber-400 font-medium">Giai đoạn: {activeConv.stage}</span>
                  </div>
                </div>
              </div>

              <div className="text-right text-xs">
                <span className="text-slate-400">UID Zalo: </span>
                <code className="text-blue-300 font-mono bg-slate-800 px-2 py-1 rounded text-[11px]">
                  {activeConv.externalId}
                </code>
              </div>
            </div>

            {/* Message Thread */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="text-center my-2">
                <span className="text-[11px] text-slate-500 bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
                  Đã kết nối luồng chat mã hóa với Zalo Official Account
                </span>
              </div>

              {activeMessages.map((msg) => {
                const isCustomer = msg.direction === 'INBOUND';

                return (
                  <div
                    key={msg.id}
                    className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`}
                  >
                    <div
                      className={`max-w-[80%] md:max-w-[70%] rounded-2xl p-4 space-y-1.5 shadow-md ${
                        isCustomer
                          ? 'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-sm'
                          : 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-tr-sm shadow-blue-600/10'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 text-[11px] opacity-80">
                        <span className="font-semibold">
                          {isCustomer ? `Khách: ${activeConv.customerName}` : '👨‍💼 Nhân viên Sale (Bạn)'}
                        </span>
                        <span className="font-mono">{msg.createdAt}</span>
                      </div>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                      <div className="flex items-center justify-end gap-1.5 pt-1 text-[10px] opacity-70">
                        <span>{isCustomer ? 'Nhận qua Webhook' : 'Đã gửi qua Zalo OpenAPI'}</span>
                        {!isCustomer && <span>✓✓</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Quick Replies Strip */}
            <div className="px-4 py-2 bg-slate-900/80 border-t border-slate-800/80 flex items-center gap-2 overflow-x-auto text-xs">
              <span className="text-slate-500 shrink-0 text-[11px] font-medium">Gợi ý trả lời:</span>
              {quickTemplates.map((tmpl, idx) => (
                <button
                  key={idx}
                  onClick={() => setReplyInput(tmpl)}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg whitespace-nowrap border border-slate-700/60 transition text-[11px] cursor-pointer"
                >
                  {tmpl.slice(0, 32)}...
                </button>
              ))}
            </div>

            {/* Input & Send Bar */}
            <div className="p-3 bg-slate-900 border-t border-slate-800 flex items-center gap-2">
              <textarea
                value={replyInput}
                onChange={(e) => setReplyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendReply();
                  }
                }}
                placeholder="Nhập nội dung phản hồi của Sale (nhấn Enter hoặc bấm nút Gửi)..."
                rows={2}
                className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
              />
              <button
                onClick={() => handleSendReply()}
                disabled={isSending || !replyInput.trim()}
                className="h-full px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl font-medium text-sm transition flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-blue-600/20"
              >
                {isSending ? (
                  <span className="animate-spin text-sm">⏳</span>
                ) : (
                  <>
                    <span>Gửi qua Zalo</span>
                    <span className="text-xs">➔</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 2: BẢNG THỐNG KÊ CHIẾN DỊCH CHĂM SÓC ZALO (ANALYTICS-SERVICE) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-md shadow-indigo-500/30">
              📊
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Thống Kê Chiến Dịch Zalo Care (Định kỳ & Hàng loạt)</h2>
              <p className="text-xs text-slate-400">Dữ liệu được đối soát và tổng hợp từ <code className="text-indigo-400 font-mono">analytics-service.ts</code> & bản ghi <code className="text-indigo-400 font-mono">CareDelivery</code></p>
            </div>
          </div>
          <span className="text-xs text-slate-400 bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
            Chu kỳ: 1 tháng/lần • Cơ chế Opt-Out tự động
          </span>
        </div>

        {/* 4 Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
            <div className="text-xs text-slate-400 font-medium mb-1 flex items-center justify-between">
              <span>Tổng tin gửi chăm sóc</span>
              <span>📤</span>
            </div>
            <div className="text-2xl font-extrabold text-white tracking-tight">{totalSent}</div>
            <div className="text-[11px] text-blue-400 mt-1">Gửi qua Zalo OA OpenAPI</div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
            <div className="text-xs text-slate-400 font-medium mb-1 flex items-center justify-between">
              <span>Tỷ lệ nhận tin (Delivered)</span>
              <span>✅</span>
            </div>
            <div className="text-2xl font-extrabold text-emerald-400 tracking-tight">{deliveryRate}%</div>
            <div className="text-[11px] text-slate-500 mt-1">{totalDelivered}/{totalSent} tin thành công</div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
            <div className="text-xs text-slate-400 font-medium mb-1 flex items-center justify-between">
              <span>Tỷ lệ phản hồi (Response)</span>
              <span>💬</span>
            </div>
            <div className="text-2xl font-extrabold text-indigo-400 tracking-tight">{responseRate}%</div>
            <div className="text-[11px] text-slate-500 mt-1">{totalResponses} khách phản hồi</div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
            <div className="text-xs text-slate-400 font-medium mb-1 flex items-center justify-between">
              <span>Tỷ lệ chốt đơn (Conversion)</span>
              <span>🎯</span>
            </div>
            <div className="text-2xl font-extrabold text-amber-400 tracking-tight">{conversionRate}%</div>
            <div className="text-[11px] text-amber-400/80 mt-1">{totalConverted} hợp đồng cọc thành công</div>
          </div>
        </div>

        {/* Campaign Data Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">Chi tiết hiệu quả theo 4 nhóm khách hàng mục tiêu</h3>
            <span className="text-xs text-slate-400">Báo cáo sẵn sàng cung cấp cho Thành viên 9 (AI Analytics)</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-950/60 text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3.5 px-4">Tên chiến dịch</th>
                  <th className="py-3.5 px-4">Phân khúc đối tượng</th>
                  <th className="py-3.5 px-4 text-center">Đã gửi</th>
                  <th className="py-3.5 px-4 text-center">Đã nhận</th>
                  <th className="py-3.5 px-4 text-center">Phản hồi</th>
                  <th className="py-3.5 px-4 text-center">Chốt đơn</th>
                  <th className="py-3.5 px-4 text-center">Tỷ lệ chốt</th>
                  <th className="py-3.5 px-4 text-right">Thao tác thử nghiệm</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {campaigns.map((camp) => {
                  const campConversion =
                    camp.responseCount > 0
                      ? ((camp.convertedToSaleCount / camp.responseCount) * 100).toFixed(1)
                      : '0';

                  return (
                    <tr key={camp.campaignId} className="hover:bg-slate-800/40 transition">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-white">{camp.title}</div>
                        <div className="text-[11px] text-slate-500 font-mono">{camp.campaignId}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="inline-block px-2.5 py-1 rounded text-xs bg-slate-800 text-blue-300 border border-slate-700/60 font-medium">
                          {camp.audienceLabel}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono">{camp.sentCount}</td>
                      <td className="py-3.5 px-4 text-center font-mono text-emerald-400">
                        {camp.deliveredCount}
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono text-indigo-300">
                        {camp.responseCount}
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono font-bold text-amber-400">
                        {camp.convertedToSaleCount}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="font-bold text-amber-400">{campConversion}%</span>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <button
                          onClick={() => handleConvertSale(camp.campaignId)}
                          className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 rounded-lg text-xs font-semibold transition cursor-pointer"
                        >
                          + Giả lập Chốt Đơn
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* SECTION 3: REAL-TIME SERVICE AUDIT / CONSOLE LOGS */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
            <h3 className="text-sm font-bold text-white tracking-wide">
              Nhật ký kiểm thử trực tiếp (Service Audit Stream)
            </h3>
          </div>
          <button
            onClick={() => setLogs(['🟢 [System] Đã làm mới nhật ký kiểm thử.'])}
            className="text-xs text-slate-400 hover:text-slate-200 transition"
          >
            Xóa log
          </button>
        </div>

        <div className="bg-slate-950 rounded-xl p-3 font-mono text-xs text-slate-300 max-h-48 overflow-y-auto space-y-1 border border-slate-800">
          {logs.map((log, idx) => (
            <div key={idx} className="leading-relaxed">
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
