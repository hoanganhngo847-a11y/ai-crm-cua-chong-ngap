'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getZaloCallSummary,
  getZaloTranscription,
  linkZaloCustomer,
  listZaloCalls,
  playZaloRecording,
  retryZaloCallSummaryAction,
  retryZaloTranscription,
  searchZaloCustomers,
} from '../../../actions/zalo-recordings';
import { Card, CardTitle } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import {
  Play,
  RotateCcw,
  Sparkles,
  FileText,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';

type Call = Awaited<ReturnType<typeof listZaloCalls>>['items'][number];
type Candidate = { id: string; name: string; customer_code: string };

function formatTranscriptTime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function CallCard({ call, onLinked }: { call: Call; onLinked: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [remember, setRemember] = useState(false);
  const [newName, setNewName] = useState(call.remote_display_name || '');
  const [creating, setCreating] = useState(false);
  const [showRelink, setShowRelink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [audio, setAudio] = useState('');
  const initialStatus =
    (call as { transcript_status?: string }).transcript_status || 'PENDING';
  const [transcriptStatus, setTranscriptStatus] = useState<string>(initialStatus);
  const [transcript, setTranscript] =
    useState<Awaited<ReturnType<typeof getZaloTranscription>> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);

  const initialSummaryStatus =
    (call as { summary_status?: string }).summary_status || 'NOT_STARTED';
  const [summaryStatus, setSummaryStatus] = useState<string>(initialSummaryStatus);
  const [summary, setSummary] =
    useState<Awaited<ReturnType<typeof getZaloCallSummary>> | null>(null);
  const [expandedSummary, setExpandedSummary] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [retrySummaryBusy, setRetrySummaryBusy] = useState(false);

  const customer = (
    Array.isArray(call.customers) ? call.customers[0] : call.customers
  ) as { name: string; customer_code: string } | null;

  useEffect(() => {
    if (call.customer_id) return;
    let active = true;
    // Automatically link unlinked calls immediately without manual user intervention
    searchZaloCustomers(call.id)
      .then(async (items) => {
        if (!active) return;
        if (items.length > 0) {
          await linkZaloCustomer(call.id, items[0].id, true);
        } else {
          const autoName =
            call.remote_display_name && call.remote_display_name !== 'Chưa xác định tên'
              ? call.remote_display_name
              : `Khách Zalo ${new Date(call.started_at).toLocaleString('vi-VN', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`;
          await linkZaloCustomer(call.id, null, true, autoName);
        }
        if (active) onLinked();
      })
      .catch(async () => {
        if (!active) return;
        const autoName =
          call.remote_display_name && call.remote_display_name !== 'Chưa xác định tên'
            ? call.remote_display_name
            : `Khách Zalo ${new Date(call.started_at).toLocaleString('vi-VN', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}`;
        try {
          await linkZaloCustomer(call.id, null, true, autoName);
          if (active) onLinked();
        } catch {
          // ignore
        }
      });
    return () => {
      active = false;
    };
  }, [call.id, call.customer_id, call.remote_display_name, call.started_at, onLinked]);

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch {
      setError('Thao tác chưa thành công. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleTranscript() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!transcript) {
      setLoadingTranscript(true);
      try {
        const data = await getZaloTranscription(call.id);
        setTranscript(data);
        if (data?.status) setTranscriptStatus(data.status);
        setExpanded(true);
      } catch {
        setError('Không thể tải nội dung bóc băng.');
      } finally {
        setLoadingTranscript(false);
      }
    } else {
      setExpanded(true);
    }
  }

  async function handleRetryTranscription() {
    setRetryBusy(true);
    setError('');
    try {
      await retryZaloTranscription(call.id);
      const data = await getZaloTranscription(call.id);
      setTranscript(data);
      if (data?.status) setTranscriptStatus(data.status);
      if (data?.status === 'COMPLETED') {
        setExpanded(true);
        // Also refresh summary if ready
        const sumData = await getZaloCallSummary(call.id).catch(() => null);
        if (sumData) {
          setSummary(sumData);
          if (sumData.status) setSummaryStatus(sumData.status);
        }
      }
    } catch {
      setError('Không thể yêu cầu thử lại bóc băng. Vui lòng thử lại sau.');
    } finally {
      setRetryBusy(false);
    }
  }

  async function toggleSummary() {
    if (expandedSummary) {
      setExpandedSummary(false);
      return;
    }
    if (!summary) {
      setLoadingSummary(true);
      try {
        const data = await getZaloCallSummary(call.id);
        setSummary(data);
        if (data?.status) setSummaryStatus(data.status);
        setExpandedSummary(true);
      } catch {
        setError('Không thể tải tóm tắt AI.');
      } finally {
        setLoadingSummary(false);
      }
    } else {
      setExpandedSummary(true);
    }
  }

  async function handleRetrySummary() {
    setRetrySummaryBusy(true);
    setError('');
    try {
      await retryZaloCallSummaryAction(call.id);
      const data = await getZaloCallSummary(call.id);
      setSummary(data);
      if (data?.status) setSummaryStatus(data.status);
      if (data?.status === 'COMPLETED') {
        setExpandedSummary(true);
      }
    } catch {
      setError('Không thể yêu cầu thử lại tóm tắt AI. Vui lòng thử lại sau.');
    } finally {
      setRetrySummaryBusy(false);
    }
  }

  return (
    <article className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] shadow-xs space-y-4 hover:border-[var(--border-strong)] transition-all">
      {/* Top Header: Participant & Play button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-cyan-50 border border-cyan-200 text-cyan-700 flex items-center justify-center font-bold text-xs shrink-0">
            Zalo
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-xs sm:text-sm text-[var(--text-primary)]">
                {call.remote_display_name || 'Chưa xác định tên'}
              </h3>
              <Badge variant="info" size="xs">
                Zalo Personal
              </Badge>
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-mono font-medium ${
                  call.direction === 'INBOUND'
                    ? 'bg-blue-50 text-blue-700'
                    : 'bg-purple-50 text-purple-700'
                }`}
              >
                {call.direction === 'INBOUND' ? (
                  <>
                    <PhoneIncoming className="w-2.5 h-2.5" />
                    <span>Gọi đến</span>
                  </>
                ) : (
                  <>
                    <PhoneOutgoing className="w-2.5 h-2.5" />
                    <span>Gọi đi</span>
                  </>
                )}
              </span>
            </div>

            <p className="text-xs text-[var(--text-secondary)] mt-0.5 font-mono">
              {new Date(call.started_at).toLocaleString('vi-VN')} • {Math.round(call.duration_seconds)}s
            </p>
          </div>
        </div>

        <Button
          type="button"
          disabled={busy}
          onClick={() =>
            perform(async () => setAudio(await playZaloRecording(call.id)))
          }
          variant="secondary"
          size="xs"
          leftIcon={<Play className="w-3 h-3 fill-current text-[var(--accent)]" />}
        >
          Nghe ghi âm
        </Button>
      </div>

      {/* Audio Player */}
      {audio && (
        <div className="p-2.5 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)]">
          <audio
            controls
            autoPlay
            src={audio}
            className="w-full h-8"
            onError={() =>
              setError(
                'Liên kết nghe đã hết hạn hoặc file chưa tải được. Bấm Nghe ghi âm để lấy lại.'
              )
            }
          />
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
          {error}
        </div>
      )}

      {/* Customer Linking Section */}
      {call.customer_id ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] flex-wrap">
          <span>Khách hàng gắn kết:</span>
          <Link
            href={`/customers/${call.customer_id}/dossier`}
            className="font-medium text-[var(--accent)] hover:underline"
          >
            {customer?.name || call.remote_display_name || 'Xem hồ sơ 360'}
          </Link>
          {customer?.customer_code && (
            <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
              ({customer.customer_code})
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowRelink((v) => !v)}
            className="text-[11px] text-[var(--text-tertiary)] hover:text-[var(--accent)] underline ml-auto cursor-pointer"
          >
            {showRelink ? 'Đóng' : 'Đổi liên kết'}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)] p-2 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)]">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
            <span>Đang tự động liên kết hồ sơ khách hàng...</span>
          </div>
          <button
            type="button"
            onClick={() => setShowRelink((v) => !v)}
            className="text-[11px] text-[var(--text-tertiary)] hover:text-[var(--accent)] underline cursor-pointer"
          >
            {showRelink ? 'Đóng' : 'Liên kết thủ công'}
          </button>
        </div>
      )}

      {showRelink && (
        <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-2.5 text-xs">
          <div className="flex items-center gap-1.5 text-[var(--text-primary)] font-medium">
            <span>Tìm kiếm &amp; chọn khách hàng liên kết</span>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                setCandidates(await searchZaloCustomers(call.id, search));
                setSelected('');
              });
            }}
            className="flex gap-2"
          >
            <input
              aria-label="Tìm khách hàng"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              minLength={2}
              maxLength={200}
              placeholder="Tìm theo tên hoặc mã KH..."
              className="min-w-0 flex-1 h-8 px-2.5 text-xs bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <Button
              type="submit"
              variant="outline"
              size="xs"
              disabled={busy || search.trim().length < 2}
            >
              Tìm
            </Button>
          </form>

          {candidates.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <span className="text-[11px] text-[var(--text-tertiary)] block">
                Gợi ý khách hàng phù hợp:
              </span>
              <div className="space-y-1">
                {candidates.map((candidate) => (
                  <label
                    key={candidate.id}
                    className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-[var(--surface-hover)] transition-colors"
                  >
                    <input
                      type="radio"
                      name={`customer-${call.id}`}
                      value={candidate.id}
                      checked={selected === candidate.id}
                      onChange={() => {
                        setSelected(candidate.id);
                        setCreating(false);
                      }}
                      className="text-[var(--accent)] focus:ring-[var(--accent)]"
                    />
                    <span className="font-medium text-[var(--text-primary)]">
                      {candidate.name}
                    </span>
                    <span className="font-mono text-[var(--text-tertiary)] text-[11px]">
                      ({candidate.customer_code})
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={remember}
              disabled={!call.remote_display_name}
              onChange={(e) => setRemember(e.target.checked)}
              className="rounded text-[var(--accent)] focus:ring-[var(--accent)]"
            />
            <span className="text-[11px] text-[var(--text-secondary)]">
              Ghi nhớ liên kết Zalo này cho các cuộc gọi sau
            </span>
          </label>

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <Button
              disabled={busy || !selected || creating}
              onClick={() =>
                perform(async () => {
                  await linkZaloCustomer(call.id, selected, remember);
                  setShowRelink(false);
                  onLinked();
                })
              }
              variant="primary"
              size="xs"
            >
              Xác nhận liên kết
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                setCreating(!creating);
                setSelected('');
              }}
            >
              Tạo khách mới
            </Button>
          </div>

          {creating && (
            <form
              className="flex gap-2 pt-2 border-t border-[var(--border-subtle)]"
              onSubmit={(e) => {
                e.preventDefault();
                perform(async () => {
                  await linkZaloCustomer(call.id, null, remember, newName);
                  setShowRelink(false);
                  onLinked();
                });
              }}
            >
              <input
                aria-label="Tên khách hàng mới"
                required
                maxLength={200}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Tên khách hàng mới..."
                className="min-w-0 flex-1 h-8 px-2.5 text-xs bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
              <Button
                type="submit"
                variant="primary"
                size="xs"
                disabled={busy || !newName.trim()}
              >
                Tạo &amp; liên kết
              </Button>
            </form>
          )}
        </div>
      )}

      {/* SECTION 1: AI SUMMARY (Placed BEFORE raw transcript per instructions) */}
      <div className="pt-2 border-t border-[var(--border-subtle)] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Tóm tắt AI (Summary)
            </span>
            <Badge
              variant={
                summaryStatus === 'COMPLETED'
                  ? 'success'
                  : summaryStatus === 'FAILED'
                  ? 'danger'
                  : summaryStatus === 'NOT_STARTED'
                  ? 'neutral'
                  : 'warning'
              }
              size="xs"
            >
              {summaryStatus === 'COMPLETED'
                ? 'Đã tóm tắt'
                : summaryStatus === 'FAILED'
                ? 'Thất bại'
                : summaryStatus === 'NOT_STARTED'
                ? 'Chưa tóm tắt'
                : 'Đang xử lý'}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            {summaryStatus === 'COMPLETED' && (
              <Button
                variant="ghost"
                size="xs"
                disabled={loadingSummary}
                onClick={toggleSummary}
                rightIcon={
                  expandedSummary ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )
                }
              >
                {loadingSummary
                  ? 'Đang tải…'
                  : expandedSummary
                  ? 'Thu gọn'
                  : 'Xem tóm tắt'}
              </Button>
            )}
            {summaryStatus === 'FAILED' && (
              <Button
                variant="outline"
                size="xs"
                disabled={busy || retrySummaryBusy}
                onClick={handleRetrySummary}
                isLoading={retrySummaryBusy}
                leftIcon={<RotateCcw className="w-3 h-3" />}
              >
                Thử lại
              </Button>
            )}
          </div>
        </div>

        {expandedSummary && summary && summary.status === 'COMPLETED' && (
          <div className="p-3.5 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-3 text-xs">
            {summary.lead_temperature && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-secondary)]">Độ nóng lead:</span>
                <Badge
                  variant={
                    summary.lead_temperature === 'HOT'
                      ? 'danger'
                      : summary.lead_temperature === 'WARM'
                      ? 'warning'
                      : 'neutral'
                  }
                  size="xs"
                >
                  {summary.lead_temperature}
                </Badge>
              </div>
            )}

            {summary.summary && (
              <p className="text-[var(--text-primary)] leading-relaxed">
                {summary.summary}
              </p>
            )}

            {summary.key_points && Array.isArray(summary.key_points) && summary.key_points.length > 0 && (
              <div>
                <span className="font-semibold text-[var(--text-primary)] block mb-1">
                  Điểm mấu chốt:
                </span>
                <ul className="list-disc list-inside space-y-1 text-[var(--text-secondary)]">
                  {summary.key_points.map((pt: unknown, i: number) => (
                    <li key={i}>{typeof pt === 'string' ? pt : JSON.stringify(pt)}</li>
                  ))}
                </ul>
              </div>
            )}

            {summary.next_actions && Array.isArray(summary.next_actions) && summary.next_actions.length > 0 && (
              <div className="p-2.5 rounded bg-blue-50/50 border border-blue-200">
                <span className="font-semibold text-blue-900 block mb-1">
                  Hành động tiếp theo:
                </span>
                <ul className="list-disc list-inside space-y-1 text-blue-800">
                  {summary.next_actions.map((item: unknown, i: number) => (
                    <li key={i}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* SECTION 2: TRANSCRIPT (Collapsed by default, opens with toggle) */}
      <div className="pt-2 border-t border-[var(--border-subtle)] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Bóc băng (Transcript)
            </span>
            <Badge
              variant={
                transcriptStatus === 'COMPLETED'
                  ? 'success'
                  : transcriptStatus === 'FAILED'
                  ? 'danger'
                  : 'warning'
              }
              size="xs"
            >
              {transcriptStatus === 'COMPLETED'
                ? 'Đã hoàn thành'
                : transcriptStatus === 'FAILED'
                ? 'Thất bại'
                : 'Đang xử lý'}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            {transcriptStatus === 'COMPLETED' && (
              <Button
                variant="ghost"
                size="xs"
                disabled={loadingTranscript}
                onClick={toggleTranscript}
                rightIcon={
                  expanded ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )
                }
              >
                {loadingTranscript
                  ? 'Đang tải…'
                  : expanded
                  ? 'Ẩn nội dung'
                  : 'Xem nội dung'}
              </Button>
            )}
            {transcriptStatus === 'FAILED' && (
              <Button
                variant="outline"
                size="xs"
                disabled={busy || retryBusy}
                onClick={handleRetryTranscription}
                isLoading={retryBusy}
                leftIcon={<RotateCcw className="w-3 h-3" />}
              >
                Thử lại
              </Button>
            )}
          </div>
        </div>

        {expanded && transcript && (
          <div className="p-3.5 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] max-h-80 overflow-y-auto space-y-2.5 text-xs">
            {transcript.utterances.length === 0 ? (
              <p className="text-[var(--text-tertiary)] italic">
                Không phát hiện giọng nói trong bản ghi.
              </p>
            ) : (
              transcript.utterances.map((u) => (
                <div key={u.id || u.sequence} className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
                      {formatTranscriptTime(u.start_ms)}
                    </span>
                    <span
                      className={`font-semibold text-[11px] ${
                        u.speaker_role === 'STAFF'
                          ? 'text-[var(--accent)]'
                          : 'text-emerald-600'
                      }`}
                    >
                      {u.speaker_role === 'STAFF' ? 'Chuyên viên' : 'Khách hàng'}
                    </span>
                  </div>
                  <p className="pl-3 border-l-2 border-[var(--border-subtle)] text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                    {u.text}
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function ZaloRecordingHistory({
  customerId,
}: {
  customerId?: string;
}) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    let active = true;
    listZaloCalls(1, customerId)
      .then((res) => {
        if (active) setCalls(res.items);
      })
      .catch(() => {
        if (active) setError('Không tải được danh sách ghi âm Zalo.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [customerId, refreshIndex]);

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-cyan-600" />
            <span>Ghi âm &amp; Hội thoại Zalo Personal</span>
          </CardTitle>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Các cuộc gọi Zalo được Agent ghi âm và bóc băng tự động bằng AI.
          </p>
        </div>

        <Button
          variant="outline"
          size="xs"
          onClick={() => setRefreshIndex((i) => i + 1)}
          leftIcon={<RotateCcw className="w-3 h-3" />}
        >
          Làm mới
        </Button>
      </div>

      {loading ? (
        <div className="py-8 space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-20 bg-[var(--surface-secondary)] rounded-lg animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
          {error}
        </div>
      ) : calls.length === 0 ? (
        <div className="py-8 text-center text-xs text-[var(--text-tertiary)] italic">
          Chưa có cuộc gọi Zalo nào được ghi nhận.
        </div>
      ) : (
        <div className="space-y-3">
          {calls.map((call) => (
            <CallCard
              key={call.id}
              call={call}
              onLinked={() => setRefreshIndex((i) => i + 1)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
