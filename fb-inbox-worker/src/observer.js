import { log } from './logger.js';

/**
 * Event-Driven DOM Observer & Cycle Waker for Meta Business Suite Inbox
 * 
 * Implements:
 * 1. CycleWaker with LATCHED / PENDING-SIGNAL semantics to eliminate lost-wake race conditions.
 * 2. Scoped MutationObserver targeting message threads and conversation lists.
 * 3. Mutation filtering (ignoring scripts, styles, SVGs, and input keystrokes).
 * 4. Trailing debounce (~100-150ms) with maxWait (~300-500ms) to prevent infinite timer resets.
 * 5. Strictly zero message parsing inside MutationObserver.
 */

export class CycleWaker {
  constructor() {
    this._pendingSignal = null;
    this._waiterResolve = null;
    this._waiterTimer = null;
  }

  /**
   * Wakes the waiting worker immediately or latches the signal for the next waitForNextCycle() call.
   */
  wake(signalData = {}) {
    const now = Date.now();
    const incomingSignalAt = signalData.domSignalAt || now;

    const signal = {
      type: 'SIGNAL',
      ...signalData,
      domSignalAt: incomingSignalAt
    };

    // If a worker loop is actively waiting in waitForNextCycle(), wake it immediately
    if (this._waiterResolve) {
      const resolve = this._waiterResolve;
      this._waiterResolve = null;
      if (this._waiterTimer) {
        clearTimeout(this._waiterTimer);
        this._waiterTimer = null;
      }
      resolve(signal);
      return;
    }

    // Otherwise, latch the signal into _pendingSignal with coalescing (wake-before-wait safety)
    if (this._pendingSignal) {
      const earliestDomSignalAt = Math.min(
        this._pendingSignal.domSignalAt || Infinity,
        incomingSignalAt
      );
      this._pendingSignal = {
        ...this._pendingSignal,
        ...signal,
        domSignalAt: earliestDomSignalAt === Infinity ? now : earliestDomSignalAt,
        coalescedCount: (this._pendingSignal.coalescedCount || 1) + 1
      };
    } else {
      this._pendingSignal = {
        ...signal,
        coalescedCount: 1
      };
    }
  }

  /**
   * Waits for either a DOM mutation signal OR a fallback timeout (default 5000ms).
   * If a signal was already latched before this call, returns IMMEDIATELY without waiting.
   */
  async waitForNextCycle(timeoutMs = 5000) {
    // 1. Consume latched pending signal immediately if present
    if (this._pendingSignal) {
      const signal = this._pendingSignal;
      this._pendingSignal = null;
      return signal;
    }

    // 2. Wait for incoming wake or timeout
    return new Promise((resolve) => {
      this._waiterTimer = setTimeout(() => {
        this._waiterResolve = null;
        this._waiterTimer = null;
        resolve({ type: 'TIMEOUT' });
      }, timeoutMs);

      this._waiterResolve = resolve;
    });
  }

  hasPendingSignal() {
    return this._pendingSignal !== null;
  }

  clear() {
    this._pendingSignal = null;
    if (this._waiterTimer) {
      clearTimeout(this._waiterTimer);
      this._waiterTimer = null;
    }
    this._waiterResolve = null;
  }
}

/**
 * Injects the hardened MutationObserver into the page DOM.
 */
export async function installMetaInboxDomObserver(page, options = {}) {
  const debounceMs = typeof options === 'number' ? options : (options?.debounceMs ?? 150);
  const maxWaitMs = options?.maxWaitMs ?? 350;

  try {
    return await page.evaluate(
      `(([debounceDuration, maxWaitDuration]) => {
        if (window.__metaInboxObserverInstalled && window.__metaInboxObserverInstance) {
          return { alreadyInstalled: true };
        }

        let debounceTimer = null;
        let maxWaitTimer = null;
        let firstMutationAt = null;
        let earliestSignalAt = null;
        let pendingCount = 0;

        function emitSignal() {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          if (maxWaitTimer) {
            clearTimeout(maxWaitTimer);
            maxWaitTimer = null;
          }

          const domSignalAt = earliestSignalAt || Date.now();
          const count = pendingCount;

          firstMutationAt = null;
          earliestSignalAt = null;
          pendingCount = 0;

          if (typeof window.__onMetaInboxDomMutation === 'function') {
            window.__onMetaInboxDomMutation({
              domSignalAt: domSignalAt,
              mutationsCount: count
            }).catch(function() {});
          }
        }

        function isRelevantElement(el) {
          if (!el || !el.tagName) return false;
          const tag = el.tagName.toLowerCase();

          if (
            tag === 'script' ||
            tag === 'style' ||
            tag === 'noscript' ||
            tag === 'svg' ||
            tag === 'path' ||
            tag === 'link' ||
            tag === 'meta'
          ) {
            return false;
          }

          if (tag === 'input' || tag === 'textarea') {
            return false;
          }

          const relevantSelector = [
            '[data-surface*="thread_list"]',
            '[data-surface*="thread_row"]',
            '[data-surface*="message"]',
            '[data-surface*="detail_view"]',
            '[data-surface*="snippet"]',
            '[data-surface*="thread_title"]',
            '[data-surface*="unread"]',
            '[role="main"]',
            '[role="row"]',
            '[role="grid"]',
            '[aria-label*="Message list"]',
            '[aria-label*="Message"]',
            '[aria-label*="Tin nhắn"]',
            '[aria-label*="cuộc trò chuyện"]',
            '[aria-label*="Conversation"]',
            '[aria-label*="chưa đọc"]',
            '[aria-label*="unread"]',
            'div[dir="auto"]',
            'span[dir="auto"]'
          ].join(', ');

          try {
            return Boolean(el.closest(relevantSelector));
          } catch (_) {
            return false;
          }
        }

        function isRelevantMutation(m) {
          if (m.addedNodes && m.addedNodes.length > 0) {
            for (let i = 0; i < m.addedNodes.length; i++) {
              const node = m.addedNodes[i];
              if (node.nodeType === 1 && isRelevantElement(node)) {
                return true;
              }
              if (node.nodeType === 3 && node.parentElement && isRelevantElement(node.parentElement)) {
                return true;
              }
            }
          }

          const target = m.target;
          if (target) {
            if (target.nodeType === 1) {
              return isRelevantElement(target);
            }
            if (target.nodeType === 3 && target.parentElement) {
              return isRelevantElement(target.parentElement);
            }
          }

          return false;
        }

        const observer = new MutationObserver(function(mutations) {
          let relevantBatchCount = 0;

          for (let i = 0; i < mutations.length; i++) {
            if (isRelevantMutation(mutations[i])) {
              relevantBatchCount++;
            }
          }

          if (relevantBatchCount === 0) return;

          const now = Date.now();
          pendingCount += relevantBatchCount;

          if (!firstMutationAt) {
            firstMutationAt = now;
            earliestSignalAt = now;
            maxWaitTimer = setTimeout(emitSignal, maxWaitDuration);
          }

          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          debounceTimer = setTimeout(emitSignal, debounceDuration);
        });

        if (document.body) {
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['aria-label', 'class', 'data-surface', 'aria-selected']
          });

          window.__metaInboxObserverInstalled = true;
          window.__metaInboxObserverInstance = observer;
          return { installed: true };
        }

        return { installed: false, error: 'NO_BODY' };
      })([${debounceMs}, ${maxWaitMs}])`
    );
  } catch (err) {
    log.warn(`[DOM OBSERVER] Không thể cài đặt MutationObserver: ${err.message}`);
    return { installed: false, error: err.message };
  }
}

/**
 * Wires the page-to-Node mutation signal and registers navigation re-installation.
 */
export async function setupDomMutationSignal(page, onSignal, options = {}) {
  const debounceMs = typeof options === 'number' ? options : (options?.debounceMs ?? 150);
  const maxWaitMs = options?.maxWaitMs ?? 350;

  try {
    try {
      await page.exposeFunction('__onMetaInboxDomMutation', (data) => {
        if (typeof onSignal === 'function') {
          onSignal(data);
        }
      });
    } catch (expErr) {
      if (!expErr.message?.includes('already registered')) {
        log.warn(`[DOM OBSERVER] Lỗi exposeFunction: ${expErr.message}`);
      }
    }

    await installMetaInboxDomObserver(page, { debounceMs, maxWaitMs });

    page.on('load', async () => {
      try {
        await installMetaInboxDomObserver(page, { debounceMs, maxWaitMs });
      } catch (_) {}
    });

    log.info(`[DOM OBSERVER] Đã kích hoạt MutationObserver có chọn lọc (debounce=${debounceMs}ms, maxWait=${maxWaitMs}ms).`);
  } catch (err) {
    log.warn(`[DOM OBSERVER] Lỗi khởi tạo hệ thống signal: ${err.message}`);
  }
}
