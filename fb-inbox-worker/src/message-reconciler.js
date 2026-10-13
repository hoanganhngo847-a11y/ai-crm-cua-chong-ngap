import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

/**
 * Stateful Message-Instance Reconciler for Meta Business Suite DOM Virtualization
 *
 * Invariant guarantees:
 * 1. A message instance that received a fingerprint NEVER changes its fingerprint
 *    just because an older message was removed from the DOM by Meta's virtualization.
 * 2. Two distinct messages with identical content, direction, and timestamp
 *    ALWAYS receive distinct deterministic fingerprints.
 * 3. Survives full DOM node destruction/re-creation by leveraging native Meta
 *    `data-message-id` (`mid.$...`) as primary identifier, with monotonic sequence matching fallback.
 * 4. Survives worker process restarts and thread evictions via atomic persistent state storage.
 * 5. Bounded memory per thread (max 200 instances) and bounded threads (max 100) with LRU cleanup.
 */

export class ThreadMessageReconciler {
  constructor(options = {}) {
    this.maxTrackedPerThread = options.maxTrackedPerThread || 200;
    this.maxThreads = options.maxThreads || 100;
    this.storagePath = options.storagePath !== undefined
      ? options.storagePath
      : (CONFIG?.USER_DATA_DIR ? path.resolve(CONFIG.USER_DATA_DIR, 'reconciliation_state.json') : null);

    // Map: stableThreadId -> ThreadState (active in-memory state)
    this.threads = new Map();
    // Map: stableThreadId -> PersistentCheckpoint (monotonic ordinals and synced fingerprints)
    this.threadCheckpoints = new Map();
    this.load();
  }

  load() {
    if (!this.storagePath) return;
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const parsed = JSON.parse(raw);

        // 1. Restore checkpoints first
        if (parsed && parsed.threadCheckpoints && typeof parsed.threadCheckpoints === 'object') {
          for (const [threadId, cp] of Object.entries(parsed.threadCheckpoints)) {
            this.threadCheckpoints.set(threadId, {
              signatureNextOrdinal: new Map(Object.entries(cp.signatureNextOrdinal || {})),
              syncedFingerprints: new Set(cp.syncedFingerprints || []),
              lastActiveAt: cp.lastActiveAt || Date.now(),
            });
          }
        }

        // 2. Restore active threads
        if (parsed && parsed.threads && typeof parsed.threads === 'object') {
          for (const [threadId, rawState] of Object.entries(parsed.threads)) {
            const signatureNextOrdinal = new Map(Object.entries(rawState.signatureNextOrdinal || {}));
            const syncedFingerprints = new Set(rawState.syncedFingerprints || []);
            const instances = Array.isArray(rawState.instances) ? rawState.instances : [];
            const instanceByMessageId = new Map();
            const instanceByDomUid = new Map();

            for (const inst of instances) {
              if (inst.messageId) instanceByMessageId.set(inst.messageId, inst);
              if (inst.domNodeUid) instanceByDomUid.set(inst.domNodeUid, inst);
            }

            this.threads.set(threadId, {
              instances,
              signatureNextOrdinal,
              instanceByMessageId,
              instanceByDomUid,
              syncedFingerprints,
              lastActiveAt: rawState.lastActiveAt || Date.now(),
            });

            // Ensure checkpoint is synchronized
            this.updateCheckpoint(threadId, this.threads.get(threadId));
          }
        }
      }
    } catch (err) {
      try {
        const corruptPath = `${this.storagePath}.corrupt.${Date.now()}`;
        if (fs.existsSync(this.storagePath)) {
          fs.copyFileSync(this.storagePath, corruptPath);
        }
      } catch (_) {}
      this.threads.clear();
      this.threadCheckpoints.clear();
    }
  }

  updateCheckpoint(threadId, state) {
    if (!threadId || !state) return;
    const existing = this.threadCheckpoints.get(threadId);
    const ordinals = new Map(existing?.signatureNextOrdinal || []);
    if (state.signatureNextOrdinal) {
      for (const [sig, ord] of state.signatureNextOrdinal.entries()) {
        const prev = ordinals.get(sig) || 0;
        if (ord > prev) ordinals.set(sig, ord);
      }
    }
    const synced = new Set(existing?.syncedFingerprints || []);
    if (state.syncedFingerprints) {
      for (const fp of state.syncedFingerprints) {
        synced.add(fp);
      }
    }
    this.threadCheckpoints.set(threadId, {
      signatureNextOrdinal: ordinals,
      syncedFingerprints: synced,
      lastActiveAt: Math.max(state.lastActiveAt || 0, existing?.lastActiveAt || 0, Date.now()),
    });
  }

  save() {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const payload = {
        version: 1,
        lastSavedAt: new Date().toISOString(),
        threads: {},
        threadCheckpoints: {},
      };

      for (const [threadId, state] of this.threads.entries()) {
        payload.threads[threadId] = {
          instances: state.instances.slice(-this.maxTrackedPerThread),
          signatureNextOrdinal: Object.fromEntries(state.signatureNextOrdinal),
          syncedFingerprints: Array.from(state.syncedFingerprints || []),
          lastActiveAt: state.lastActiveAt || Date.now(),
        };
      }

      // Checkpoints bounded to max 1000 threads
      const cpEntries = Array.from(this.threadCheckpoints.entries())
        .sort((a, b) => (b[1].lastActiveAt || 0) - (a[1].lastActiveAt || 0))
        .slice(0, 1000);

      for (const [threadId, cp] of cpEntries) {
        payload.threadCheckpoints[threadId] = {
          signatureNextOrdinal: Object.fromEntries(cp.signatureNextOrdinal),
          syncedFingerprints: Array.from(cp.syncedFingerprints || []),
          lastActiveAt: cp.lastActiveAt || Date.now(),
        };
      }

      const tmpPath = `${this.storagePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.storagePath);
    } catch (_) {
      // Fail closed without crashing worker
    }
  }

  getThreadState(threadId) {
    let state = this.threads.get(threadId);
    if (!state) {
      const checkpoint = this.threadCheckpoints.get(threadId);
      state = {
        instances: [], // Ordered history of tracked instances
        signatureNextOrdinal: checkpoint ? new Map(checkpoint.signatureNextOrdinal) : new Map(),
        instanceByMessageId: new Map(), // messageId (mid.$...) -> instance
        instanceByDomUid: new Map(), // domNodeUid -> instance
        syncedFingerprints: checkpoint ? new Set(checkpoint.syncedFingerprints) : new Set(),
        lastActiveAt: Date.now(),
      };
      this.threads.set(threadId, state);
    }
    state.lastActiveAt = Date.now();
    this.updateCheckpoint(threadId, state);
    return state;
  }

  markFingerprintSynced(threadId, fingerprint) {
    if (!threadId || !fingerprint) return;
    const state = this.getThreadState(threadId);
    state.syncedFingerprints.add(fingerprint);
    this.updateCheckpoint(threadId, state);
    this.save();
  }

  isFingerprintSynced(threadId, fingerprint) {
    const state = this.threads.get(threadId);
    if (state && state.syncedFingerprints.has(fingerprint)) return true;
    const cp = this.threadCheckpoints.get(threadId);
    return cp ? cp.syncedFingerprints.has(fingerprint) : false;
  }

  getAllSyncedFingerprints() {
    const all = new Set();
    for (const state of this.threads.values()) {
      if (state.syncedFingerprints) {
        for (const fp of state.syncedFingerprints) {
          all.add(fp);
        }
      }
    }
    for (const cp of this.threadCheckpoints.values()) {
      if (cp.syncedFingerprints) {
        for (const fp of cp.syncedFingerprints) {
          all.add(fp);
        }
      }
    }
    return Array.from(all);
  }

  cleanup() {
    if (this.threads.size > this.maxThreads) {
      // LRU eviction from memory: sort by lastActiveAt ascending
      const entries = Array.from(this.threads.entries()).sort(
        (a, b) => (a[1].lastActiveAt || 0) - (b[1].lastActiveAt || 0)
      );
      const toDeleteCount = this.threads.size - this.maxThreads;
      for (let i = 0; i < toDeleteCount; i++) {
        const [threadId, threadState] = entries[i];
        // Preserve monotonic ordinals and synced fingerprints in checkpoint before evicting memory instances
        this.updateCheckpoint(threadId, threadState);
        this.threads.delete(threadId);
      }
      this.save();
    }
  }

  /**
   * Reset state for a specific thread (useful for tests or clean re-scans)
   */
  resetThread(threadId) {
    this.threads.delete(threadId);
    this.threadCheckpoints.delete(threadId);
    this.save();
  }

  /**
   * Clear all tracked threads
   */
  clear() {
    this.threads.clear();
    this.threadCheckpoints.clear();
    this.save();
  }

  /**
   * Computes signature for message equivalence
   */
  getSignature(m) {
    return `${m.direction}::${m.content}::${m.utime || m.timestamp}`;
  }

  /**
   * Computes deterministic fingerprint with stable occurrence ordinal or messageId
   */
  computeFingerprint(pageId, stableThreadId, m, occurrence) {
    if (m.messageId) {
      return crypto
        .createHash('sha256')
        .update(`${pageId}:${stableThreadId}:${m.messageId}`)
        .digest('hex');
    }
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

    // Step 1: Match by stable Meta Message ID first (Tier 1 - Gold Standard)
    for (let j = 0; j < V.length; j++) {
      const v = V[j];
      if (v.messageId && state.instanceByMessageId.has(v.messageId)) {
        const existing = state.instanceByMessageId.get(v.messageId);
        matchedV[j] = existing;
        const hIdx = H.indexOf(existing);
        if (hIdx !== -1) usedHIndices.add(hIdx);
      }
    }

    // Step 2: Match by DOM Node UID (Tier 2 - session DOM node continuity)
    for (let j = 0; j < V.length; j++) {
      if (matchedV[j]) continue;
      const v = V[j];
      // Only match by domNodeUid if v has no messageId or messageId was not registered
      if (v.domNodeUid && !v.messageId && state.instanceByDomUid.has(v.domNodeUid)) {
        const existing = state.instanceByDomUid.get(v.domNodeUid);
        if (existing && existing.signature === this.getSignature(v)) {
          matchedV[j] = existing;
          const hIdx = H.indexOf(existing);
          if (hIdx !== -1) usedHIndices.add(hIdx);
        }
      }
    }

    // Step 3: Suffix/overlap sequence matching for remaining unmatched elements
    // Note: If an element in V has a new v.messageId not present in H, it is an
    // explicit NEW message and must NOT be matched to an old H instance.
    const hasUnmatched = matchedV.some((m, idx) => m === null && !V[idx].messageId);
    if (hasUnmatched && H.length > 0) {
      // 3a. Try tail alignment: if V is shorter than or equal to H, and all unmatched elements
      // align with the tail of H
      const tailOffset = H.length - V.length;
      if (tailOffset >= 0) {
        let tailMatches = true;
        for (let j = 0; j < V.length; j++) {
          if (V[j].messageId && !matchedV[j]) {
            // New messageId: cannot be matched via tail alignment
            tailMatches = false;
            break;
          }
          if (matchedV[j]) {
            if (H[tailOffset + j] !== matchedV[j]) {
              tailMatches = false;
              break;
            }
          } else {
            const hCandidate = H[tailOffset + j];
            if (
              !hCandidate ||
              usedHIndices.has(tailOffset + j) ||
              hCandidate.signature !== this.getSignature(V[j]) ||
              hCandidate.messageId // Do not match a message with known messageId to one without
            ) {
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

      // 3b. Overlap sequence matching with chronological monotonicity
      let bestOffset = -1;
      let maxOverlap = 0;

      for (let k = 0; k < H.length; k++) {
        let overlap = 0;
        let valid = true;
        for (let j = 0; j < V.length && (k + j) < H.length; j++) {
          if (V[j].messageId && !matchedV[j]) {
            valid = false;
            break;
          }
          if (matchedV[j]) {
            if (H[k + j] !== matchedV[j]) {
              valid = false;
              break;
            }
            overlap++;
          } else {
            const hCandidate = H[k + j];
            if (
              hCandidate.signature === this.getSignature(V[j]) &&
              !usedHIndices.has(k + j) &&
              !hCandidate.messageId
            ) {
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
          if (
            !matchedV[j] &&
            !usedHIndices.has(bestOffset + j) &&
            H[bestOffset + j].signature === this.getSignature(V[j]) &&
            !H[bestOffset + j].messageId &&
            !V[j].messageId
          ) {
            matchedV[j] = H[bestOffset + j];
            usedHIndices.add(bestOffset + j);
          }
        }
      }

      // 3c. Chronological monotonic matching for remaining items without messageId
      let searchHStart = 0;
      for (let j = 0; j < V.length; j++) {
        if (matchedV[j]) {
          const idx = H.indexOf(matchedV[j]);
          if (idx !== -1 && idx >= searchHStart) {
            searchHStart = idx + 1;
          }
          continue;
        }

        if (V[j].messageId) continue;

        const sig = this.getSignature(V[j]);
        for (let i = searchHStart; i < H.length; i++) {
          if (!usedHIndices.has(i) && H[i].signature === sig && !H[i].messageId) {
            matchedV[j] = H[i];
            usedHIndices.add(i);
            searchHStart = i + 1;
            break;
          }
        }
      }
    }

    // Step 4: Allocate new instance for all unmatched items in V
    const resultMessages = [];

    for (let j = 0; j < V.length; j++) {
      const v = V[j];
      const sig = this.getSignature(v);
      let instance = matchedV[j];

      if (!instance) {
        let occurrence = 0;
        if (!v.messageId) {
          // Allocate monotonic occurrence ordinal for this signature
          const currentNext = state.signatureNextOrdinal.get(sig) || 0;
          state.signatureNextOrdinal.set(sig, currentNext + 1);
          occurrence = currentNext;
        } else {
          // If message has native messageId, signature ordinal is tracked for reference
          const currentNext = state.signatureNextOrdinal.get(sig) || 0;
          state.signatureNextOrdinal.set(sig, currentNext + 1);
          occurrence = currentNext;
        }

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
          messageId: v.messageId || null,
          domNodeUid: v.domNodeUid || null,
        };

        H.push(instance);
        if (v.messageId) {
          state.instanceByMessageId.set(v.messageId, instance);
        }
        if (v.domNodeUid) {
          state.instanceByDomUid.set(v.domNodeUid, instance);
        }
      } else {
        // Update references if new information became available
        if (v.messageId && !instance.messageId) {
          instance.messageId = v.messageId;
          state.instanceByMessageId.set(v.messageId, instance);
        }
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
        messageId: instance.messageId,
      });
    }

    // Bound memory: prune H if it exceeds maxTrackedPerThread
    if (H.length > this.maxTrackedPerThread) {
      const pruned = H.splice(0, H.length - this.maxTrackedPerThread);
      for (const p of pruned) {
        if (p.messageId) {
          state.instanceByMessageId.delete(p.messageId);
        }
        if (p.domNodeUid) {
          state.instanceByDomUid.delete(p.domNodeUid);
        }
      }
    }

    this.updateCheckpoint(stableThreadId, state);
    this.cleanup();
    this.save();
    return resultMessages;
  }
}

export const messageReconciler = new ThreadMessageReconciler();
