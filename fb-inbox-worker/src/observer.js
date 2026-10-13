import { log } from './logger.js';

/**
 * Event-Driven DOM Observer for Meta Business Suite Inbox
 * 
 * Sets up a lightweight MutationObserver on the live DOM to detect incoming
 * messages, unread indicators, and conversation list updates immediately.
 * 
 * Conforms strictly to requirements:
 * 1. Debounced by 100-250ms (default 150ms) to eliminate mutation storms.
 * 2. Emits lightweight signal to Node waker WITHOUT parsing inside the observer.
 * 3. Never uses private Meta APIs, WebSockets, or reverse-engineered endpoints.
 */

export class CycleWaker {
  constructor() {
    this._resolve = null;
    this._promise = null;
    this._reset();
  }

  _reset() {
    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  wake(signalData = {}) {
    if (this._resolve) {
      const resolver = this._resolve;
      this._reset();
      resolver({ type: 'SIGNAL', ...signalData });
    }
  }

  async waitForNextCycle(timeoutMs = 5000) {
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ type: 'TIMEOUT' }), timeoutMs);
    });

    const result = await Promise.race([this._promise, timeoutPromise]);
    clearTimeout(timer);
    return result;
  }
}

/**
 * Injects the MutationObserver into the page DOM.
 */
export async function installMetaInboxDomObserver(page, debounceMs = 150) {
  try {
    return await page.evaluate((debounceDuration) => {
      if (window.__metaInboxObserverInstalled) {
        return { alreadyInstalled: true };
      }

      let debounceTimer = null;
      let pendingCount = 0;

      const emitSignal = () => {
        const domSignalAt = Date.now();
        if (typeof window.__onMetaInboxDomMutation === 'function') {
          window.__onMetaInboxDomMutation({
            domSignalAt,
            mutationsCount: pendingCount
          }).catch(() => {});
        }
        pendingCount = 0;
      };

      const observer = new MutationObserver((mutations) => {
        let isRelevant = false;

        for (const m of mutations) {
          const target = m.target;
          if (target && target.nodeType === Node.ELEMENT_NODE) {
            const tagName = (target.tagName || '').toLowerCase();
            if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') {
              continue;
            }
          }

          // Relevant triggers:
          // 1. Added nodes (new message bubble, new conversation row, unread badge)
          // 2. Text modified (snippet, time header)
          // 3. Relevant attribute changes (aria-label, class)
          if (
            m.addedNodes.length > 0 ||
            m.type === 'characterData' ||
            (m.type === 'attributes' && (m.attributeName === 'aria-label' || m.attributeName === 'class'))
          ) {
            isRelevant = true;
            break;
          }
        }

        if (!isRelevant) return;

        pendingCount++;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          emitSignal();
        }, debounceDuration);
      });

      if (document.body) {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['aria-label', 'class']
        });
        window.__metaInboxObserverInstalled = true;
        window.__metaInboxObserverInstance = observer;
        return { installed: true };
      }

      return { installed: false, error: 'NO_BODY' };
    }, debounceMs);
  } catch (err) {
    log.warn(`[DOM OBSERVER] Không thể cài đặt MutationObserver: ${err.message}`);
    return { installed: false, error: err.message };
  }
}

/**
 * Wires the page-to-Node mutation signal and registers navigation re-installation.
 */
export async function setupDomMutationSignal(page, onSignal, debounceMs = 150) {
  try {
    // Expose binding if not already exposed
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

    // Install observer into current DOM
    await installMetaInboxDomObserver(page, debounceMs);

    // Re-install automatically if page navigates or reloads
    page.on('load', async () => {
      try {
        await installMetaInboxDomObserver(page, debounceMs);
      } catch (_) {}
    });

    log.info(`[DOM OBSERVER] Đã kích hoạt MutationObserver chế độ gần thời gian thực (debounce=${debounceMs}ms).`);
  } catch (err) {
    log.warn(`[DOM OBSERVER] Lỗi khởi tạo hệ thống signal: ${err.message}`);
  }
}
