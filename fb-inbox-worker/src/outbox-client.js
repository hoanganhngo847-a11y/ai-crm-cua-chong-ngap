import http from 'http';
import https from 'https';
import { CONFIG } from './config.js';
import { log } from './logger.js';

async function postJson(urlStr, data, headers = {}) {
  try {
    const res = await fetch(urlStr, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': CONFIG.FB_WORKER_SECRET,
        ...headers,
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    });

    const json = await res.json().catch(() => ({}));
    return { statusCode: res.status, body: json };
  } catch (err) {
    throw err;
  }
}

function getBaseApiUrl() {
  const syncEndpoint = CONFIG.CRM_SYNC_ENDPOINT || 'http://localhost:3000/api/inbox/browser-sync';
  const url = new URL(syncEndpoint);
  return `${url.protocol}//${url.host}`;
}

export async function claimOutboxJobs(workerId = 'fb_playwright_worker', limit = 5, companyId) {
  try {
    const baseUrl = getBaseApiUrl();
    const endpoint = `${baseUrl}/api/inbox/outbox/claim`;
    const res = await postJson(endpoint, {
      worker_id: workerId,
      limit,
      company_id: companyId || CONFIG.CRM_COMPANY_ID,
    });

    if (res.statusCode === 200 && res.body?.success) {
      return res.body.jobs || [];
    }
    return [];
  } catch (error) {
    log.warn(`Không thể kết nối lấy outbox jobs từ CRM: ${error.message}`);
    return [];
  }
}

export async function completeOutboxJob(jobId, providerMessageId) {
  try {
    const baseUrl = getBaseApiUrl();
    const endpoint = `${baseUrl}/api/inbox/outbox/complete`;
    const res = await postJson(endpoint, {
      job_id: jobId,
      provider_message_id: providerMessageId,
    });

    return res.statusCode === 200 && res.body?.success;
  } catch (error) {
    log.warn(`Lỗi gọi complete outbox job ${jobId}: ${error.message}`);
    return false;
  }
}

export async function failOutboxJob(jobId, errorMessage, isTransient = true, maxRetries = 3) {
  try {
    const baseUrl = getBaseApiUrl();
    const endpoint = `${baseUrl}/api/inbox/outbox/fail`;
    const res = await postJson(endpoint, {
      job_id: jobId,
      error: errorMessage,
      is_transient: isTransient,
      max_retries: maxRetries,
    });

    return res.statusCode === 200 && res.body?.success;
  } catch (error) {
    log.warn(`Lỗi gọi fail outbox job ${jobId}: ${error.message}`);
    return false;
  }
}

export async function claimOrphanJobs(workerId = 'fb_playwright_worker', limit = 5, companyId) {
  try {
    const baseUrl = getBaseApiUrl();
    const endpoint = `${baseUrl}/api/inbox/outbox/reconcile-stale`;
    const res = await postJson(endpoint, {
      worker_id: workerId,
      limit,
      company_id: companyId || CONFIG.CRM_COMPANY_ID,
    });

    if (res.statusCode === 200 && res.body?.success) {
      return res.body.jobs || [];
    }
    return [];
  } catch (error) {
    log.warn(`Không thể lấy orphan outbox jobs từ CRM: ${error.message}`);
    return [];
  }
}

export async function resolveReconciledJob(jobId, resolution, providerMessageId, error) {
  try {
    const baseUrl = getBaseApiUrl();
    const endpoint = `${baseUrl}/api/inbox/outbox/resolve-reconciled`;
    const res = await postJson(endpoint, {
      job_id: jobId,
      resolution,
      provider_message_id: providerMessageId,
      error,
    });

    return res.statusCode === 200 && res.body?.success;
  } catch (err) {
    log.warn(`Lỗi khi cập nhật kết quả đối soát job ${jobId}: ${err.message}`);
    return false;
  }
}

