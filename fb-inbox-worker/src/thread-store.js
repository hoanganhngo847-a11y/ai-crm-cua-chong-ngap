import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from './config.js';

const THREAD_MAP_FILE = path.resolve(CONFIG.USER_DATA_DIR, 'thread_map.json');

class ThreadStore {
  constructor() {
    this.map = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(THREAD_MAP_FILE)) {
        const raw = fs.readFileSync(THREAD_MAP_FILE, 'utf-8');
        this.map = JSON.parse(raw);
      }
    } catch (_) {
      this.map = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(THREAD_MAP_FILE, JSON.stringify(this.map, null, 2), 'utf-8');
    } catch (_) {}
  }

  /**
   * Resolves a stable thread identifier following priority rules:
   * 1. Direct Business Suite thread identifier (if UI exposes one)
   * 2. Customer Facebook/profile ID (e.g. 61578695363056)
   * 3. Persistent local mapping in worker (saved to thread_map.json)
   */
  resolveStableThreadId(pageId, customerFbId, directThreadId, customerName) {
    // 1. Direct stable thread ID from UI
    if (directThreadId && typeof directThreadId === 'string' && directThreadId.trim()) {
      return directThreadId.trim();
    }

    // 2. Customer Facebook profile ID
    if (customerFbId && typeof customerFbId === 'string' && customerFbId.trim()) {
      return `${pageId}:${customerFbId.trim()}`;
    }

    // 3. Persistent local mapping store in worker
    const lookupKey = `${pageId}:${(customerName || 'anonymous').trim().toLowerCase()}`;
    if (this.map[lookupKey]) {
      return this.map[lookupKey];
    }

    // Generate persistent deterministic hash and persist
    const generatedId = `fb_thread_${crypto.createHash('sha256').update(lookupKey).digest('hex').slice(0, 16)}`;
    this.map[lookupKey] = generatedId;
    this.save();
    return generatedId;
  }
}

export const threadStore = new ThreadStore();
