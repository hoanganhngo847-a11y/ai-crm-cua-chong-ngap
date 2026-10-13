'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import type {
  Conversation,
  InboxMessage,
  InboxChannel,
  SenderType,
  MessageDeliveryStatus,
} from '../types/inbox.types';
import { isPendingDelivery, mergeDeliveryStatus } from '../types/inbox.types';
import { generateAiDraftSuggestionAction } from '../actions';
import { createClient } from '@/lib/supabase/client';
import MessageContent from './message-content';

export { mergeDeliveryStatus };

interface InboxViewProps {
  userRole?: string | null;
  userFullName?: string | null;
  initialCustomerId?: string | null;
}

function formatMessageTime(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function getInitials(name?: string): string {
  if (!name || !name.trim()) return 'KH';
  return name.trim().slice(0, 2).toUpperCase();
}

function renderDeliveryBadge(deliveryStatus?: string): React.ReactNode {
  if (!deliveryStatus) return null;
  const s = deliveryStatus.toUpperCase();

  if (s === 'SENT' || s === 'DELIVERED') {
    return (
      <span className="text-emerald-400 font-medium flex items-center gap-0.5" title="Đã gửi tới khách hàng">
        <svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        Đã gửi
      </span>
    );
  }

  if (s === 'FAILED') {
    return (
      <span className="text-rose-400 font-semibold flex items-center gap-0.5" title="Gửi thất bại - Khách chưa nhận được">
        <svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        Gửi thất bại
      </span>
    );
  }

  if (s === 'RECONCILE_REQUIRED') {
    return (
      <span className="text-amber-400 font-medium flex items-center gap-0.5" title="Đang đối soát phiên gửi">
        <svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
        Cần đối soát
      </span>
    );
  }

  if (isPendingDelivery(s)) {
    return (
      <span className="text-amber-300 font-medium flex items-center gap-0.5" title="Tin nhắn đang trong hàng đợi xử lý">
        <svg className="w-3 h-3 inline animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        Đang gửi
      </span>
    );
  }

  return null;
}

export default function InboxView({ initialCustomerId, userFullName }: InboxViewProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  // P0-A: Store messages strictly keyed by conversationId
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, InboxMessage[]>>({});

  // P0-B: Store drafts strictly keyed by conversationId
  const [draftsByConversation, setDraftsByConversation] = useState<Record<string, string>>({});

  const [loadingConversations, setLoadingConversations] = useState<boolean>(true);
  const [loadingMessages, setLoadingMessages] = useState<boolean>(false);
  const [sendingByConversation, setSendingByConversation] = useState<Record<string, boolean>>({});
  const [sendErrorByConversation, setSendErrorByConversation] = useState<Record<string, string | null>>({});

  // P0-A: Monotonic request generation and active conversation reference for race condition elimination
  const activeConversationRef = useRef<string | null>(null);
  const foregroundGenerationRef = useRef<number>(0);
  const foregroundAbortControllerRef = useRef<AbortController | null>(null);
  const pollGenerationRef = useRef<number>(0);
  const pollAbortControllerRef = useRef<AbortController | null>(null);

  // P0-B: Pending command tracking for idempotent retry strictly scoped by conversation
  const pendingCommandsRef = useRef<Record<string, { commandId: string; content: string }>>({});

  // Synchronize activeConversationRef
  useEffect(() => {
    activeConversationRef.current = selectedConversationId;
  }, [selectedConversationId]);

  // Phase 9: Syncing New Message Skeleton (NameThatUI pattern)
  const [isSyncingNewMessage, setIsSyncingNewMessage] = useState<boolean>(false);
  const syncingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const syncingDelayRef = useRef<NodeJS.Timeout | null>(null);
  const activeConversationLastMessageAtRef = useRef<string | null>(null);
  const selectedConversationRef = useRef<Conversation | undefined>(undefined);

  // Correlation ref: records latest interaction timestamp rendered/received per conversation (eliminates race condition)
  const latestRenderedInteractionTimeByConvRef = useRef<Record<string, number>>({});
  const userFullNameRef = useRef<string | null | undefined>(userFullName);

  useEffect(() => {
    userFullNameRef.current = userFullName;
  }, [userFullName]);

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId);

  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
    if (selectedConversation?.last_message_at) {
      activeConversationLastMessageAtRef.current = selectedConversation.last_message_at;
    }
  }, [selectedConversation]);

  useEffect(() => {
    return () => {
      if (syncingDelayRef.current) clearTimeout(syncingDelayRef.current);
      if (syncingTimeoutRef.current) clearTimeout(syncingTimeoutRef.current);
    };
  }, []);

  // AI Suggestion states (scoped & isolated)
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [loadingAiByConversation, setLoadingAiByConversation] = useState<Record<string, boolean>>({});
  const [aiSuggestionMeta, setAiSuggestionMeta] = useState<{
    isNeutralDefault?: boolean;
    styleProfileId?: string | null;
    analysisSummary?: string | null;
  } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Filters
  const [channelFilter, setChannelFilter] = useState<InboxChannel | 'all'>('all');
  const [search, setSearch] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [showNewMessagePill, setShowNewMessagePill] = useState<boolean>(false);
  const isNearBottomRef = useRef<boolean>(true);
  const prevMessageCountRef = useRef<number>(0);
  const prevConversationIdRef = useRef<string | null>(null);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNear = distanceFromBottom <= 100;
    isNearBottomRef.current = isNear;
    if (isNear) {
      setShowNewMessagePill(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowNewMessagePill(false);
    isNearBottomRef.current = true;
  }, []);

  // 1. Fetch Conversations
  const fetchConversations = useCallback(async (options?: { silent?: boolean }) => {
    const isSilent = Boolean(options?.silent);
    try {
      if (!isSilent) {
        setLoadingConversations(true);
      }
      const params = new URLSearchParams();
      if (channelFilter !== 'all') params.set('channel', channelFilter);
      if (search.trim()) params.set('search', search.trim());

      const res = await fetch(`/api/inbox?${params.toString()}`);
      const json = await res.json();

      if (json.success && Array.isArray(json.data)) {
        setConversations(json.data);

        // Auto-select first conversation or initial customer conversation if none active
        if (json.data.length > 0) {
          if (initialCustomerId) {
            const match = json.data.find((c: Conversation) => c.customer_id === initialCustomerId);
            const targetId = match ? match.id : json.data[0].id;
            setSelectedConversationId((current) => current || targetId);
          } else {
            setSelectedConversationId((current) => current || json.data[0].id);
          }
        }
      }
    } catch (err) {
      console.error('Lỗi khi tải danh sách hội thoại:', err);
    } finally {
      if (!isSilent) {
        setLoadingConversations(false);
      }
    }
  }, [channelFilter, search, initialCustomerId]);

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

  // 2. Fetch Messages with strict conversation isolation and separated foreground vs silent polling controllers
  const fetchMessages = useCallback(async (convId: string, options?: { silent?: boolean }) => {
    if (!convId) return;
    const isSilent = Boolean(options?.silent);

    let controller: AbortController;
    let currentGeneration: number;

    if (isSilent) {
      // Background / silent delivery polling:
      // - Must NOT abort foreground fetch
      // - Must NOT touch loadingMessages
      if (pollAbortControllerRef.current) {
        pollAbortControllerRef.current.abort();
      }
      controller = new AbortController();
      pollAbortControllerRef.current = controller;
      currentGeneration = ++pollGenerationRef.current;
    } else {
      // Foreground conversation load:
      // - Controls loadingMessages
      // - Aborts previous foreground fetch if any
      setLoadingMessages(true);
      if (foregroundAbortControllerRef.current) {
        foregroundAbortControllerRef.current.abort();
      }
      controller = new AbortController();
      foregroundAbortControllerRef.current = controller;
      currentGeneration = ++foregroundGenerationRef.current;
    }

    try {
      const res = await fetch(`/api/inbox?conversation_id=${encodeURIComponent(convId)}`, {
        signal: controller.signal,
      });
      const json = await res.json();

      // P0-A: If user switched conversation in the meantime, IGNORE RESPONSE
      if (convId !== activeConversationRef.current) {
        return;
      }

      // Check generation token for the respective mode
      if (isSilent) {
        if (currentGeneration !== pollGenerationRef.current) return;
      } else {
        if (currentGeneration !== foregroundGenerationRef.current) return;
      }

      if (json.success && json.data) {
        const serverMessages: InboxMessage[] = json.data.messages || [];

        // P0-A: Reconcile ONLY within the SAME conversation!
        setMessagesByConversation((prev) => {
          const existingForConv = prev[convId] || [];

          if (existingForConv.length === 0) {
            return {
              ...prev,
              [convId]: serverMessages,
            };
          }

          // Build indexes of server messages for fast O(1) matching
          const serverById = new Map<string, InboxMessage>();
          const serverByCommandId = new Map<string, InboxMessage>();
          for (const sm of serverMessages) {
            if (sm.id) serverById.set(sm.id, sm);
            if (sm.client_command_id) serverByCommandId.set(sm.client_command_id, sm);
          }

          const reconciled: InboxMessage[] = [];
          const matchedServerIds = new Set<string>();

          for (const localMsg of existingForConv) {
            const matchedServerMsg =
              (localMsg.id ? serverById.get(localMsg.id) : null) ||
              (localMsg.client_command_id ? serverByCommandId.get(localMsg.client_command_id) : null);

            if (matchedServerMsg) {
              const mergedStatus = mergeDeliveryStatus(
                localMsg.delivery_status,
                matchedServerMsg.delivery_status
              );

              reconciled.push({
                ...localMsg,
                ...matchedServerMsg,
                client_command_id: localMsg.client_command_id || matchedServerMsg.client_command_id,
                delivery_status: mergedStatus,
              });
              if (matchedServerMsg.id) matchedServerIds.add(matchedServerMsg.id);
            } else {
              // Optimistic message belonging to THIS conversation: preserve it
              reconciled.push(localMsg);
            }
          }

          for (const sm of serverMessages) {
            if (sm.id && !matchedServerIds.has(sm.id)) {
              reconciled.push(sm);
            }
          }

          return {
            ...prev,
            [convId]: reconciled,
          };
        });

        if (serverMessages.length > 0) {
          const maxServerMsgTime = serverMessages.reduce((max, m) => {
            const t = m.created_at ? new Date(m.created_at).getTime() : 0;
            return t > max ? t : max;
          }, 0);
          if (maxServerMsgTime > (latestRenderedInteractionTimeByConvRef.current[convId] || 0)) {
            latestRenderedInteractionTimeByConvRef.current[convId] = maxServerMsgTime;
          }
        }

        if (!isSilent) {
          setAiSuggestion(null);
          setAiError(null);
          setAiSuggestionMeta(null);
        }

        // Cập nhật lại unread count và metadata Page trên UI
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, ...(json.data.conversation || {}), unread_count: 0 }
              : c
          )
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Request aborted due to conversation switch or newer fetch - expected
        return;
      }
      console.error('Lỗi khi tải tin nhắn:', err);
    } finally {
      if (!isSilent) {
        if (convId === activeConversationRef.current && currentGeneration === foregroundGenerationRef.current) {
          setLoadingMessages(false);
        }
      }
    }
  }, []);

  // Handle switching conversation
  const handleSelectConversation = (convId: string) => {
    if (convId === selectedConversationId) return;

    activeConversationRef.current = convId;
    setSelectedConversationId(convId);

    // Clear syncing skeleton
    if (syncingDelayRef.current) {
      clearTimeout(syncingDelayRef.current);
      syncingDelayRef.current = null;
    }
    if (syncingTimeoutRef.current) {
      clearTimeout(syncingTimeoutRef.current);
      syncingTimeoutRef.current = null;
    }
    setIsSyncingNewMessage(false);

    // Abort both in-flight foreground and poll requests for previous conversation
    if (foregroundAbortControllerRef.current) {
      foregroundAbortControllerRef.current.abort();
      foregroundAbortControllerRef.current = null;
    }
    if (pollAbortControllerRef.current) {
      pollAbortControllerRef.current.abort();
      pollAbortControllerRef.current = null;
    }

    // Reset AI suggestions on switch
    setAiSuggestion(null);
    setAiError(null);
    setAiSuggestionMeta(null);
  };

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

  const handleRequestAiSuggestion = async () => {
    if (!selectedConversationId) return;
    if (loadingAiByConversation[selectedConversationId]) return;

    const requestConvId = selectedConversationId;
    setLoadingAiByConversation((prev) => ({ ...prev, [requestConvId]: true }));
    setAiError(null);
    try {
      const res = await generateAiDraftSuggestionAction({
        conversationId: requestConvId,
      });

      // Ignore if user switched away
      if (requestConvId !== activeConversationRef.current) return;

      if (res.success && res.suggestion) {
        setAiSuggestion(res.suggestion);
        setAiSuggestionMeta({
          isNeutralDefault: res.isNeutralDefault,
          styleProfileId: res.styleProfileId,
          analysisSummary: res.analysisSummary,
        });
      } else {
        setAiError(res.error || 'Không thể tạo gợi ý AI');
      }
    } catch (err: unknown) {
      if (requestConvId !== activeConversationRef.current) return;
      const message = err instanceof Error ? err.message : 'Lỗi khi tạo gợi ý AI';
      setAiError(message);
    } finally {
      // Scoped reset: always reset for requestConvId regardless of active conversation
      setLoadingAiByConversation((prev) => ({ ...prev, [requestConvId]: false }));
    }
  };

  // Derive visible messages for active conversation
  const visibleMessages = useMemo(() => {
    return selectedConversationId ? (messagesByConversation[selectedConversationId] || []) : [];
  }, [selectedConversationId, messagesByConversation]);

  // Section 9: Auto-scroll behavior
  // If user is near bottom (<100px): auto-scroll to new bubble.
  // If user is reading history above: DO NOT force scroll, show floating "Tin nhắn mới" pill instead.
  useEffect(() => {
    const currentCount = visibleMessages.length;
    const isSwitchedConversation = selectedConversationId !== prevConversationIdRef.current;
    prevConversationIdRef.current = selectedConversationId;

    if (isSwitchedConversation) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      setShowNewMessagePill(false);
      isNearBottomRef.current = true;
      prevMessageCountRef.current = currentCount;
      return;
    }

    if (currentCount > prevMessageCountRef.current) {
      if (isNearBottomRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        setShowNewMessagePill(false);
      } else {
        setShowNewMessagePill(true);
      }
    }
    prevMessageCountRef.current = currentCount;
  }, [visibleMessages, selectedConversationId]);

  // Section 7, 8 & 12: Supabase Realtime Subscriptions & Latency Instrumentation
  useEffect(() => {
    let supabase: ReturnType<typeof createClient> | null = null;
    try {
      supabase = createClient();
    } catch (err) {
      console.warn('[REALTIME] Supabase client không khả dụng:', err);
      return;
    }

    const channel = supabase
      .channel('crm_inbox_realtime')
      // 1. Subscribe to public.interactions INSERT
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'interactions',
        },
        (payload) => {
          const frontendRealtimeEventAt = Date.now();
          const newInteraction = payload.new as {
            id?: string;
            company_id?: string;
            customer_id?: string;
            conversation_id?: string;
            channel?: string;
            direction?: string;
            sanitized_content?: string;
            actor_type?: string;
            actor_user_id?: string;
            created_at?: string;
            delivery_status?: string;
          };

          const convId = newInteraction?.conversation_id;
          const createdAt = newInteraction?.created_at ? new Date(newInteraction.created_at).getTime() : Date.now();
          const dbToFrontendMs = newInteraction?.created_at ? frontendRealtimeEventAt - new Date(newInteraction.created_at).getTime() : null;
          console.log(
            `[REALTIME LATENCY] Inbound interaction INSERT | DB -> Frontend: ${dbToFrontendMs}ms`
          );

          if (convId) {
            // Record latest received interaction timestamp for this conversation
            const prevMax = latestRenderedInteractionTimeByConvRef.current[convId] || 0;
            if (createdAt > prevMax) {
              latestRenderedInteractionTimeByConvRef.current[convId] = createdAt;
            }
          }

          // If event belongs to currently active conversation:
          if (convId && convId === activeConversationRef.current) {
            // Dismiss syncing skeleton immediately upon interaction arrival
            if (syncingDelayRef.current) {
              clearTimeout(syncingDelayRef.current);
              syncingDelayRef.current = null;
            }
            if (syncingTimeoutRef.current) {
              clearTimeout(syncingTimeoutRef.current);
              syncingTimeoutRef.current = null;
            }
            setIsSyncingNewMessage(false);

            // Fast Path: Map directly into safe InboxMessage if required fields exist
            const hasRequiredFields =
              Boolean(newInteraction.id) &&
              Boolean(newInteraction.conversation_id) &&
              typeof newInteraction.sanitized_content === 'string' &&
              Boolean(newInteraction.created_at);

            if (hasRequiredFields) {
              const isOutbound = (newInteraction.direction || '').toUpperCase() === 'OUTBOUND';
              const senderType: SenderType =
                newInteraction.actor_type === 'CUSTOMER'
                  ? 'customer'
                  : newInteraction.actor_type === 'AI'
                    ? 'ai'
                    : isOutbound
                      ? 'sale'
                      : 'customer';

              const activeConv = selectedConversationRef.current;
              let senderName = '';
              if (senderType === 'customer') {
                senderName = activeConv?.customer_name || 'Khách hàng';
              } else if (senderType === 'sale') {
                senderName = userFullNameRef.current || 'Bạn (Sale)';
              } else if (senderType === 'ai') {
                senderName = 'AI Trợ lý';
              }

              const safeMessage: InboxMessage = {
                id: newInteraction.id!,
                company_id: newInteraction.company_id || activeConv?.company_id,
                conversation_id: convId,
                customer_id: newInteraction.customer_id || activeConv?.customer_id || '',
                channel: (newInteraction.channel || activeConv?.channel || 'facebook').toLowerCase() as InboxChannel,
                sender_type: senderType,
                sender_name: senderName,
                content: newInteraction.sanitized_content!,
                sanitized_content: newInteraction.sanitized_content!,
                created_at: newInteraction.created_at!,
                direction: isOutbound ? 'outbound' : 'inbound',
                delivery_status: isOutbound ? (newInteraction.delivery_status as MessageDeliveryStatus) : undefined,
              };

              // Merge directly and immediately into state keyed by conversation (deduped on interaction.id)
              setMessagesByConversation((prev) => {
                const existing = prev[convId] || [];
                if (existing.some((m) => m.id === safeMessage.id)) {
                  return prev;
                }
                return {
                  ...prev,
                  [convId]: [...existing, safeMessage],
                };
              });
            }

            // In all cases, call silent background reconciliation without blocking the bubble
            void fetchMessages(convId, { silent: true }).then(() => {
              const uiMessageVisibleAt = Date.now();
              const dbToUiMs = createdAt ? uiMessageVisibleAt - createdAt : null;
              console.log(`[REALTIME LATENCY] DB -> UI message reconciled: ${dbToUiMs}ms`);
            });
          }

          // In all cases, refresh conversation list silently so unread badges, ordering, and snippets update
          void fetchConversations({ silent: true });
        }
      )
      // 2. Subscribe to public.conversations INSERT & UPDATE
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversations',
        },
        (payload) => {
          if (payload.eventType === 'UPDATE' && payload.new) {
            const updatedConv = payload.new as {
              id?: string;
              last_message_at?: string;
              [key: string]: unknown;
            };
            if (updatedConv.id && updatedConv.id === activeConversationRef.current) {
              const convId = updatedConv.id;
              const prevLastAt = activeConversationLastMessageAtRef.current;
              const newLastAt = updatedConv.last_message_at;
              const newLastAtMs = newLastAt ? new Date(newLastAt).getTime() : 0;
              const prevLastAtMs = prevLastAt ? new Date(prevLastAt).getTime() : 0;

              const advanced = Boolean(
                newLastAtMs && (!prevLastAtMs || newLastAtMs > prevLastAtMs)
              );
              if (advanced) {
                activeConversationLastMessageAtRef.current = newLastAt || null;

                // Correlate event timing: check if interaction for this last_message_at or newer has ALREADY been rendered
                const latestRenderedMs = latestRenderedInteractionTimeByConvRef.current[convId] || 0;
                const isAlreadyRendered = latestRenderedMs >= newLastAtMs;

                if (!isAlreadyRendered) {
                  // Anti-flicker delay 180ms
                  if (syncingDelayRef.current) clearTimeout(syncingDelayRef.current);
                  syncingDelayRef.current = setTimeout(() => {
                    // Double check right before showing skeleton: did interaction arrive during the 180ms window?
                    const currentRenderedMs = latestRenderedInteractionTimeByConvRef.current[convId] || 0;
                    if (currentRenderedMs >= newLastAtMs) {
                      return; // Arrived! Do not show skeleton
                    }
                    setIsSyncingNewMessage(true);
                    if (syncingTimeoutRef.current) clearTimeout(syncingTimeoutRef.current);
                    syncingTimeoutRef.current = setTimeout(() => {
                      setIsSyncingNewMessage(false);
                    }, 4000);
                  }, 180);
                } else {
                  // Already rendered: do NOT show skeleton, clear any lingering timer
                  if (syncingDelayRef.current) {
                    clearTimeout(syncingDelayRef.current);
                    syncingDelayRef.current = null;
                  }
                  if (syncingTimeoutRef.current) {
                    clearTimeout(syncingTimeoutRef.current);
                    syncingTimeoutRef.current = null;
                  }
                  setIsSyncingNewMessage(false);
                }
              }
            }
          }
          void fetchConversations({ silent: true });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[REALTIME] Subscribed to inbox interactions & conversations successfully.');
        }
      });

    return () => {
      if (supabase && channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [fetchMessages, fetchConversations]);

  // Section 11: Fallback silent polling (15s reconciliation loop in case realtime event is missed or reconnects)
  useEffect(() => {
    const fallbackIntervalId = setInterval(() => {
      if (activeConversationRef.current) {
        void fetchMessages(activeConversationRef.current, { silent: true });
      }
      void fetchConversations({ silent: true });
    }, 15000);

    return () => {
      clearInterval(fallbackIntervalId);
    };
  }, [fetchMessages, fetchConversations]);

  // Smart polling for pending outbound delivery status (Requirements 3 & 4)
  useEffect(() => {
    if (!selectedConversationId) return;
    const convId = selectedConversationId;

    const convMsgs = messagesByConversation[convId] || [];
    const hasPendingOutbound = convMsgs.some(
      (m) =>
        (m.direction || '').toLowerCase() === 'outbound' &&
        isPendingDelivery(m.delivery_status)
    );

    if (!hasPendingOutbound) return;

    const intervalId = setInterval(() => {
      if (activeConversationRef.current === convId) {
        void fetchMessages(convId, { silent: true });
      }
    }, 2500);

    return () => {
      clearInterval(intervalId);
    };
  }, [selectedConversationId, messagesByConversation, fetchMessages]);

  // Current draft for active conversation (P0-B)
  const currentDraft = selectedConversationId ? (draftsByConversation[selectedConversationId] || '') : '';

  const handleDraftChange = (newText: string) => {
    if (!selectedConversationId) return;
    setDraftsByConversation((prev) => ({
      ...prev,
      [selectedConversationId]: newText,
    }));
    // Clear send error for this conversation upon new typing
    if (sendErrorByConversation[selectedConversationId]) {
      setSendErrorByConversation((prev) => ({
        ...prev,
        [selectedConversationId]: null,
      }));
    }
  };

  const handleSendFailure = (
    convId: string,
    commandId: string,
    originalText: string,
    errorMessage: string
  ) => {
    // 1. Remove optimistic pending bubble so it never hangs in PENDING
    setMessagesByConversation((prev) => ({
      ...prev,
      [convId]: (prev[convId] || []).filter((m) => m.client_command_id !== commandId),
    }));

    // 2. Restore draft ONLY IF user has not typed a new draft in this conversation
    setDraftsByConversation((prev) => {
      const current = prev[convId];
      if (!current || current.trim() === '') {
        return {
          ...prev,
          [convId]: originalText,
        };
      }
      return prev;
    });

    // 3. Keep pending command for idempotent retry with exact content
    pendingCommandsRef.current[convId] = { commandId, content: originalText };

    // 4. Set error notice for this conversation
    setSendErrorByConversation((prev) => ({
      ...prev,
      [convId]: errorMessage,
    }));
  };

  // 3. Send Message Action with strict conversation and command isolation (P0-B) & robust failure path
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedConversationId) return;
    if (sendingByConversation[selectedConversationId]) return;

    // Capture immutable sendConversationId
    const sendConversationId = selectedConversationId;
    const text = (draftsByConversation[sendConversationId] || '').trim();
    if (!text) return;

    // Determine commandId strictly scoped to sendConversationId
    const pendingForConv = pendingCommandsRef.current[sendConversationId];
    let commandId: string;
    if (pendingForConv && pendingForConv.content === text) {
      // Network retry: REUSE SAME commandId for this exact conversation
      commandId = pendingForConv.commandId;
    } else {
      // New logical send: generate NEW UUID
      commandId = crypto.randomUUID();
      pendingCommandsRef.current[sendConversationId] = { commandId, content: text };
    }

    setSendingByConversation((prev) => ({ ...prev, [sendConversationId]: true }));
    setSendErrorByConversation((prev) => ({ ...prev, [sendConversationId]: null }));

    const currentConv = conversations.find((c) => c.id === sendConversationId);

    // Optimistic message in sendConversationId's cache
    const optimisticMsg: InboxMessage = {
      id: `optimistic-${commandId}`,
      conversation_id: sendConversationId,
      customer_id: currentConv?.customer_id || '',
      channel: currentConv?.channel || 'facebook',
      sender_type: 'sale',
      sender_name: userFullName || 'Bạn (Sale)',
      content: text,
      created_at: new Date().toISOString(),
      direction: 'outbound',
      delivery_status: 'PENDING_DISPATCH',
      client_command_id: commandId,
    };

    setMessagesByConversation((prev) => ({
      ...prev,
      [sendConversationId]: [...(prev[sendConversationId] || []), optimisticMsg],
    }));

    // Clear draft ONLY for sendConversationId
    setDraftsByConversation((prev) => ({
      ...prev,
      [sendConversationId]: '',
    }));

    try {
      const res = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: sendConversationId,
          content: text,
          client_command_id: commandId,
        }),
      });

      const json = await res.json().catch(() => null);

      if (res.ok && json?.success && json?.data) {
        // Success: update cache for sendConversationId
        setMessagesByConversation((prev) => {
          const convMsgs = prev[sendConversationId] || [];
          const exists = convMsgs.some(
            (m) =>
              m.id === json.data.id ||
              (m.client_command_id && m.client_command_id === json.data.client_command_id)
          );

          if (exists) {
            return {
              ...prev,
              [sendConversationId]: convMsgs.map((m) =>
                m.id === json.data.id ||
                (m.client_command_id && m.client_command_id === json.data.client_command_id)
                  ? {
                      ...m,
                      ...json.data,
                      client_command_id: m.client_command_id || json.data.client_command_id,
                      delivery_status: mergeDeliveryStatus(
                        m.delivery_status,
                        json.data.delivery_status
                      ),
                    }
                  : m
              ),
            };
          }

          // If not duplicate, replace optimistic message preserving any updated delivery status
          const optimisticMatch = convMsgs.find(
            (m) => m.client_command_id && m.client_command_id === commandId
          );
          const serverDataWithMergedStatus = optimisticMatch
            ? {
                ...json.data,
                client_command_id: optimisticMatch.client_command_id || json.data.client_command_id,
                delivery_status: mergeDeliveryStatus(
                  optimisticMatch.delivery_status,
                  json.data.delivery_status
                ),
              }
            : json.data;

          return {
            ...prev,
            [sendConversationId]: convMsgs
              .filter((m) => m.client_command_id !== commandId)
              .concat(serverDataWithMergedStatus),
          };
        });

        // Clear pending command for this conversation on success
        delete pendingCommandsRef.current[sendConversationId];

        // Update conversation list preview
        setConversations((prev) =>
          prev.map((c) =>
            c.id === sendConversationId
              ? { ...c, last_message: text, updated_at: json.data.created_at }
              : c
          )
        );
      } else {
        const errorMsg = json?.error || `Gửi tin nhắn thất bại (HTTP ${res.status})`;
        handleSendFailure(sendConversationId, commandId, text, errorMsg);
      }
    } catch (err: unknown) {
      console.error('Lỗi khi gửi tin nhắn:', err);
      const errorMsg = err instanceof Error ? err.message : 'Lỗi kết nối khi gửi tin nhắn';
      handleSendFailure(sendConversationId, commandId, text, errorMsg);
    } finally {
      setSendingByConversation((prev) => ({ ...prev, [sendConversationId]: false }));
    }
  };

  const isSendingCurrent = Boolean(selectedConversationId && sendingByConversation[selectedConversationId]);
  const isLoadingAiCurrent = Boolean(selectedConversationId && loadingAiByConversation[selectedConversationId]);
  const currentSendError = selectedConversationId ? sendErrorByConversation[selectedConversationId] : null;

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
      <div className="flex-1 grid grid-cols-1 md:grid-cols-12 min-h-0 overflow-hidden">
        {/* ================================================================== */}
        {/* CỘT TRÁI (3.5 cols): Danh sách hội thoại & Bộ lọc                  */}
        {/* ================================================================== */}
        <div className="md:col-span-4 lg:col-span-3 border-r border-slate-800 flex flex-col min-h-0 h-full bg-slate-900/50 overflow-hidden">
          {/* Filter Bar */}
          <div className="shrink-0 p-3 border-b border-slate-800 space-y-2.5">
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
          <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-800/50">
            {loadingConversations ? (
              <div className="p-3 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-14 bg-slate-800/40 rounded-xl animate-pulse" />
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <div className="p-6 text-center space-y-3">
                <div className="w-10 h-10 rounded-xl bg-slate-800/60 border border-slate-700/60 flex items-center justify-center mx-auto text-slate-400">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                </div>
                <div className="text-xs font-semibold text-slate-300">Chưa có hội thoại</div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {search.trim()
                    ? `Không tìm thấy kết quả phù hợp cho "${search}".`
                    : channelFilter !== 'all'
                      ? `Chưa có hội thoại trên kênh ${channelFilter === 'zalo' ? 'Zalo OA' : 'Facebook Messenger'}. Hãy kết nối kênh để bắt đầu nhận tin nhắn.`
                      : 'Chưa có hội thoại. Hãy kết nối Facebook Page hoặc Zalo OA để bắt đầu nhận tin nhắn.'}
                </p>
              </div>
            ) : (
              conversations.map((conv) => {
                const isSelected = conv.id === selectedConversationId;
                const isZalo = conv.channel === 'zalo';

                return (
                  <div
                    key={conv.id}
                    role="button"
                    tabIndex={0}
                    aria-selected={isSelected}
                    onClick={() => handleSelectConversation(conv.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectConversation(conv.id);
                      }
                    }}
                    className={`p-3.5 transition cursor-pointer relative flex flex-col gap-1 focus:outline-none focus:ring-1 focus:ring-blue-500/50 ${
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
                          {conv.customer_name || 'Khách hàng'}
                        </span>
                        {conv.metadata?.provider === 'facebook_browser' && (
                          <span
                            className="px-1 py-0.5 rounded text-[9px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                            title="Đồng bộ từ Meta Business Suite"
                          >
                            Browser
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-slate-500">
                          {formatMessageTime(conv.updated_at)}
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

                    <div className="flex items-center gap-2 mt-1 text-[10px] min-w-0">
                      <span className="font-mono text-slate-400 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 shrink-0">
                        {conv.customer_code}
                      </span>
                      {!isZalo && conv.channel_page_name && (
                        <span
                          className="truncate text-blue-300 bg-blue-950/40 px-1.5 py-0.5 rounded border border-blue-800/40"
                          title={`Khách nhắn vào Page: ${conv.channel_page_name}`}
                        >
                          {conv.channel_page_name}
                        </span>
                      )}
                      {conv.status === 'AI_HANDLING' && (
                        <span className="text-purple-400 bg-purple-950/40 px-1.5 py-0.5 rounded border border-purple-800/40 shrink-0">
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
        <div className="md:col-span-8 lg:col-span-6 flex flex-col min-h-0 h-full bg-slate-950 border-r border-slate-800 overflow-hidden">
          {selectedConversation ? (
            <>
              {/* Chat Header */}
              <div className="shrink-0 p-3.5 px-5 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-white">
                    {getInitials(selectedConversation.customer_name)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white text-sm">
                        {selectedConversation.customer_name}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border max-w-[240px] truncate ${
                          selectedConversation.channel === 'zalo'
                            ? 'bg-cyan-950/50 text-cyan-300 border-cyan-800/50'
                            : 'bg-blue-950/50 text-blue-300 border-blue-800/50'
                        }`}
                        title={
                          selectedConversation.channel === 'facebook' && selectedConversation.channel_page_name
                            ? `Facebook Page: ${selectedConversation.channel_page_name}`
                            : undefined
                        }
                      >
                        {selectedConversation.channel === 'zalo'
                          ? 'Zalo OA'
                          : `Facebook · ${selectedConversation.channel_page_name || 'Messenger'}`}
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

              {/* Chat Stream (Independent Scroll, Isolated Messages) */}
              <div className="flex-1 min-h-0 relative flex flex-col bg-slate-950">
                <div
                  ref={scrollContainerRef}
                  onScroll={handleScroll}
                  className="flex-1 min-h-0 p-4 overflow-y-auto space-y-3.5"
                >
                {loadingMessages ? (
                  <div className="space-y-3">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="h-12 bg-slate-900 rounded-xl animate-pulse" />
                    ))}
                  </div>
                ) : visibleMessages.length === 0 ? (
                  <div className="text-center py-12 text-xs text-slate-500">
                    Chưa có tin nhắn nào trong cuộc hội thoại này.
                  </div>
                ) : (
                  visibleMessages.map((msg) => {
                    const isSaleMsg = msg.sender_type === 'sale';
                    const isAiMsg = msg.sender_type === 'ai';

                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${
                          isSaleMsg ? 'items-end' : 'items-start'
                        }`}
                      >
                        {/* Sender Label & Delivery Status */}
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
                            {formatMessageTime(msg.created_at)}
                          </span>

                          {/* Outbound Delivery Status (Phase 2B.1 Hardening & UX Polish) */}
                          {isSaleMsg && renderDeliveryBadge(msg.delivery_status) && (
                            <>
                              <span>•</span>
                              {renderDeliveryBadge(msg.delivery_status)}
                            </>
                          )}
                        </div>

                        {/* Message Bubble */}
                        <div
                          className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-xs sm:text-sm leading-relaxed ${
                            isSaleMsg
                              ? (msg.delivery_status || '').toUpperCase() === 'FAILED'
                                ? 'bg-rose-950/70 border border-rose-500/80 text-rose-100 rounded-tr-none shadow-md shadow-rose-900/20'
                                : (msg.delivery_status || '').toUpperCase() === 'RECONCILE_REQUIRED'
                                  ? 'bg-amber-950/70 border border-amber-500/80 text-amber-100 rounded-tr-none'
                                  : isPendingDelivery(msg.delivery_status)
                                    ? 'bg-blue-700/80 border border-blue-400/50 text-white rounded-tr-none'
                                    : 'bg-blue-600 text-white rounded-tr-none shadow-md shadow-blue-600/10'
                              : isAiMsg
                                ? 'bg-purple-950/40 border border-purple-700/40 text-purple-100 rounded-tl-none'
                                : 'bg-slate-800 text-slate-100 border border-slate-700/60 rounded-tl-none'
                          }`}
                        >
                          <MessageContent content={msg.content} isOutbound={isSaleMsg} />
                        </div>

                        {isSaleMsg && msg.delivery_status === 'FAILED' && (
                          <span className="text-[10px] text-rose-400 mt-0.5 font-medium">⚠️ Khách chưa nhận được tin nhắn. Có thể thử lại.</span>
                        )}
                      </div>
                    );
                  })
                )}
                {isSyncingNewMessage && (
                  <div
                    role="status"
                    aria-label="Đang đồng bộ tin nhắn mới"
                    className="flex flex-col items-start space-y-1 animate-pulse"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-0.5 px-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
                      <span>Đang đồng bộ tin nhắn mới…</span>
                    </div>
                    <div className="h-9 w-44 rounded-2xl rounded-tl-none bg-slate-800/60 border border-slate-700/40 flex items-center px-3.5 gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-slate-700 animate-pulse" />
                      <div className="h-2 w-28 bg-slate-700/70 rounded" />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
                </div>

                {showNewMessagePill && (
                  <button
                    type="button"
                    onClick={scrollToBottom}
                    className="absolute bottom-4 right-6 z-20 px-3.5 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xl flex items-center gap-1.5 transition-all duration-200 animate-bounce"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                    <span>Tin nhắn mới</span>
                  </button>
                )}
              </div>

              {/* Message Input Box (Fixed at bottom) */}
              <div className="shrink-0 p-3 border-t border-slate-800 bg-slate-900/80">
                <form onSubmit={handleSendMessage} className="space-y-2">
                  {/* AI Draft Suggestion Box */}
                  {aiError && (
                    <div className="p-2 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-300 text-xs flex justify-between items-center">
                      <span>{aiError}</span>
                      <button type="button" onClick={() => setAiError(null)} className="underline text-[10px]">Đóng</button>
                    </div>
                  )}

                  {aiSuggestion && (
                    <div className="p-3 rounded-xl bg-purple-950/40 border border-purple-800/60 text-xs space-y-2">
                      <div className="flex items-center justify-between text-purple-300 font-semibold">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></span>
                          <span>Gợi ý trả lời từ AI (Bản nháp - Chưa gửi khách)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              handleDraftChange(aiSuggestion);
                              setAiSuggestion(null);
                            }}
                            className="px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-medium transition"
                          >
                            Dùng gợi ý
                          </button>
                          <button
                            type="button"
                            onClick={() => setAiSuggestion(null)}
                            className="text-slate-400 hover:text-white text-[11px]"
                          >
                            Bỏ qua
                          </button>
                        </div>
                      </div>
                      <p className="text-slate-200 italic bg-purple-950/60 p-2 rounded border border-purple-900/40">
                        &ldquo;{aiSuggestion}&rdquo;
                      </p>
                      <div className="flex items-center gap-3 text-[10px] text-purple-300/80">
                        <span>Phong cách: {aiSuggestionMeta?.isNeutralDefault ? 'Chuẩn mực mặc định' : 'Cá nhân hóa'}</span>
                        {aiSuggestionMeta?.analysisSummary && <span>• Đã áp dụng phân tích hành trình</span>}
                      </div>
                    </div>
                  )}

                  {currentSendError && (
                    <div className="mb-2 p-2 bg-rose-950/60 border border-rose-800/60 rounded-xl flex items-center justify-between text-xs text-rose-300 animate-fadeIn">
                      <div className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 text-rose-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{currentSendError}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (selectedConversationId) {
                            setSendErrorByConversation((prev) => ({ ...prev, [selectedConversationId]: null }));
                          }
                        }}
                        className="text-rose-400 hover:text-white px-1 text-xs"
                      >
                        ✕
                      </button>
                    </div>
                  )}

                  <div className="flex items-end gap-2">
                    <textarea
                      rows={2}
                      value={currentDraft}
                      onChange={(e) => handleDraftChange(e.target.value)}
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
                      type="button"
                      disabled={isLoadingAiCurrent || isSendingCurrent}
                      onClick={handleRequestAiSuggestion}
                      className="px-3 py-3 rounded-xl bg-purple-900/40 hover:bg-purple-800/50 border border-purple-700/60 text-purple-300 hover:text-white font-medium text-xs flex items-center gap-1 transition disabled:opacity-40"
                      title="Tạo bản nháp gợi ý từ AI dựa trên phong cách Sale và phân tích khách hàng"
                    >
                      {isLoadingAiCurrent ? (
                        <span>Đang tạo...</span>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <span>Gợi ý AI</span>
                        </>
                      )}
                    </button>

                    <button
                      type="submit"
                      disabled={isSendingCurrent || !currentDraft.trim()}
                      className="px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-lg shadow-blue-600/20"
                    >
                      {isSendingCurrent ? (
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
          ) : conversations.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-10 text-center bg-slate-950 overflow-y-auto">
              <div className="max-w-lg space-y-6">
                <div className="relative mx-auto w-20 h-20 flex items-center justify-center">
                  <div className="absolute inset-0 rounded-3xl bg-blue-500/10 border border-blue-500/20 animate-pulse" />
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-blue-600/30 to-cyan-600/30 border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-xl">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                  </div>
                  <span className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold flex items-center justify-center shadow">
                    Z
                  </span>
                  <span className="absolute -bottom-1 -left-1 w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300 text-[10px] font-bold flex items-center justify-center shadow">
                    F
                  </span>
                </div>

                <div className="space-y-2">
                  <h3 className="text-base sm:text-lg font-bold text-white">
                    Hộp Thư Đa Kênh — Chưa Có Hội Thoại
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-300 font-medium">
                    Chưa có hội thoại. Hãy kết nối Facebook Page hoặc Zalo OA để bắt đầu nhận tin nhắn.
                  </p>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed">
                    Hệ thống AI CRM Cửa Chống Ngập sẵn sàng tiếp nhận tin nhắn từ Facebook Messenger và Zalo Official Account qua Webhook thời gian thực.
                  </p>
                </div>

                {/* Omnichannel Channels Overview Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
                  <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-blue-500/40 transition space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-md bg-blue-500/20 text-blue-400 font-bold text-xs flex items-center justify-center">
                        F
                      </span>
                      <span className="font-semibold text-white text-xs">Facebook Messenger</span>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Tiếp nhận tin nhắn tư vấn từ Fanpage Facebook. Tự động liên kết khách hàng và kích hoạt AI sau 5 phút.
                    </p>
                    <div className="flex items-center gap-1.5 pt-1 text-[10px] text-blue-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      <span>Sẵn sàng kết nối qua Webhook Meta</span>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-cyan-500/40 transition space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-md bg-cyan-500/20 text-cyan-400 font-bold text-xs flex items-center justify-center">
                        Z
                      </span>
                      <span className="font-semibold text-white text-xs">Zalo OA</span>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Tiếp nhận tương tác từ Zalo Official Account. Tư vấn kích thước cửa, tính giá và chuyển giao Sale.
                    </p>
                    <div className="flex items-center gap-1.5 pt-1 text-[10px] text-cyan-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                      <span>Sẵn sàng kết nối qua Zalo Webhook</span>
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800/80 text-[11px] text-slate-400 flex items-center justify-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span>Cơ chế bảo mật Zero-Phone &amp; SLA 5 phút luôn hoạt động</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center p-8 text-slate-500 text-xs">
              Vui lòng chọn một cuộc hội thoại từ danh sách bên trái để bắt đầu chat.
            </div>
          )}
        </div>

        {/* ================================================================== */}
        {/* CỘT PHẢI (3 cols): Thông tin vắn tắt khách hàng                    */}
        {/* ================================================================== */}
        <div className="hidden lg:flex lg:flex-col lg:col-span-3 min-h-0 h-full p-4 bg-slate-900/40 overflow-y-auto space-y-4 text-xs">
          {selectedConversation ? (
            <>
              {/* Profile Card */}
              <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl text-center space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 mx-auto flex items-center justify-center text-white font-bold text-base shadow-lg shadow-blue-600/20">
                  {getInitials(selectedConversation.customer_name)}
                </div>
                <div>
                  <h3 className="font-bold text-white text-sm">
                    {selectedConversation.customer_name || 'Khách hàng'}
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

                  {selectedConversation.channel === 'facebook' && (
                    <div className="flex justify-between gap-3 py-1 border-b border-slate-800/60">
                      <span className="text-slate-500 shrink-0">Khách nhắn vào Page:</span>
                      <span
                        className="font-medium text-blue-300 text-right break-words"
                        title={selectedConversation.channel_page_id || undefined}
                      >
                        {selectedConversation.channel_page_name ||
                          selectedConversation.channel_page_id ||
                          'Chưa xác định'}
                      </span>
                    </div>
                  )}

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
            <div className="space-y-4 text-xs">
              <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl text-center space-y-2">
                <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 text-blue-400 flex items-center justify-center mx-auto">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h4 className="font-bold text-white text-xs">Trung Tâm Hỗ Trợ Đa Kênh</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Chọn một cuộc trò chuyện để xem hồ sơ 360 khách hàng, lịch sử trao đổi và tạo gợi ý phản hồi AI.
                </p>
              </div>

              <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-3">
                <h4 className="font-semibold text-slate-300 uppercase tracking-wider text-[10px]">
                  Quy trình nghiệp vụ đa kênh
                </h4>
                <ul className="space-y-2.5 text-[11px] text-slate-400">
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-blue-950 text-blue-400 border border-blue-800 flex items-center justify-center font-bold text-[9px] shrink-0 mt-0.5">1</span>
                    <span>Khách gửi tin nhắn từ Facebook Messenger hoặc Zalo OA.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-blue-950 text-blue-400 border border-blue-800 flex items-center justify-center font-bold text-[9px] shrink-0 mt-0.5">2</span>
                    <span>Webhook tiếp nhận, tự động liên kết khách hàng theo Zero-Phone.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-blue-950 text-blue-400 border border-blue-800 flex items-center justify-center font-bold text-[9px] shrink-0 mt-0.5">3</span>
                    <span>Chuyên viên Sale trả lời trực tiếp hoặc nhận gợi ý trả lời từ AI.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-blue-950 text-blue-400 border border-blue-800 flex items-center justify-center font-bold text-[9px] shrink-0 mt-0.5">4</span>
                    <span>Nếu Sale bận quá 5 phút, AI tự động phản hồi theo Policy Firewall.</span>
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}