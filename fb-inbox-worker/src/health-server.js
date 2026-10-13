import http from 'http';
import { log } from './logger.js';
import { setupGateway } from './gateway.js';

class HealthServer {
  constructor() {
    this.startTime = Date.now();
    this.server = null;
    this.state = {
      worker_running: true,
      browser_connected: false,
      meta_inbox_state: 'STARTING', // 'READY' | 'LOGIN_REQUIRED' | 'CHECKPOINT' | 'DEGRADED' | 'STARTING' | 'NAVIGATING'
      status: 'STARTING', // 'HEALTHY' | 'DEGRADED' | 'LOGIN_REQUIRED' | 'STARTING'
      last_main_loop_at: null,
      last_outbox_poll_attempt_at: null,
      last_outbox_poll_success_at: null,
      last_outbox_poll_error_at: null,
      last_outbox_poll_error_code: null,
      outbox_loop_healthy: false,
      last_successful_inbox_scan: null,
      last_successful_outbox_delivery: null,
      pending_outbox_count: 0,
      total_inbound_synced: 0,
      total_outbound_delivered: 0,
      error_message: null,
    };
  }

  setBrowserPage(page) {
    setupGateway.setBrowserPage(page);
  }

  updateState(patch = {}) {
    Object.assign(this.state, patch);

    // Derive overall status
    if (this.state.meta_inbox_state === 'LOGIN_REQUIRED' || this.state.meta_inbox_state === 'CHECKPOINT') {
      this.state.status = 'LOGIN_REQUIRED';
    } else if (this.state.meta_inbox_state === 'DEGRADED' || this.state.meta_inbox_state === 'DEGRADED_OUTBOX_LOOP' || !this.state.browser_connected) {
      this.state.status = 'DEGRADED';
    } else if (this.state.meta_inbox_state === 'READY' || this.state.meta_inbox_state === 'INBOX_READY') {
      this.state.status = 'HEALTHY';
    } else if (this.state.meta_inbox_state === 'NAVIGATING' || this.state.meta_inbox_state === 'STARTING') {
      this.state.status = 'STARTING';
    }
  }

  recordMainLoopHeartbeat() {
    this.state.last_main_loop_at = new Date().toISOString();
  }

  recordOutboxPollAttempt() {
    this.state.last_outbox_poll_attempt_at = new Date().toISOString();
  }

  recordOutboxPollSuccess(count = 0) {
    this.state.last_outbox_poll_success_at = new Date().toISOString();
    this.state.last_outbox_poll_error_code = null;
    this.state.outbox_loop_healthy = true;
    this.state.pending_outbox_count = typeof count === 'number' ? count : 0;
  }

  /**
   * @param {string} [errorCode]
   * @param {string|null} [message]
   */
  recordOutboxPollError(errorCode = 'CLAIM_ERROR', message = null) {
    this.state.last_outbox_poll_error_at = new Date().toISOString();
    this.state.last_outbox_poll_error_code = errorCode;
    this.state.outbox_loop_healthy = false;
    if (message) {
      this.state.error_message = message;
    }
  }

  recordScanSuccess() {
    this.state.last_successful_inbox_scan = new Date().toISOString();
    this.state.browser_connected = true;
    this.state.total_inbound_synced += 1;
  }

  recordDeliverySuccess() {
    this.state.last_successful_outbox_delivery = new Date().toISOString();
    this.state.browser_connected = true;
    this.state.total_outbound_delivered += 1;
  }

  setPendingOutboxCount(count) {
    this.state.pending_outbox_count = typeof count === 'number' ? count : 0;
  }

  checkOutboxHealth(now = Date.now()) {
    const STALE_THRESHOLD_MS = 45000;

    const successFresh = Boolean(
      this.state.last_outbox_poll_success_at &&
      (now - new Date(this.state.last_outbox_poll_success_at).getTime() < STALE_THRESHOLD_MS)
    );

    const hasActiveErrorCode = Boolean(this.state.last_outbox_poll_error_code);

    let isErrorNewerThanSuccess = false;
    if (this.state.last_outbox_poll_error_at) {
      if (!this.state.last_outbox_poll_success_at) {
        isErrorNewerThanSuccess = true;
      } else {
        const errTime = new Date(this.state.last_outbox_poll_error_at).getTime();
        const succTime = new Date(this.state.last_outbox_poll_success_at).getTime();
        isErrorNewerThanSuccess = errTime > succTime;
      }
    }

    const latestClaimOutcomeIsHealthy = !hasActiveErrorCode && !isErrorNewerThanSuccess;
    const isOutboxHealthy = successFresh && latestClaimOutcomeIsHealthy;

    return {
      successFresh,
      latestClaimOutcomeIsHealthy,
      isOutboxHealthy,
    };
  }

  getSnapshot() {
    const mem = process.memoryUsage();
    const now = Date.now();
    const { successFresh, latestClaimOutcomeIsHealthy, isOutboxHealthy } = this.checkOutboxHealth(now);
    this.state.outbox_loop_healthy = isOutboxHealthy;

    return {
      status: this.state.status,
      worker_running: this.state.worker_running,
      browser_connected: this.state.browser_connected,
      meta_inbox_state: this.state.meta_inbox_state,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      pid: process.pid,
      memory: {
        rss_mb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heap_used_mb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      },
      last_main_loop_at: this.state.last_main_loop_at,
      last_outbox_poll_attempt_at: this.state.last_outbox_poll_attempt_at,
      last_outbox_poll_success_at: this.state.last_outbox_poll_success_at,
      last_outbox_poll_error_at: this.state.last_outbox_poll_error_at,
      last_outbox_poll_error_code: this.state.last_outbox_poll_error_code,
      outbox_loop_healthy: isOutboxHealthy,
      last_successful_inbox_scan: this.state.last_successful_inbox_scan,
      last_successful_outbox_delivery: this.state.last_successful_outbox_delivery,
      pending_outbox_count: this.state.pending_outbox_count,
      total_inbound_synced: this.state.total_inbound_synced,
      total_outbound_delivered: this.state.total_outbound_delivered,
      error_message: this.state.error_message,
      timestamp: new Date().toISOString(),
    };
  }

  start(port = 3099, host = '0.0.0.0') {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = urlObj.pathname;

        // Requirement 1 & 7: Separate Liveness (/health) and Readiness (/ready)
        // Liveness check: Always 200 if Node worker process is alive, regardless of Facebook state
        if (pathname === '/health' || pathname === '/') {
          const snapshot = this.getSnapshot();
          const isAlive = Boolean(this.state.worker_running);
          const statusCode = isAlive ? 200 : 503;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(snapshot, null, 2));
          return;
        }

        // Readiness check: 200 ONLY if Meta Inbox is READY/INBOX_READY AND outbox heartbeat is fresh & healthy
        if (pathname === '/ready') {
          const isMetaReady = this.state.meta_inbox_state === 'READY' || this.state.meta_inbox_state === 'INBOX_READY';
          const now = Date.now();
          const STALE_THRESHOLD_MS = 45000;

          const mainLoopFresh = Boolean(
            this.state.last_main_loop_at &&
            (now - new Date(this.state.last_main_loop_at).getTime() < STALE_THRESHOLD_MS)
          );

          const { successFresh, latestClaimOutcomeIsHealthy, isOutboxHealthy } = this.checkOutboxHealth(now);

          let ready = false;
          let readyState = this.state.meta_inbox_state;

          if (!isMetaReady) {
            ready = false;
            readyState = this.state.meta_inbox_state;
          } else if (!mainLoopFresh || !isOutboxHealthy) {
            ready = false;
            readyState = 'DEGRADED_OUTBOX_LOOP';
          } else {
            ready = true;
            readyState = 'READY';
          }

          const statusCode = ready ? 200 : 503;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ready,
            state: readyState,
            meta_inbox_state: this.state.meta_inbox_state,
            status: ready ? 'HEALTHY' : 'DEGRADED',
            worker_running: this.state.worker_running,
            main_loop_fresh: mainLoopFresh,
            outbox_poll_fresh: successFresh,
            outbox_loop_healthy: isOutboxHealthy,
            last_main_loop_at: this.state.last_main_loop_at,
            last_outbox_poll_attempt_at: this.state.last_outbox_poll_attempt_at,
            last_outbox_poll_success_at: this.state.last_outbox_poll_success_at,
            last_outbox_poll_error_at: this.state.last_outbox_poll_error_at,
            last_outbox_poll_error_code: this.state.last_outbox_poll_error_code
          }));
          return;
        }

        // Requirements 4, 5, 6: Setup Gateway handling
        try {
          const handled = await setupGateway.handleRequest(req, res, this.getSnapshot());
          if (handled) return;
        } catch (err) {
          log.warn(`[NODE GATEWAY] Error handling request: ${err.message}`);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      });

      // Handle WebSocket upgrade through setupGateway (Requirement 4 & 5)
      this.server.on('upgrade', (req, socket, head) => {
        setupGateway.handleUpgrade(req, socket, head);
      });

      this.server.listen(port, host, () => {
        log.info(`[NODE GATEWAY] Node gateway listening at http://${host}:${port} (/health ready)`);
        resolve(this.server);
      });

      this.server.on('error', (err) => {
        log.warn(`[NODE GATEWAY] Lỗi khởi động gateway server trên cổng ${port}: ${err.message}`);
        resolve(null);
      });
    });
  }

  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => resolve());
      });
    }
  }
}

export const healthServer = new HealthServer();
