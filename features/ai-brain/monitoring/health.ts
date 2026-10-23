import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ComponentHealth,
  ComponentName,
  HealthStatusLevel,
  InterpretedSchedulerHealth,
  SchedulerDispatchRun,
  SystemHealthStatus,
} from './types';

export interface HealthCheckOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2500;

export function calculateSchedulerFailureStats(runs: readonly SchedulerDispatchRun[]): {
  consecutiveFailures: number;
  totalFailures: number;
} {
  let consecutiveFailures = 0;
  let totalFailures = 0;
  let streakBroken = false;

  for (const run of runs) {
    const isFailed =
      run.has_error === true ||
      run.timed_out === true ||
      (typeof run.status_code === 'number' && (run.status_code < 200 || run.status_code >= 300));

    if (isFailed) {
      totalFailures++;
      if (!streakBroken) {
        consecutiveFailures++;
      }
    } else {
      // Any non-failure (verified success HTTP 2xx, unknown/pending null, or query error)
      // breaks consecutive failure evidence. [fail, unknown, fail] MUST NOT streak 2.
      streakBroken = true;
    }
  }

  return { consecutiveFailures, totalFailures };
}

export function interpretSchedulerHealth(
  rpcResponseOrData: unknown,
  channel: 'ZALO' | 'MESSENGER' = 'ZALO',
  now: Date = new Date()
): InterpretedSchedulerHealth {
  const normChannel = (channel || 'ZALO').toUpperCase() as 'ZALO' | 'MESSENGER';

  if (!rpcResponseOrData) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: 0,
      totalFailures: 0,
      details: `Chưa có dữ liệu phản hồi scheduler (${normChannel})`,
    };
  }

  // Handle { data, error } envelope
  let errorMsg: string | undefined;
  let rawData: unknown = rpcResponseOrData;

  if (typeof rpcResponseOrData === 'object' && rpcResponseOrData !== null) {
    const envelope = rpcResponseOrData as { data?: unknown; error?: unknown };
    if (envelope.error) {
      const err = envelope.error;
      errorMsg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err);
      return {
        channel: normChannel,
        status: 'DEGRADED',
        availability: 'UNKNOWN',
        consecutiveFailures: 0,
        totalFailures: 0,
        details: `Lỗi RPC scheduler ${normChannel}: ${errorMsg}`,
        error: errorMsg,
      };
    }
    if ('data' in envelope) {
      rawData = envelope.data;
    }
  }

  if (Array.isArray(rawData)) {
    // Legacy array result has no job/view/extension metadata -> NEVER HEALTHY! Unknown metadata remains DEGRADED.
    const runs = rawData as SchedulerDispatchRun[];
    const stats = calculateSchedulerFailureStats(runs);
    const latest = runs[0];
    const isLatestFailed =
      latest &&
      (Boolean(latest.has_error) ||
        Boolean(latest.timed_out) ||
        (typeof latest.status_code === 'number' && (latest.status_code < 200 || latest.status_code >= 300)));

    return {
      channel: normChannel,
      status: stats.consecutiveFailures >= 2 || isLatestFailed ? 'UNHEALTHY' : 'DEGRADED',
      availability: stats.consecutiveFailures >= 2 ? 'UNAVAILABLE' : 'UNKNOWN',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Scheduler ${normChannel} trả về mảng kết quả cũ thiếu metadata job/view/extension (unknown metadata)`,
    };
  }

  if (!rawData || typeof rawData !== 'object') {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: 0,
      totalFailures: 0,
      details: `Dữ liệu phản hồi RPC scheduler ${normChannel} không hợp lệ`,
    };
  }

  const rpcData = rawData as Record<string, unknown>;

  // Channel matching check: reject mismatch if metadata channel is present
  if (typeof rpcData.channel === 'string' && rpcData.channel.trim().toUpperCase() !== normChannel) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: 0,
      totalFailures: 0,
      details: `Metadata channel không khớp với kênh được yêu cầu (nhận: ${String(rpcData.channel)}, yêu cầu: ${normChannel})`,
    };
  }

  // 1. Guard against known missing or inactive pg_cron job -> UNHEALTHY
  if (rpcData.job_exists === false) {
    return {
      channel: normChannel,
      status: 'UNHEALTHY',
      availability: 'UNAVAILABLE',
      consecutiveFailures: 0,
      totalFailures: 0,
      details: `Cron job chưa được đăng ký trong pg_cron (${String(rpcData.job_name || normChannel)})`,
    };
  }

  if (rpcData.job_active === false) {
    return {
      channel: normChannel,
      status: 'UNHEALTHY',
      availability: 'UNAVAILABLE',
      consecutiveFailures: 0,
      totalFailures: 0,
      details: `Cron job đang bị vô hiệu hóa (${String(rpcData.job_name || normChannel)}, active=false)`,
    };
  }

  // 2. Inspect dispatch runs and failure stats
  const runs = Array.isArray(rpcData.runs) ? (rpcData.runs as SchedulerDispatchRun[]) : [];
  const stats = calculateSchedulerFailureStats(runs);
  const latest = runs.length > 0 ? runs[0] : null;

  // Known run failure -> UNHEALTHY
  if (latest) {
    const isLatestFailed =
      latest.has_error === true ||
      latest.timed_out === true ||
      (typeof latest.status_code === 'number' &&
        Number.isFinite(latest.status_code) &&
        (latest.status_code < 200 || latest.status_code >= 300));

    if (isLatestFailed) {
      return {
        channel: normChannel,
        status: 'UNHEALTHY',
        availability: stats.consecutiveFailures >= 2 ? 'UNAVAILABLE' : 'DEGRADED',
        consecutiveFailures: stats.consecutiveFailures,
        totalFailures: stats.totalFailures,
        details: `Lần chạy gần nhất của ${normChannel} thất bại (HTTP ${latest.status_code}, error=${latest.has_error}, timed_out=${latest.timed_out})`,
      };
    }
  }

  if (stats.consecutiveFailures >= 2) {
    return {
      channel: normChannel,
      status: 'UNHEALTHY',
      availability: 'UNAVAILABLE',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Scheduler ${normChannel} có ${stats.consecutiveFailures} lần thất bại liên tiếp`,
    };
  }

  // 3. Cadence validation -> DEGRADED
  if (rpcData.job_schedule && rpcData.job_schedule !== '* * * * *') {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Chu kỳ cron job không đúng: ${String(rpcData.job_schedule)} (kỳ vọng: * * * * *)`,
    };
  }

  // 4. Missing dispatch evidence -> DEGRADED
  if (!latest) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Chưa tìm thấy bản ghi dispatch cho ${normChannel} (missing dispatch evidence)`,
    };
  }

  // 5. Timestamp validations -> DEGRADED
  if (!latest.created) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Timestamp bản ghi dispatch gần nhất là null (${normChannel})`,
    };
  }

  const createdMs = new Date(latest.created).getTime();
  if (!Number.isFinite(createdMs)) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Timestamp bản ghi dispatch gần nhất không hợp lệ: "${latest.created}" (${normChannel})`,
    };
  }

  const nowMs = now.getTime();
  if (createdMs > nowMs + 60000) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Timestamp bản ghi dispatch ở tương lai: "${latest.created}" (${normChannel})`,
    };
  }

  const diffMs = nowMs - createdMs;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin > 4) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Lần chạy gần nhất của ${normChannel} cách đây ${diffMin} phút (dự kiến mỗi 1 phút)`,
    };
  }

  // 6. HTTP response validations -> pending HTTP null is DEGRADED (never HEALTHY/AVAILABLE)
  if (latest.status_code === null || latest.status_code === undefined) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Lần chạy gần nhất của ${normChannel} đang chờ phản hồi HTTP (status_code is null)`,
    };
  }

  // 6b. Verify positive false for error and timeout flags
  // Unknown flags (null/undefined) must return DEGRADED/UNKNOWN, not a fabricated failed dispatch.
  if (latest.has_error !== false || latest.timed_out !== false) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Cờ trạng thái phản hồi HTTP chưa được xác thực rõ ràng (has_error: ${String(latest.has_error)}, timed_out: ${String(latest.timed_out)}, ${normChannel})`,
    };
  }

  // 7. Positive metadata validations: HEALTHY requires ALL true:
  // extension_available === true, view_available === true, job_exists === true, job_active === true, job_schedule === '* * * * *'
  if (rpcData.extension_available === false) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Extension pg_cron chưa được kích hoạt trên database (${normChannel})`,
    };
  }
  if (rpcData.extension_available !== true) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Trạng thái extension pg_cron không xác định (extension_available !== true, ${normChannel})`,
    };
  }

  if (rpcData.view_available === false) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `View cron.job hoặc net._http_response không khả dụng (${normChannel})`,
    };
  }
  if (rpcData.view_available !== true) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Trạng thái view pg_cron không xác định (view_available !== true, ${normChannel})`,
    };
  }

  if (rpcData.job_exists !== true) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Metadata cron job không xác định (job_exists !== true, ${normChannel})`,
    };
  }

  if (rpcData.job_active !== true) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Metadata cron job không xác định (job_active !== true, ${normChannel})`,
    };
  }

  if (rpcData.job_schedule !== '* * * * *') {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'DEGRADED',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Chu kỳ cron job không đúng: ${String(rpcData.job_schedule)} (kỳ vọng: * * * * *)`,
    };
  }

  if (typeof rpcData.channel !== 'string' || rpcData.channel.trim().toUpperCase() !== normChannel) {
    return {
      channel: normChannel,
      status: 'DEGRADED',
      availability: 'UNKNOWN',
      consecutiveFailures: stats.consecutiveFailures,
      totalFailures: stats.totalFailures,
      details: `Metadata channel không xác định hoặc không khớp (nhận: ${String(rpcData.channel)}, yêu cầu: ${normChannel})`,
    };
  }

  // Positive verified healthy!
  return {
    channel: normChannel,
    status: 'HEALTHY',
    availability: 'AVAILABLE',
    consecutiveFailures: stats.consecutiveFailures,
    totalFailures: stats.totalFailures,
    details: `Scheduler ${normChannel} đang chạy đều đặn (lần cuối: ${diffMin < 1 ? 'dưới 1' : diffMin} phút trước, HTTP ${latest.status_code})`,
  };
}

export async function checkJavisBrainHealth(
  options: HealthCheckOptions = {}
): Promise<ComponentHealth> {
  const now = new Date().toISOString();
  const baseUrl = (process.env.JAVIS_BRAIN_BASE_URL || '').trim();
  const token = (process.env.JAVIS_BRAIN_INTERNAL_TOKEN || '').trim();

  if (!baseUrl || !token) {
    return {
      name: 'Javis Brain',
      status: 'UNCONFIGURED',
      lastCheckedAt: now,
      details: 'JAVIS_BRAIN_BASE_URL hoặc JAVIS_BRAIN_INTERNAL_TOKEN chưa cấu hình',
    };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  try {
    const healthUrl = `${baseUrl.replace(/\/+$/, '')}/health`;
    const response = await fetchFn(healthUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ai-brain-contract': 'v1',
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });

    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      return {
        name: 'Javis Brain',
        status: 'HEALTHY',
        latencyMs,
        lastCheckedAt: now,
        details: 'Phản hồi bình thường (v1)',
      };
    }

    if (response.status === 401) {
      return {
        name: 'Javis Brain',
        status: 'UNHEALTHY',
        latencyMs,
        lastCheckedAt: now,
        details: 'Token xác thực không hợp lệ (401 Unauthorized)',
      };
    }

    return {
      name: 'Javis Brain',
      status: 'DEGRADED',
      latencyMs,
      lastCheckedAt: now,
      details: `Mã phản hồi không mong muốn: ${response.status}`,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    return {
      name: 'Javis Brain',
      status: 'UNHEALTHY',
      latencyMs,
      lastCheckedAt: now,
      details: error instanceof Error ? error.message : 'Không thể kết nối tới Javis Brain',
    };
  }
}

export async function checkJavisRuntimeHealth(
  options: HealthCheckOptions = {}
): Promise<ComponentHealth> {
  const now = new Date().toISOString();
  const runtimeUrl = (process.env.JAVIS_RUNTIME_URL || '').trim();

  if (!runtimeUrl) {
    return {
      name: 'Javis Runtime',
      status: 'UNCONFIGURED',
      lastCheckedAt: now,
      details: 'Chưa cấu hình JAVIS_RUNTIME_URL (sử dụng in-process model router)',
    };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  try {
    const response = await fetchFn(runtimeUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    const latencyMs = Date.now() - startTime;

    return {
      name: 'Javis Runtime',
      status: response.ok || response.status === 401 || response.status === 404 ? 'HEALTHY' : 'DEGRADED',
      latencyMs,
      lastCheckedAt: now,
      details: `Kết nối thành công (${response.status})`,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    return {
      name: 'Javis Runtime',
      status: 'UNHEALTHY',
      latencyMs,
      lastCheckedAt: now,
      details: error instanceof Error ? error.message : 'Không thể kết nối tới Javis Runtime',
    };
  }
}

export async function checkZcajsWorkerHealth(
  options: HealthCheckOptions = {}
): Promise<ComponentHealth> {
  const now = new Date().toISOString();
  const workerUrl = (process.env.ZALO_ZCAJS_WORKER_URL || '').trim();
  const workerSecret = (process.env.ZALO_ZCAJS_WORKER_SECRET || '').trim();

  if (!workerUrl) {
    return {
      name: 'ZCAJS Worker',
      status: 'UNCONFIGURED',
      lastCheckedAt: now,
      details: 'Chưa cấu hình ZALO_ZCAJS_WORKER_URL (kênh Zalo dùng Zalo OA chính thức)',
    };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  try {
    const healthUrl = `${workerUrl.replace(/\/+$/, '')}/health`;
    const response = await fetchFn(healthUrl, {
      method: 'GET',
      headers: workerSecret ? { Authorization: `Bearer ${workerSecret}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    const latencyMs = Date.now() - startTime;

    if (response.ok || response.status === 200 || response.status === 404) {
      return {
        name: 'ZCAJS Worker',
        status: 'HEALTHY',
        latencyMs,
        lastCheckedAt: now,
        details: 'Worker đang hoạt động',
      };
    }

    return {
      name: 'ZCAJS Worker',
      status: 'DEGRADED',
      latencyMs,
      lastCheckedAt: now,
      details: `Mã phản hồi bất thường: ${response.status}`,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    return {
      name: 'ZCAJS Worker',
      status: 'UNHEALTHY',
      latencyMs,
      lastCheckedAt: now,
      details: error instanceof Error ? error.message : 'Không thể kết nối tới ZCAJS Worker',
    };
  }
}

export async function checkMessengerTransportHealth(): Promise<ComponentHealth> {
  const now = new Date().toISOString();
  const rawBindings = process.env.META_PAGE_BINDINGS;
  const fallbackToken = process.env.META_PAGE_ACCESS_TOKEN;

  if (!rawBindings && !fallbackToken) {
    return {
      name: 'Messenger Transport',
      status: 'UNCONFIGURED',
      lastCheckedAt: now,
      details: 'Chưa cấu hình META_PAGE_BINDINGS hoặc META_PAGE_ACCESS_TOKEN',
    };
  }

  if (rawBindings) {
    try {
      const parsed = JSON.parse(rawBindings);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          name: 'Messenger Transport',
          status: 'HEALTHY',
          lastCheckedAt: now,
          details: `Đã cấu hình ${parsed.length} Facebook Page bindings`,
        };
      }
      return {
        name: 'Messenger Transport',
        status: 'DEGRADED',
        lastCheckedAt: now,
        details: 'META_PAGE_BINDINGS không chứa danh sách trang hợp lệ',
      };
    } catch {
      return {
        name: 'Messenger Transport',
        status: 'DEGRADED',
        lastCheckedAt: now,
        details: 'Lỗi parse JSON trong META_PAGE_BINDINGS',
      };
    }
  }

  return {
    name: 'Messenger Transport',
    status: 'HEALTHY',
    lastCheckedAt: now,
    details: 'Đã cấu hình single-page fallback token',
  };
}

export async function checkSchedulerHealth(
  supabase?: SupabaseClient,
  channel: 'ZALO' | 'MESSENGER' = 'ZALO'
): Promise<ComponentHealth> {
  const now = new Date();
  const normChannel = (channel || 'ZALO').toUpperCase() as 'ZALO' | 'MESSENGER';
  const componentName: ComponentName =
    normChannel === 'MESSENGER'
      ? 'Supabase Scheduler (Messenger)'
      : 'Supabase Scheduler (Zalo)';

  if (!supabase) {
    return {
      name: componentName,
      status: 'DEGRADED',
      lastCheckedAt: now.toISOString(),
      details: `Chưa cấu hình Supabase client (${normChannel})`,
    };
  }

  if (typeof supabase.rpc !== 'function') {
    return {
      name: componentName,
      status: 'DEGRADED',
      lastCheckedAt: now.toISOString(),
      details: `Supabase client không hỗ trợ hàm rpc (${normChannel})`,
    };
  }

  try {
    const rpcRes = await supabase.rpc('get_ai_channel_scheduler_health', {
      p_channel: normChannel,
      p_limit: 10,
    });

    const interpreted = interpretSchedulerHealth(rpcRes, normChannel, now);
    return {
      name: componentName,
      status: interpreted.status,
      lastCheckedAt: now.toISOString(),
      details: interpreted.details,
    };
  } catch (error: unknown) {
    return {
      name: componentName,
      status: 'DEGRADED',
      lastCheckedAt: now.toISOString(),
      details: error instanceof Error ? error.message : `Lỗi kiểm tra scheduler ${normChannel}`,
    };
  }
}

export function checkVoiceStringeeHealth(): ComponentHealth {
  const now = new Date().toISOString();
  const apiKey = (process.env.STRINGEE_API_KEY || process.env.STRINGEE_API_SID || '').trim();
  const apiSecret = (process.env.STRINGEE_API_SECRET || process.env.STRINGEE_SIGNING_SECRET || '').trim();
  const fromNumber = (process.env.STRINGEE_FROM_NUMBER || '').trim();

  if (!apiKey || !apiSecret) {
    return {
      name: 'Voice/Stringee',
      status: 'UNCONFIGURED',
      lastCheckedAt: now,
      details: 'Chưa cấu hình Stringee API credentials',
    };
  }

  return {
    name: 'Voice/Stringee',
    status: 'HEALTHY',
    lastCheckedAt: now,
    details: fromNumber ? `Cấu hình hotline: ${fromNumber}` : 'Cấu hình API hoàn chỉnh (chưa gán hotline)',
  };
}

export async function getSystemHealthStatus(
  supabase?: SupabaseClient,
  options: HealthCheckOptions = {}
): Promise<SystemHealthStatus> {
  const now = new Date().toISOString();

  const crmHealth: ComponentHealth = {
    name: 'CRM',
    status: 'HEALTHY',
    latencyMs: 1,
    lastCheckedAt: now,
    details: 'Dịch vụ chính đang vận hành bình thường',
  };

  const [javisBrain, javisRuntime, zcajsWorker, messenger, zaloScheduler, messengerScheduler] =
    await Promise.all([
      checkJavisBrainHealth(options),
      checkJavisRuntimeHealth(options),
      checkZcajsWorkerHealth(options),
      checkMessengerTransportHealth(),
      checkSchedulerHealth(supabase, 'ZALO'),
      checkSchedulerHealth(supabase, 'MESSENGER'),
    ]);

  const voice = checkVoiceStringeeHealth();

  // Legacy aggregated 'Supabase scheduler' component
  const legacyScheduler: ComponentHealth = {
    name: 'Supabase scheduler',
    status:
      zaloScheduler.status === 'UNHEALTHY' || messengerScheduler.status === 'UNHEALTHY'
        ? 'UNHEALTHY'
        : zaloScheduler.status === 'DEGRADED' || messengerScheduler.status === 'DEGRADED'
          ? 'DEGRADED'
          : zaloScheduler.status === 'HEALTHY' && messengerScheduler.status === 'HEALTHY'
            ? 'HEALTHY'
            : 'DEGRADED',
    lastCheckedAt: now,
    details: `Zalo: ${zaloScheduler.status}; Messenger: ${messengerScheduler.status}`,
  };

  const components: ComponentHealth[] = [
    crmHealth,
    javisBrain,
    javisRuntime,
    zcajsWorker,
    messenger,
    zaloScheduler,
    messengerScheduler,
    legacyScheduler,
    voice,
  ];

  let overall: HealthStatusLevel = 'HEALTHY';
  if (components.some((c) => c.status === 'UNHEALTHY')) {
    overall = 'UNHEALTHY';
  } else if (components.some((c) => c.status === 'DEGRADED')) {
    overall = 'DEGRADED';
  }

  return {
    overall,
    components,
    checkedAt: now,
  };
}
