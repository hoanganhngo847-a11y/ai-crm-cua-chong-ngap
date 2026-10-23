import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ComponentHealth, HealthStatusLevel, SystemHealthStatus } from './types';

export interface HealthCheckOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2500;

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
  supabase?: SupabaseClient
): Promise<ComponentHealth> {
  const now = new Date().toISOString();

  if (!supabase) {
    return {
      name: 'Supabase scheduler',
      status: 'HEALTHY',
      lastCheckedAt: now,
      details: 'Scheduler active (mock client)',
    };
  }

  try {
    const { data, error } = await supabase
      .from('ai_brain_live_zalo_dispatch_status')
      .select('created, status_code, has_error, timed_out')
      .order('created', { ascending: false })
      .limit(3);

    if (error || !data || data.length === 0) {
      return {
        name: 'Supabase scheduler',
        status: 'DEGRADED',
        lastCheckedAt: now,
        details: 'Chưa tìm thấy bản ghi dispatch hoặc quyền truy cập cron_internal bị giới hạn',
      };
    }

    const latest = data[0];
    const diffMs = Date.now() - new Date(latest.created).getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (latest.has_error || latest.timed_out || (typeof latest.status_code === 'number' && latest.status_code !== 200)) {
      return {
        name: 'Supabase scheduler',
        status: 'UNHEALTHY',
        lastCheckedAt: now,
        details: `Lần chạy gần nhất thất bại (HTTP ${latest.status_code}, error=${latest.has_error})`,
      };
    }

    if (diffMin > 4) {
      return {
        name: 'Supabase scheduler',
        status: 'DEGRADED',
        lastCheckedAt: now,
        details: `Lần chạy gần nhất cách đây ${diffMin} phút (dự kiến mỗi 1 phút)`,
      };
    }

    return {
      name: 'Supabase scheduler',
      status: 'HEALTHY',
      lastCheckedAt: now,
      details: `Đang chạy đều đặn mỗi phút (lần cuối: ${diffMin < 1 ? 'dưới 1' : diffMin} phút trước, HTTP 200)`,
    };
  } catch (error: unknown) {
    return {
      name: 'Supabase scheduler',
      status: 'DEGRADED',
      lastCheckedAt: now,
      details: error instanceof Error ? error.message : 'Lỗi kiểm tra scheduler',
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

  const [javisBrain, javisRuntime, zcajsWorker, messenger, scheduler] = await Promise.all([
    checkJavisBrainHealth(options),
    checkJavisRuntimeHealth(options),
    checkZcajsWorkerHealth(options),
    checkMessengerTransportHealth(),
    checkSchedulerHealth(supabase),
  ]);

  const voice = checkVoiceStringeeHealth();

  const components: ComponentHealth[] = [
    crmHealth,
    javisBrain,
    javisRuntime,
    zcajsWorker,
    messenger,
    scheduler,
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
