import crypto from 'crypto';

/**
 * Stateful Message-Instance Reconciler for Meta Business Suite DOM Virtualization
 *
 * Invariant guarantees:
 * 1. A message instance that received a fingerprint NEVER changes its fingerprint
 *    just because an older message was removed from the DOM by Meta's virtualization.
 * 2. Two distinct messages with identical content, direction, and timestamp
 *    ALWAYS receive distinct deterministic fingerprints.
 * 3. Bounded memory per thread (max 200 instances) and max 100 threads to prevent memory leaks.
 */

export class ThreadMessageReconciler {
  constructor(options = {}) {
    this.maxTrackedPerThread = options.maxTrackedPerThread || 200;
    this.maxThreads = options.maxThreads || 100;
    // Map: stableThreadId -> ThreadState
    this.threads = new Map();
  }

  getThreadState(threadId) {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        instances: [], // Ordered history of tracked instances
        signatureNextOrdinal: new Map(), // signature -> next ordinal (0, 1, 2, ...)
        instanceByDomUid: new Map(), // domNodeUid -> instance
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  cleanup() {
    if (this.threads.size > this.maxThreads) {
      const keys = Array.from(this.threads.keys());
      const toDelete = keys.slice(0, keys.length - this.maxThreads);
      for (const k of toDelete) {
        this.threads.delete(k);
      }
    }
  }

  /**
   * Reset state for a specific thread (useful for tests or clean re-scans)
   */
  resetThread(threadId) {
    this.threads.delete(threadId);
  }

  /**
   * Clear all tracked threads
   */
  clear() {
    this.threads.clear();
  }

  /**
   * Computes signature for message equivalence
   */
  getSignature(m) {
    return `${m.direction}::${m.content}::${m.utime || m.timestamp}`;
  }

  /**
   * Computes deterministic fingerprint with stable occurrence ordinal
   */
  computeFingerprint(pageId, stableThreadId, m, occurrence) {
    const occurrenceSuffix = (typeof occurrence === 'number' && occurrence > 0) ? `:occ:${occurrence}` : '';
    return crypto
      .createHash('sha256')
      .update(`${pageId}:${stableThreadId}:${m.utime || m.timestamp}:${m.content}:${m.direction}${occurrenceSuffix}`)
      .digest('hex');
  }

  /**
   * Reconciles visible parsed messages from the DOM with historical thread instances.
   */
  reconcile({ pageId, stableThreadId, rawMessages }) {
    if (!rawMessages || rawMessages.length === 0) {
      return [];
    }

    const state = this.getThreadState(stableThreadId);
    const H = state.instances;
    const V = rawMessages;

    const matchedV = new Array(V.length).fill(null);
    const usedHIndices = new Set();

    // Step 1: Match by DOM Node UID first (if present on both)
    for (let j = 0; j < V.length; j++) {
      const v = V[j];
      if (v.domNodeUid && state.instanceByDomUid.has(v.domNodeUid)) {
        const existing = state.instanceByDomUid.get(v.domNodeUid);
        if (existing && existing.signature === this.getSignature(v)) {
          matchedV[j] = existing;
          const hIdx = H.indexOf(existing);
          if (hIdx !== -1) usedHIndices.add(hIdx);
        }
      }
    }

    // Step 2: Suffix/overlap sequence matching for unmatched elements
    const hasUnmatched = matchedV.some(m => m === null);
    if (hasUnmatched && H.length > 0) {
      // 2a. Try tail alignment: if V is shorter than or equal to H, and all unmatched elements
      // align with the tail of H (standard chat window virtualization: top items removed)
      const tailOffset = H.length - V.length;
      if (tailOffset >= 0) {
        let tailMatches = true;
        for (let j = 0; j < V.length; j++) {
          if (matchedV[j]) {
            // If already matched by UID, check if it matches the expected position in tail
            if (H[tailOffset + j] !== matchedV[j]) {
              tailMatches = false;
              break;
            }
          } else {
            const hCandidate = H[tailOffset + j];
            if (!hCandidate || usedHIndices.has(tailOffset + j) || hCandidate.signature !== this.getSignature(V[j])) {
              tailMatches = false;
              break;
            }
          }
        }

        if (tailMatches) {
          for (let j = 0; j < V.length; j++) {
            if (!matchedV[j]) {
              const hIdx = tailOffset + j;
              matchedV[j] = H[hIdx];
              usedHIndices.add(hIdx);
            }
          }
        }
      }

      // 2b. If tail alignment didn't match all, try overlap matching with chronological monotonicity
      let bestOffset = -1;
      let maxOverlap = 0;

      for (let k = 0; k < H.length; k++) {
        let overlap = 0;
        let valid = true;
        for (let j = 0; j < V.length && (k + j) < H.length; j++) {
          if (matchedV[j]) {
            if (H[k + j] !== matchedV[j]) {
              valid = false;
              break;
            }
            overlap++;
          } else {
            if (H[k + j].signature === this.getSignature(V[j]) && !usedHIndices.has(k + j)) {
              overlap++;
            } else {
              valid = false;
              break;
            }
          }
        }
        if (valid && overlap > maxOverlap) {
          maxOverlap = overlap;
          bestOffset = k;
        }
      }

      if (bestOffset !== -1 && maxOverlap > 0) {
        for (let j = 0; j < V.length && (bestOffset + j) < H.length; j++) {
          if (!matchedV[j] && !usedHIndices.has(bestOffset + j) && H[bestOffset + j].signature === this.getSignature(V[j])) {
            matchedV[j] = H[bestOffset + j];
            usedHIndices.add(bestOffset + j);
          }
        }
      }

      // 2c. Chronological monotonic matching for remaining items (messages never go backwards in time)
      let searchHStart = 0;
      for (let j = 0; j < V.length; j++) {
        if (matchedV[j]) {
          const idx = H.indexOf(matchedV[j]);
          if (idx !== -1 && idx >= searchHStart) {
            searchHStart = idx + 1;
          }
          continue;
        }

        const sig = this.getSignature(V[j]);
        for (let i = searchHStart; i < H.length; i++) {
          if (!usedHIndices.has(i) && H[i].signature === sig) {
            matchedV[j] = H[i];
            usedHIndices.add(i);
            searchHStart = i + 1;
            break;
          }
        }
      }
    }

    // Step 3: For all items in V, allocate new instance if unmatched, compute stable fingerprint
    const resultMessages = [];

    for (let j = 0; j < V.length; j++) {
      const v = V[j];
      const sig = this.getSignature(v);
      let instance = matchedV[j];

      if (!instance) {
        // Allocate monotonic occurrence ordinal for this signature
        const currentNext = state.signatureNextOrdinal.get(sig) || 0;
        state.signatureNextOrdinal.set(sig, currentNext + 1);

        const occurrence = currentNext;
        const fingerprint = this.computeFingerprint(pageId, stableThreadId, v, occurrence);

        instance = {
          content: v.content,
          direction: v.direction,
          direction_reason: v.direction_reason,
          timestamp: v.timestamp,
          utime: v.utime,
          signature: sig,
          occurrence,
          fingerprint,
          stableThreadId,
          domNodeUid: v.domNodeUid || null,
        };

        H.push(instance);
        if (v.domNodeUid) {
          state.instanceByDomUid.set(v.domNodeUid, instance);
        }
      } else {
        // If matched existing instance, update DOM node UID if available
        if (v.domNodeUid && !instance.domNodeUid) {
          instance.domNodeUid = v.domNodeUid;
          state.instanceByDomUid.set(v.domNodeUid, instance);
        }
      }

      resultMessages.push({
        ...v,
        occurrence: instance.occurrence,
        fingerprint: instance.fingerprint,
        stableThreadId,
      });
    }

    // Bound memory: prune H if it exceeds maxTrackedPerThread
    if (H.length > this.maxTrackedPerThread) {
      const pruned = H.splice(0, H.length - this.maxTrackedPerThread);
      for (const p of pruned) {
        if (p.domNodeUid) {
          state.instanceByDomUid.delete(p.domNodeUid);
        }
      }
    }

    this.cleanup();
    return resultMessages;
  }
}

export const messageReconciler = new ThreadMessageReconciler();
