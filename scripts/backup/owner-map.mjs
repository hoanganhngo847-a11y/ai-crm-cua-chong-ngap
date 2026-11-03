#!/usr/bin/env node
/**
 * scripts/backup/owner-map.mjs
 *
 * Helper #6: PostgreSQL Ownership Mapping Generator & Verifier (Local Rehearsal Phase)
 *
 * Authoritative References:
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md §R5, §16.10, §19.7
 * - docs/META_ADS_STAGING_BACKUP_RESTORE_RUNBOOK_v12.md §B3 (owner-inventory & catalog-details SQL)
 *
 * Capabilities:
 * - plan: Validates source owner-inventory against approved owner-map and target role inventory;
 *         generates deterministic, transaction-wrapped, SQL-injection-hardened SQL plan;
 *         computes SHA-256 approval hash and records plan evidence report.
 * - apply: Enforces reviewer-approved SHA-256 hash match before execution;
 *          verifies local isolated environment (rejects remote/cloud targets);
 *          executes plan inside local PostgreSQL database/container with full rollback on error.
 * - verify: Validates post-apply ownership of all source inventory objects against approved target roles;
 *           verifies routine proowner, prosecdef (SECURITY DEFINER), proconfig, and EXECUTE ACL;
 *           fails closed with status BLOCKED if any ownership or security discrepancy is detected.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Constants & Configuration
// -----------------------------------------------------------------------------

export const OWNER_MAP_FORMAT = 'crm-owner-map/v1';
export const PLAN_REPORT_FORMAT = 'crm-owner-map-plan/v1';
export const VERIFY_REPORT_FORMAT = 'crm-owner-map-verification/v1';
export const DEFAULT_TARGET_IDENTITY = 'crm-restore-rehearsal';

export const APPROVED_CONTAINERS = Object.freeze(new Set([
  'supabase_db_crm-restore-rehearsal',
  'crm-dumpcheck-test',
  'supabase_db_crm-meta-migration-validation',
]));

export const SUPPORTED_OBJECT_TYPES = Object.freeze(new Set([
  'schema',
  'table',
  'partitioned_table',
  'foreign_table',
  'sequence',
  'view',
  'materialized_view',
  'type',
  'domain',
  'function',
  'procedure',
]));

// -----------------------------------------------------------------------------
// Custom Error Class
// -----------------------------------------------------------------------------

export class HelperError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = null) {
  throw new HelperError(code, message, details);
}

// -----------------------------------------------------------------------------
// Signal Handling & Temp File Lifecycle
// -----------------------------------------------------------------------------

const activeTempFiles = new Set();
let signalsInstalled = false;

export function registerTempFile(filePath) {
  activeTempFiles.add(filePath);
}

export function unregisterTempFile(filePath) {
  activeTempFiles.delete(filePath);
}

export function cleanupAllTempsSync() {
  for (const f of activeTempFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // Best-effort cleanup
    }
  }
  activeTempFiles.clear();
}

export function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanupAllTempsSync();
      process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1));
    });
  }
}

// -----------------------------------------------------------------------------
// Cryptographic Hash Utilities
// -----------------------------------------------------------------------------

export function sha256Hex(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, typeof data === 'string' ? 'utf8' : undefined);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

// -----------------------------------------------------------------------------
// Atomic File Writer
// -----------------------------------------------------------------------------

export async function writeFileAtomic(targetPath, content, mode = 0o600) {
  installSignalHandlers();
  const dir = targetPath.endsWith('/') ? targetPath : targetPath.substring(0, targetPath.lastIndexOf('/'));
  if (dir) {
    await fsp.mkdir(dir, { recursive: true });
  }

  const nonce = crypto.randomBytes(8).toString('hex');
  const tempPath = `${targetPath}.tmp.${Date.now()}.${nonce}`;
  registerTempFile(tempPath);

  try {
    await fsp.writeFile(tempPath, content, { mode });
    await fsp.rename(tempPath, targetPath);
    unregisterTempFile(tempPath);
  } catch (err) {
    unregisterTempFile(tempPath);
    try {
      await fsp.unlink(tempPath);
    } catch {
      // Best-effort cleanup
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Strict JSON Parser (Detects Duplicate Object Keys & Escaped Keys)
// -----------------------------------------------------------------------------

export function parseJsonStrict(text, code = 'JSON_PARSE_ERROR', label = 'JSON') {
  let index = 0;
  const length = text.length;

  const invalid = (message) => fail(code, `${label} ${message}`);

  const skipWhitespace = () => {
    while (index < length) {
      const codePoint = text.charCodeAt(index);
      if (codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
        index += 1;
      } else {
        break;
      }
    }
  };

  const expectLiteral = (literal, value) => {
    if (text.slice(index, index + literal.length) !== literal) invalid('contains invalid JSON literal');
    index += literal.length;
    return value;
  };

  const parseString = () => {
    if (text[index] !== '"') invalid('contains an invalid JSON string');
    index += 1;
    let result = '';
    while (index < length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        return result;
      }
      if (char === '\\') {
        index += 1;
        if (index >= length) invalid('contains an unterminated escape sequence');
        const escape = text[index];
        index += 1;
        switch (escape) {
          case '"': result += '"'; break;
          case '\\': result += '\\'; break;
          case '/': result += '/'; break;
          case 'b': result += '\b'; break;
          case 'f': result += '\f'; break;
          case 'n': result += '\n'; break;
          case 'r': result += '\r'; break;
          case 't': result += '\t'; break;
          case 'u': {
            if (index + 4 > length) invalid('contains an unterminated unicode escape');
            const hex = text.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid('contains an invalid unicode escape');
            const unit = Number.parseInt(hex, 16);
            index += 4;
            if (unit >= 0xd800 && unit <= 0xdbff) {
              if (text.slice(index, index + 2) !== '\\u') {
                invalid('contains an unpaired high surrogate');
              }
              index += 2;
              if (index + 4 > length) invalid('contains an unterminated low surrogate');
              const lowHex = text.slice(index, index + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) invalid('contains an invalid low surrogate');
              const low = Number.parseInt(lowHex, 16);
              if (low < 0xdc00 || low > 0xdfff) invalid('contains an unpaired high surrogate');
              index += 4;
              result += String.fromCharCode(unit, low);
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              invalid('contains an unpaired low surrogate');
            } else {
              result += String.fromCharCode(unit);
            }
            break;
          }
          default:
            invalid('contains an invalid escape sequence');
        }
        continue;
      }
      const codePoint = text.charCodeAt(index);
      if (codePoint < 0x20) invalid('contains an unescaped control character');
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        if (codePoint <= 0xdbff && index + 1 < length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            result += text[index] + text[index + 1];
            index += 2;
            continue;
          }
        }
        invalid('contains an unpaired surrogate');
      }
      result += char;
      index += 1;
    }
    invalid('contains an unterminated string');
  };

  const parseNumber = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) invalid('contains an invalid number');
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid('contains a non-finite number');
    index += match[0].length;
    return value;
  };

  const parseArray = (depth) => {
    index += 1;
    const result = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return result;
    }
    while (true) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      invalid('contains an unterminated array');
    }
  };

  const parseObject = (depth) => {
    index += 1;
    const result = Object.create(null);
    const seen = new Set();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    while (true) {
      skipWhitespace();
      if (text[index] !== '"') invalid('contains an object key that is not a string');
      const key = parseString();
      if (seen.has(key)) invalid(`duplicate JSON key: ${key}`);
      seen.add(key);
      skipWhitespace();
      if (text[index] !== ':') invalid('contains an object key without a colon');
      index += 1;
      result[key] = parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      invalid('contains an unterminated object');
    }
  };

  const parseValue = (depth) => {
    if (depth > 64) invalid('exceeds maximum JSON nesting depth');
    skipWhitespace();
    if (index >= length) invalid('unexpected end of JSON input');
    const char = text[index];
    if (char === '"') return parseString();
    if (char === '{') return parseObject(depth);
    if (char === '[') return parseArray(depth);
    if (char === 't') return expectLiteral('true', true);
    if (char === 'f') return expectLiteral('false', false);
    if (char === 'n') return expectLiteral('null', null);
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    invalid(`contains unexpected character '${char}'`);
  };

  skipWhitespace();
  const parsed = parseValue(0);
  skipWhitespace();
  if (index !== length) invalid('contains trailing data after top-level value');
  return parsed;
}

// -----------------------------------------------------------------------------
// PostgreSQL Identifier Quoting & Parsing (SQL Injection Hardening)
// -----------------------------------------------------------------------------

/**
 * Safely double-quotes an identifier for PostgreSQL.
 * Rejects null bytes and invalid characters.
 */
export function quoteIdent(identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0) {
    fail('INVALID_IDENTIFIER', 'identifier must be a non-empty string');
  }
  if (identifier.includes('\0')) {
    fail('SQL_INJECTION_DETECTED', 'null byte in identifier');
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Validates a PostgreSQL role name identifier (R2-P2-01).
 * Ensures no statement terminators, comments, null bytes, control characters, or line breaks.
 *
 * For catalog role names (default, options.isSqlToken !== true):
 * - Quoted roles (e.g. "Old_Admin") unquote and preserve case ('Old_Admin').
 * - Unquoted roles (e.g. Old_Admin) validate characters and preserve exact case ('Old_Admin').
 * For SQL tokens (options.isSqlToken === true):
 * - Unquoted roles fold to lowercase, matching PostgreSQL SQL lexical grammar.
 */
export function validateRoleIdentifier(role, label = 'role', options = {}) {
  const opts = typeof options === 'boolean' ? { isSqlToken: options } : options || {};
  if (typeof role !== 'string' || role.trim().length === 0) {
    fail('INVALID_ROLE_IDENTIFIER', `${label} must be a non-empty string`);
  }
  const trimmed = role.trim();
  if (trimmed.includes('\0')) {
    fail('SQL_INJECTION_DETECTED', `null byte in ${label} '${role}'`);
  }
  if (trimmed.includes(';') || trimmed.includes('--') || trimmed.includes('/*')) {
    fail('SQL_INJECTION_DETECTED', `SQL injection token detected in ${label} '${role}'`);
  }
  if (/[\r\n\u2028\u2029\u0085\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
    fail('SQL_INJECTION_DETECTED', `control character or line separator in ${label} '${role}'`);
  }

  // Check identifier structure
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      fail('INVALID_ROLE_IDENTIFIER', `unclosed quoted ${label} '${role}'`);
    }
    const inner = trimmed.slice(1, -1);
    const unescaped = inner.replace(/""/g, '');
    if (unescaped.includes('"')) {
      fail('INVALID_ROLE_IDENTIFIER', `invalid quotes inside ${label} '${role}'`);
    }
    return inner.replace(/""/g, '"');
  }

  // Unquoted identifier: standard valid chars
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(trimmed)) {
    fail('INVALID_ROLE_IDENTIFIER', `invalid unquoted ${label} identifier '${role}'`);
  }

  // Fold only when explicitly requested as an SQL lexical token (e.g. in SQL parser)
  if (opts.isSqlToken) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

/**
 * Helper to parse a single identifier token (quoted or unquoted) from input string.
 * According to PostgreSQL semantics, unquoted identifiers are folded to lowercase,
 * while quoted identifiers preserve their exact case.
 */
function parseIdentifierToken(input, startIndex = 0) {
  let i = startIndex;
  while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
  if (i >= input.length) return null;

  if (input[i] === '"') {
    let ident = '';
    i++;
    let closed = false;
    while (i < input.length) {
      if (input[i] === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          ident += '"';
          i += 2;
        } else {
          i++;
          closed = true;
          break;
        }
      } else {
        if (input[i] === '\0') {
          fail('SQL_INJECTION_DETECTED', 'null byte in identifier');
        }
        ident += input[i];
        i++;
      }
    }
    if (!closed) {
      fail('INVALID_IDENTIFIER', `unclosed quote in identifier: ${input}`);
    }
    return { name: ident, endIndex: i, quoted: true };
  }

  const start = i;
  while (i < input.length && /[a-zA-Z0-9_$]/.test(input[i])) {
    i++;
  }
  const ident = input.slice(start, i);
  if (!ident || !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(ident)) {
    fail('INVALID_IDENTIFIER', `invalid unquoted identifier at position ${start}: ${input}`);
  }
  // PostgreSQL folds unquoted identifiers to lowercase
  return { name: ident.toLowerCase(), endIndex: i, quoted: false };
}

/**
 * Parses and validates two-part relation/type/domain identity: "schema.name"
 */
function parseTwoPartIdentity(identity) {
  const p1 = parseIdentifierToken(identity, 0);
  if (!p1 || p1.endIndex >= identity.length || identity[p1.endIndex] !== '.') {
    fail('INVALID_OBJECT_IDENTITY', `missing schema separator dot in '${identity}'`);
  }
  const p2 = parseIdentifierToken(identity, p1.endIndex + 1);
  if (!p2) {
    fail('INVALID_OBJECT_IDENTITY', `missing relation/type name in '${identity}'`);
  }
  const rest = identity.slice(p2.endIndex).trim();
  if (rest.length > 0) {
    fail('SQL_INJECTION_DETECTED', `unexpected trailing tokens in '${identity}': ${rest}`);
  }
  return { schema: p1.name, name: p2.name };
}

/**
 * Parses and validates routine (function/procedure) identity: "schema.name(arg_types)"
 */
function parseRoutineIdentity(identity) {
  const p1 = parseIdentifierToken(identity, 0);
  if (!p1 || p1.endIndex >= identity.length || identity[p1.endIndex] !== '.') {
    fail('INVALID_OBJECT_IDENTITY', `missing schema separator dot in '${identity}'`);
  }
  const p2 = parseIdentifierToken(identity, p1.endIndex + 1);
  if (!p2) {
    fail('INVALID_OBJECT_IDENTITY', `missing routine name in '${identity}'`);
  }

  let i = p2.endIndex;
  while (i < identity.length && (identity[i] === ' ' || identity[i] === '\t')) i++;
  if (i >= identity.length || identity[i] !== '(') {
    fail('INVALID_OBJECT_IDENTITY', `expected argument list '(' in routine identity '${identity}'`);
  }

  const openParen = i;
  i++;
  let depth = 1;
  let inString = false;
  let inQuotes = false;

  while (i < identity.length) {
    const ch = identity[i];
    if (ch === '\0') {
      fail('SQL_INJECTION_DETECTED', `null byte in routine arguments of '${identity}'`);
    }

    if (inString) {
      if (ch === "'") {
        if (i + 1 < identity.length && identity[i + 1] === "'") {
          i += 2;
        } else {
          inString = false;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < identity.length && identity[i + 1] === '"') {
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ';') {
      fail('SQL_INJECTION_DETECTED', `semicolon in routine arguments: '${identity}'`);
    }
    if (ch === '-' && i + 1 < identity.length && identity[i + 1] === '-') {
      fail('SQL_INJECTION_DETECTED', `line comment '--' in routine arguments: '${identity}'`);
    }
    if (ch === '/' && i + 1 < identity.length && identity[i + 1] === '*') {
      fail('SQL_INJECTION_DETECTED', `block comment '/*' in routine arguments: '${identity}'`);
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const args = identity.slice(openParen + 1, i).trim();
        const rest = identity.slice(i + 1).trim();
        if (rest.length > 0) {
          fail('SQL_INJECTION_DETECTED', `unexpected trailing tokens after routine '${identity}': ${rest}`);
        }
        return { schema: p1.name, name: p2.name, args };
      }
    }
    i++;
  }

  fail('INVALID_OBJECT_IDENTITY', `unbalanced parentheses in routine identity '${identity}'`);
}

/**
 * Parses and validates an object identity based on its objectType.
 */
export function parseObjectIdentity(objectType, identity) {
  if (typeof identity !== 'string' || identity.trim().length === 0) {
    fail('INVALID_OBJECT_IDENTITY', `identity must be a non-empty string for ${objectType}`);
  }
  const trimmed = identity.trim();
  if (trimmed.includes('\0')) {
    fail('SQL_INJECTION_DETECTED', `null byte in identity '${identity}'`);
  }
  if (trimmed.includes(';') || trimmed.includes('--') || trimmed.includes('/*')) {
    // If semicolon or comment is present anywhere outside allowed routine arg strings, fail
    // parseRoutineIdentity/parseTwoPartIdentity do strict checking
  }

  switch (objectType) {
    case 'schema': {
      const p = parseIdentifierToken(trimmed, 0);
      if (!p) {
        fail('INVALID_OBJECT_IDENTITY', `invalid schema identity '${identity}'`);
      }
      const rest = trimmed.slice(p.endIndex).trim();
      if (rest.length > 0) {
        fail('SQL_INJECTION_DETECTED', `unexpected trailing tokens in schema identity '${identity}': ${rest}`);
      }
      return { schema: p.name, name: p.name };
    }

    case 'table':
    case 'partitioned_table':
    case 'foreign_table':
    case 'sequence':
    case 'view':
    case 'materialized_view':
    case 'type':
    case 'domain':
      return parseTwoPartIdentity(trimmed);

    case 'function':
    case 'procedure':
      return parseRoutineIdentity(trimmed);

    default:
      fail('UNSUPPORTED_OBJECT_TYPE', `unsupported object type '${objectType}' for identity '${identity}'. Fail closed.`);
  }
}

// -----------------------------------------------------------------------------
// Inventory & Owner-Map Validators
// -----------------------------------------------------------------------------

/**
 * Validates owner-inventory JSON data.
 */
export function validateOwnerInventory(inventoryData) {
  if (!Array.isArray(inventoryData)) {
    fail('INVALID_INVENTORY', 'owner inventory must be a JSON array of object entries');
  }

  const seenKeys = new Set();
  const sourceOwners = new Set();

  for (let i = 0; i < inventoryData.length; i++) {
    const item = inventoryData[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('INVALID_INVENTORY', `entry at index ${i} is not a valid JSON object`);
    }

    const { objectType, identity, sourceOwner } = item;
    if (typeof objectType !== 'string' || !SUPPORTED_OBJECT_TYPES.has(objectType)) {
      fail('UNSUPPORTED_OBJECT_TYPE', `unsupported object type '${objectType}' at index ${i}. Fail closed.`);
    }

    if (typeof identity !== 'string' || identity.trim().length === 0) {
      fail('INVALID_INVENTORY', `missing or empty identity at index ${i}`);
    }

    if (typeof sourceOwner !== 'string' || sourceOwner.trim().length === 0) {
      fail('INVALID_INVENTORY', `missing or empty sourceOwner for '${identity}' at index ${i}`);
    }

    // Validate identity syntax & injection safety
    parseObjectIdentity(objectType, identity);
    const cleanSourceOwner = validateRoleIdentifier(sourceOwner, 'sourceOwner');
    item.sourceOwner = cleanSourceOwner;
    sourceOwners.add(cleanSourceOwner);

    const objectKey = `${objectType}:${identity}`;
    if (seenKeys.has(objectKey)) {
      fail('DUPLICATE_INVENTORY_OBJECT', `duplicate object in inventory: '${objectType}' '${identity}'`);
    }
    seenKeys.add(objectKey);
  }

  return { items: inventoryData, sourceOwners };
}

/**
 * Validates target inventory JSON data and rejects duplicates (P2-01).
 */
export function validateTargetInventory(targetInventoryData) {
  if (!Array.isArray(targetInventoryData)) {
    fail('INVALID_TARGET_INVENTORY', 'target inventory must be a JSON array of object entries');
  }

  const seenKeys = new Set();
  const targetObjectMap = new Map();

  for (let i = 0; i < targetInventoryData.length; i++) {
    const item = targetInventoryData[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('INVALID_TARGET_INVENTORY', `target entry at index ${i} is not a valid JSON object`);
    }

    const { objectType, identity } = item;
    if (typeof objectType !== 'string' || !SUPPORTED_OBJECT_TYPES.has(objectType)) {
      fail('UNSUPPORTED_OBJECT_TYPE', `unsupported object type '${objectType}' in target inventory at index ${i}. Fail closed.`);
    }

    if (typeof identity !== 'string' || identity.trim().length === 0) {
      fail('INVALID_TARGET_INVENTORY', `missing or empty identity in target inventory at index ${i}`);
    }

    const owner = item.currentOwner || item.sourceOwner || item.owner;
    if (typeof owner !== 'string' || owner.trim().length === 0) {
      fail('INVALID_TARGET_INVENTORY', `missing or empty owner for '${identity}' in target inventory at index ${i}`);
    }

    // Validate identity syntax
    parseObjectIdentity(objectType, identity);
    const cleanOwner = validateRoleIdentifier(owner, 'targetOwner');
    item.currentOwner = cleanOwner;

    const objectKey = `${objectType}:${identity}`;
    if (seenKeys.has(objectKey)) {
      fail('DUPLICATE_TARGET_OBJECT', `duplicate object in target inventory: '${objectType}' '${identity}'`);
    }
    seenKeys.add(objectKey);
    targetObjectMap.set(objectKey, cleanOwner);
  }

  return { items: targetInventoryData, targetObjectMap };
}

/**
 * Validates a routine entry structure in routine catalogs (P1-01).
 */
export function validateRoutineEntry(routine, label = 'routine') {
  if (!routine || typeof routine !== 'object' || Array.isArray(routine)) {
    fail('MALFORMED_ROUTINE_ENTRY', `${label} entry is not a valid JSON object`);
  }

  const { identity, owner, securityDefiner, config, acl } = routine;
  if (typeof identity !== 'string' || identity.trim().length === 0) {
    fail('MALFORMED_ROUTINE_ENTRY', `${label} entry has missing or invalid identity`);
  }

  parseRoutineIdentity(identity);

  if (typeof owner !== 'string' || owner.trim().length === 0) {
    fail('MALFORMED_ROUTINE_ENTRY', `${label} entry '${identity}' has missing or invalid owner`);
  }
  const cleanRoutineOwner = validateRoleIdentifier(owner, 'routine owner');
  routine.owner = cleanRoutineOwner;

  if (typeof securityDefiner !== 'boolean') {
    fail('MALFORMED_ROUTINE_ENTRY', `${label} entry '${identity}' has non-boolean securityDefiner`);
  }

  if (config !== null && config !== undefined && !Array.isArray(config) && typeof config !== 'string') {
    fail('MALFORMED_ROUTINE_ENTRY', `${label} entry '${identity}' has invalid proconfig format`);
  }

  if (acl !== null && acl !== undefined && typeof acl !== 'string') {
    fail('MALFORMED_ROUTINE_ENTRY', `${label} entry '${identity}' has invalid acl format`);
  }

  return routine;
}

/**
 * Strict validator for project metadata identifiers (sourceProjectRef, target, etc.) (R2-P1-01).
 * Rejects CR, LF, CRLF, NUL, control characters, Unicode line breaks, semicolons, comments, and SQL keywords.
 */
export function validateMetadataIdentifier(value, fieldName = 'metadata') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const errCode = fieldName === 'sourceProjectRef' ? 'INVALID_PROJECT_REF' : fieldName === 'target' ? 'INVALID_TARGET' : `INVALID_${fieldName.toUpperCase()}`;
    fail(errCode, `${fieldName} must be a non-empty string`);
  }

  // Reject CR, LF, CRLF, NUL, control characters, and Unicode line/paragraph separators
  // \u2028 (Line Separator), \u2029 (Paragraph Separator), \u0085 (Next Line), \u000B (VT), \u000C (FF)
  if (/[\r\n\0\u2028\u2029\u0085\x00-\x1F\x7F-\x9F]/.test(value)) {
    fail('SQL_INJECTION_DETECTED', `${fieldName} contains illegal line separator, control character, or null byte`);
  }

  // Reject SQL terminators, comments, and quotes
  if (
    value.includes(';') ||
    value.includes('--') ||
    value.includes('/*') ||
    value.includes("'") ||
    value.includes('"') ||
    value.includes('`')
  ) {
    fail('SQL_INJECTION_DETECTED', `${fieldName} contains illegal SQL punctuation or comment characters`);
  }

  const trimmed = value.trim();
  // Valid identifier contract: alphanumeric with dashes, underscores, and dots, max 128 chars
  if (!/^[a-zA-Z0-9_\-\.]{1,128}$/.test(trimmed)) {
    const errCode = fieldName === 'sourceProjectRef' ? 'INVALID_PROJECT_REF' : fieldName === 'target' ? 'INVALID_TARGET' : `INVALID_${fieldName.toUpperCase()}`;
    fail(errCode, `${fieldName} '${value}' does not match permitted contract format /^[a-zA-Z0-9_\\-\\.]+$/`);
  }

  const upper = trimmed.toUpperCase();
  if (
    upper.includes('DROP') ||
    upper.includes('ALTER') ||
    upper.includes('CREATE') ||
    upper.includes('SELECT') ||
    upper.includes('INSERT') ||
    upper.includes('DELETE') ||
    upper.includes('UPDATE') ||
    upper.includes('GRANT') ||
    upper.includes('REVOKE')
  ) {
    fail('SQL_INJECTION_DETECTED', `${fieldName} contains prohibited SQL keyword`);
  }

  return trimmed;
}

/**
 * Parses and validates routine arguments token inside routine ALTER statement.
 */
function parseRoutineArgsToken(line, startIndex, lineIndex) {
  let i = startIndex;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i >= line.length || line[i] !== '(') {
    fail('UNAUTHORIZED_STATEMENT', `expected '(' for routine arguments at line ${lineIndex}`);
  }

  const openParen = i;
  i++;
  let depth = 1;
  let inString = false;
  let inQuotes = false;

  while (i < line.length) {
    const ch = line[i];
    if (ch === '\0') fail('SQL_INJECTION_DETECTED', `null byte in routine arguments at line ${lineIndex}`);

    if (inString) {
      if (ch === "'") {
        if (i + 1 < line.length && line[i + 1] === "'") {
          i += 2;
        } else {
          inString = false;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    // Prohibit statement terminators and comment delimiters in routine arguments
    if (ch === ';') {
      fail('SQL_INJECTION_DETECTED', `semicolon in routine arguments at line ${lineIndex}`);
    }
    if (ch === '-' && i + 1 < line.length && line[i + 1] === '-') {
      fail('SQL_INJECTION_DETECTED', `line comment '--' in routine arguments at line ${lineIndex}`);
    }
    if (ch === '/' && i + 1 < line.length && line[i + 1] === '*') {
      fail('SQL_INJECTION_DETECTED', `block comment '/*' in routine arguments at line ${lineIndex}`);
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const args = line.slice(openParen + 1, i).trim();
        return { args, endIndex: i + 1 };
      }
    }
    i++;
  }

  fail('UNAUTHORIZED_STATEMENT', `unclosed parentheses in routine arguments at line ${lineIndex}`);
}

const ALLOWED_OBJECT_TYPE_TOKENS = Object.freeze([
  'SCHEMA',
  'TABLE',
  'PARTITIONED TABLE',
  'FOREIGN TABLE',
  'SEQUENCE',
  'VIEW',
  'MATERIALIZED VIEW',
  'TYPE',
  'DOMAIN',
  'FUNCTION',
  'PROCEDURE',
]);

/**
 * Strictly parses and validates a single ALTER ... OWNER TO statement line (R3-P1-01).
 * Rejects inline statement chaining, comment delimiters, psql meta-commands, and trailing tokens.
 */
function validateAlterStatementLine(rawLine, lineIndex) {
  const line = rawLine.trim();

  // Reject psql meta-commands
  if (line.startsWith('\\')) {
    fail('UNAUTHORIZED_STATEMENT', `prohibited psql meta-command at line ${lineIndex}: ${line}`);
  }

  // Reject line comments or block comments anywhere on statement line
  if (line.includes('--') || line.includes('/*') || line.includes('*/')) {
    fail('SQL_INJECTION_DETECTED', `prohibited comment token in statement at line ${lineIndex}`);
  }

  // Must start with ALTER (case-insensitive, followed by whitespace)
  if (!/^ALTER\s+/i.test(line)) {
    fail('UNAUTHORIZED_STATEMENT', `statement must begin with ALTER at line ${lineIndex}: ${line}`);
  }

  let pos = 5; // after "ALTER"
  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos++;

  // Match object type against strict allowlist (sorted by descending length)
  let matchedType = null;
  const sortedTypes = [...ALLOWED_OBJECT_TYPE_TOKENS].sort((a, b) => b.length - a.length);
  for (const t of sortedTypes) {
    const sub = line.slice(pos, pos + t.length);
    if (sub.toUpperCase() === t) {
      const nextChar = line[pos + t.length];
      if (nextChar === ' ' || nextChar === '\t') {
        matchedType = t;
        pos += t.length;
        break;
      }
    }
  }

  if (!matchedType) {
    fail('UNAUTHORIZED_STATEMENT', `unauthorized or unsupported object type in statement at line ${lineIndex}: ${line}`);
  }

  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos++;

  // Parse object identity
  if (matchedType === 'SCHEMA') {
    const ident = parseIdentifierToken(line, pos);
    if (!ident) fail('UNAUTHORIZED_STATEMENT', `invalid schema identifier at line ${lineIndex}`);
    pos = ident.endIndex;
  } else if (matchedType === 'FUNCTION' || matchedType === 'PROCEDURE') {
    const schemaIdent = parseIdentifierToken(line, pos);
    if (!schemaIdent) fail('UNAUTHORIZED_STATEMENT', `invalid routine schema identifier at line ${lineIndex}`);
    pos = schemaIdent.endIndex;
    if (pos >= line.length || line[pos] !== '.') {
      fail('UNAUTHORIZED_STATEMENT', `missing dot separator in routine identity at line ${lineIndex}`);
    }
    pos++; // skip '.'
    const nameIdent = parseIdentifierToken(line, pos);
    if (!nameIdent) fail('UNAUTHORIZED_STATEMENT', `invalid routine name identifier at line ${lineIndex}`);
    pos = nameIdent.endIndex;
    const routineArgs = parseRoutineArgsToken(line, pos, lineIndex);
    pos = routineArgs.endIndex;
  } else {
    const schemaIdent = parseIdentifierToken(line, pos);
    if (!schemaIdent) fail('UNAUTHORIZED_STATEMENT', `invalid schema identifier at line ${lineIndex}`);
    pos = schemaIdent.endIndex;
    if (pos >= line.length || line[pos] !== '.') {
      fail('UNAUTHORIZED_STATEMENT', `missing dot separator in object identity at line ${lineIndex}`);
    }
    pos++; // skip '.'
    const nameIdent = parseIdentifierToken(line, pos);
    if (!nameIdent) fail('UNAUTHORIZED_STATEMENT', `invalid object name identifier at line ${lineIndex}`);
    pos = nameIdent.endIndex;
  }

  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos++;

  // Match "OWNER"
  if (line.slice(pos, pos + 5).toUpperCase() !== 'OWNER') {
    fail('UNAUTHORIZED_STATEMENT', `expected 'OWNER' keyword at line ${lineIndex}`);
  }
  pos += 5;
  if (pos >= line.length || (line[pos] !== ' ' && line[pos] !== '\t')) {
    fail('UNAUTHORIZED_STATEMENT', `expected whitespace after OWNER at line ${lineIndex}`);
  }
  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos++;

  // Match "TO"
  if (line.slice(pos, pos + 2).toUpperCase() !== 'TO') {
    fail('UNAUTHORIZED_STATEMENT', `expected 'TO' keyword at line ${lineIndex}`);
  }
  pos += 2;
  if (pos >= line.length || (line[pos] !== ' ' && line[pos] !== '\t')) {
    fail('UNAUTHORIZED_STATEMENT', `expected whitespace after TO at line ${lineIndex}`);
  }
  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos++;

  // Parse role identifier
  const roleIdent = parseIdentifierToken(line, pos);
  if (!roleIdent) fail('UNAUTHORIZED_STATEMENT', `invalid target role identifier at line ${lineIndex}`);
  validateRoleIdentifier(roleIdent.quoted ? `"${roleIdent.name.replace(/"/g, '""')}"` : roleIdent.name, 'target role', { isSqlToken: true });
  pos = roleIdent.endIndex;

  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos++;

  // Expect exact semicolon ';'
  if (pos >= line.length || line[pos] !== ';') {
    fail('UNAUTHORIZED_STATEMENT', `expected semicolon ';' at end of statement at line ${lineIndex}`);
  }
  pos++; // skip ';'

  // After semicolon, strictly no trailing characters (only whitespace)
  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos++;
  if (pos < line.length) {
    fail('UNAUTHORIZED_STATEMENT', `unexpected trailing characters after statement at line ${lineIndex}: ${line.slice(pos)}`);
  }

  return true;
}

/**
 * Validates generated plan SQL grammar and rejects unauthorized statements (R2-P1-01, R3-P1-01).
 * Enforces BEGIN; followed by ALTER ... OWNER TO statements only, followed by COMMIT;.
 * Strictly parses identifiers, quotes, and arguments to prevent inline statement chaining and comment bypasses.
 */
export function validatePlanSqlGrammar(sqlText) {
  if (typeof sqlText !== 'string' || sqlText.length === 0) {
    fail('INVALID_PLAN_SQL', 'plan SQL must be a non-empty string');
  }

  if (sqlText.includes('\0')) {
    fail('SQL_INJECTION_DETECTED', 'null byte detected in plan SQL');
  }

  // Reject Unicode line/paragraph separators and ASCII control characters
  if (/[\u2028\u2029\u0085\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(sqlText)) {
    fail('SQL_INJECTION_DETECTED', 'illegal control character or Unicode line separator detected in plan SQL');
  }

  // Normalize CRLF to LF, and reject any stray CR
  const normalized = sqlText.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) {
    fail('SQL_INJECTION_DETECTED', 'stray carriage return detected in plan SQL');
  }

  const lines = normalized.split('\n');
  let hasBegin = false;
  let hasCommit = false;
  let alterCount = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    // Reject psql meta-commands
    if (trimmed.startsWith('\\')) {
      fail('UNAUTHORIZED_STATEMENT', `prohibited psql meta-command at line ${idx + 1}`);
    }

    // Comment line: must start with --
    if (trimmed.startsWith('--')) {
      if (trimmed.includes(';')) {
        fail('SQL_INJECTION_DETECTED', `semicolon found in SQL comment at line ${idx + 1}`);
      }
      if (trimmed.includes('/*') || trimmed.includes('*/')) {
        fail('SQL_INJECTION_DETECTED', `block comment found in SQL comment at line ${idx + 1}`);
      }
      continue;
    }

    if (trimmed === 'BEGIN;') {
      if (hasBegin) {
        fail('UNAUTHORIZED_STATEMENT', `duplicate BEGIN statement at line ${idx + 1}`);
      }
      hasBegin = true;
      continue;
    }

    if (trimmed === 'COMMIT;') {
      if (!hasBegin) {
        fail('UNAUTHORIZED_STATEMENT', `COMMIT statement before BEGIN at line ${idx + 1}`);
      }
      hasCommit = true;
      continue;
    }

    if (!hasBegin || hasCommit) {
      fail('UNAUTHORIZED_STATEMENT', `statement outside BEGIN/COMMIT block at line ${idx + 1}: ${trimmed}`);
    }

    // Parse and strictly validate ALTER statement line
    validateAlterStatementLine(trimmed, idx + 1);
    alterCount++;
  }

  if (!hasBegin || !hasCommit) {
    fail('INVALID_PLAN_SQL', 'plan SQL missing required BEGIN; or COMMIT; boundary');
  }

  return { alterCount };
}

/**
 * Validates owner-map JSON data.
 */
export function validateOwnerMap(mapData, expectedProjectRef = null, expectedTarget = null) {
  if (!mapData || typeof mapData !== 'object' || Array.isArray(mapData)) {
    fail('INVALID_OWNER_MAP', 'owner map must be a JSON object');
  }

  if (mapData.format !== OWNER_MAP_FORMAT) {
    fail('INVALID_FORMAT', `owner map format must be '${OWNER_MAP_FORMAT}', received: '${mapData.format}'`);
  }

  if (typeof mapData.sourceProjectRef !== 'string' || mapData.sourceProjectRef.trim().length === 0) {
    fail('INVALID_PROJECT_REF', 'owner map sourceProjectRef must be a non-empty string');
  }
  const cleanSourceRef = validateMetadataIdentifier(mapData.sourceProjectRef, 'sourceProjectRef');
  mapData.sourceProjectRef = cleanSourceRef;
  if (expectedProjectRef) {
    validateMetadataIdentifier(expectedProjectRef, 'sourceProjectRef');
    if (cleanSourceRef !== expectedProjectRef) {
      fail('PROJECT_REF_MISMATCH', `source project ref mismatch: expected '${expectedProjectRef}', got '${cleanSourceRef}'`);
    }
  }

  if (typeof mapData.target !== 'string' || mapData.target.trim().length === 0) {
    fail('INVALID_TARGET', 'owner map target must be a non-empty string');
  }
  const cleanTargetRef = validateMetadataIdentifier(mapData.target, 'target');
  mapData.target = cleanTargetRef;
  if (expectedTarget) {
    validateMetadataIdentifier(expectedTarget, 'target');
    if (cleanTargetRef !== expectedTarget) {
      fail('TARGET_IDENTITY_MISMATCH', `target identity mismatch: expected '${expectedTarget}', got '${cleanTargetRef}'`);
    }
  }

  if (!Array.isArray(mapData.mappings) || mapData.mappings.length === 0) {
    fail('INVALID_MAPPINGS', 'owner map mappings must be a non-empty array');
  }

  const seenSourceOwners = new Set();
  const mappingMap = new Map(); // sourceOwner -> targetOwner

  for (let i = 0; i < mapData.mappings.length; i++) {
    const m = mapData.mappings[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      fail('INVALID_MAPPINGS', `mapping entry at index ${i} is not a valid object`);
    }

    const { sourceOwner, targetOwner, reason, approvedBy } = m;

    if (typeof sourceOwner !== 'string' || sourceOwner.trim().length === 0) {
      fail('INVALID_MAPPINGS', `missing or empty sourceOwner in mapping at index ${i}`);
    }
    const cleanSource = validateRoleIdentifier(sourceOwner, 'sourceOwner');
    m.sourceOwner = cleanSource;

    if (typeof targetOwner !== 'string' || targetOwner.trim().length === 0) {
      fail('INVALID_MAPPINGS', `missing or empty targetOwner in mapping at index ${i}`);
    }
    const cleanTarget = validateRoleIdentifier(targetOwner, 'targetOwner');
    m.targetOwner = cleanTarget;

    if (typeof reason !== 'string' || reason.trim().length === 0) {
      fail('INVALID_MAPPINGS', `missing or empty reason for mapping '${cleanSource}' at index ${i}`);
    }

    if (typeof approvedBy !== 'string' || approvedBy.trim().length === 0) {
      fail('INVALID_MAPPINGS', `missing or empty approvedBy for mapping '${cleanSource}' at index ${i}`);
    }

    if (seenSourceOwners.has(cleanSource)) {
      fail('DUPLICATE_OWNER_MAPPING', `duplicate mapping for source owner '${cleanSource}' at index ${i}`);
    }
    seenSourceOwners.add(cleanSource);
    mappingMap.set(cleanSource, cleanTarget);
  }

  return { mapData, mappingMap };
}

/**
 * Extracts set of role names from various role inventory structures.
 */
export function extractRoleNames(rolesData) {
  if (rolesData instanceof Set) {
    return rolesData;
  }

  const mapItem = (r) => {
    if (!r) return null;
    const raw = typeof r === 'string' ? r.trim() : typeof (r.rolname || r.name) === 'string' ? (r.rolname || r.name).trim() : null;
    return raw ? validateRoleIdentifier(raw, 'targetRole') : null;
  };

  if (Array.isArray(rolesData)) {
    return new Set(rolesData.map(mapItem).filter(Boolean));
  }

  if (rolesData && typeof rolesData === 'object' && Array.isArray(rolesData.roles)) {
    return new Set(rolesData.roles.map(mapItem).filter(Boolean));
  }

  fail('INVALID_ROLES_INVENTORY', 'roles inventory must be a JSON array or object containing roles array');
}

/**
 * Reconciles source owners in inventory with approved mappings and target roles.
 */
export function reconcileOwnerMappings(inventorySourceOwners, mappingMap, targetRolesSet = null) {
  // 1. Every source owner in inventory must have exactly one approved mapping
  for (const src of inventorySourceOwners) {
    if (!mappingMap.has(src)) {
      fail('MISSING_OWNER_MAPPING', `missing approved mapping for source owner: '${src}'`);
    }
  }

  // 2. Reject unknown source owners in mapping that do not exist in inventory
  for (const src of mappingMap.keys()) {
    if (!inventorySourceOwners.has(src)) {
      fail('UNKNOWN_SOURCE_OWNER', `unknown source owner in mapping: '${src}' does not exist in source inventory`);
    }
  }

  // 3. Target role existence check (if target roles set is provided)
  if (targetRolesSet) {
    for (const [src, tgt] of mappingMap.entries()) {
      if (!targetRolesSet.has(tgt)) {
        fail('NONEXISTENT_TARGET_ROLE', `target owner '${tgt}' for source '${src}' does not exist on target database`);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Isolated Local Target Check & Environment Sanitization (P1-02)
// -----------------------------------------------------------------------------

/**
 * Strips all libpq connection overrides from process environment
 * to ensure child processes never inherit unexpected remote endpoints.
 */
export function getSanitizedChildEnv(env = process.env) {
  const clean = { ...env };
  delete clean.PGHOST;
  delete clean.PGHOSTADDR;
  delete clean.PGSERVICE;
  delete clean.PGSERVICEFILE;
  delete clean.PGDATABASE;
  delete clean.PGPORT;
  delete clean.PGUSER;
  delete clean.PGPASSFILE;
  delete clean.PGREQUIRESSL;
  delete clean.PGSSLMODE;
  return clean;
}

export function isLocalEndpoint(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase().trim();
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]'
  );
}

/**
 * Rigorously parses and validates a Docker daemon endpoint (R2-P1-02).
 * Allows only verified local Unix sockets, Windows named pipes, and TCP loopbacks (127.0.0.1, localhost, ::1).
 * Rejects remote hosts, non-loopback IPs (e.g. 127.0.0.1.evil.example), SSH endpoints, and unparseable strings.
 */
export function parseAndValidateDockerEndpoint(rawEndpoint) {
  if (!rawEndpoint || typeof rawEndpoint !== 'string' || rawEndpoint.trim().length === 0) {
    return { isLocal: false, reason: 'empty endpoint' };
  }
  const ep = rawEndpoint.trim();

  // 1. Unix socket
  if (ep.startsWith('unix://')) {
    const sockPath = ep.slice('unix://'.length);
    if (!sockPath.startsWith('/') && !sockPath.startsWith('.')) {
      return { isLocal: false, reason: 'invalid unix socket path' };
    }
    return { isLocal: true, type: 'unix', path: sockPath };
  }
  if (ep.startsWith('/') && (ep.endsWith('.sock') || ep.includes('/docker'))) {
    return { isLocal: true, type: 'unix', path: ep };
  }

  // 2. Windows named pipe
  if (ep.startsWith('npipe://')) {
    const pipePath = ep.slice('npipe://'.length);
    if (pipePath.startsWith('//./pipe/') || pipePath.startsWith('\\\\.\\pipe\\')) {
      return { isLocal: true, type: 'npipe', path: pipePath };
    }
    return { isLocal: false, reason: 'invalid named pipe path' };
  }
  if (ep.startsWith('//./pipe/') || ep.startsWith('\\\\.\\pipe\\')) {
    return { isLocal: true, type: 'npipe', path: ep };
  }

  // 3. Reject ssh://
  if (ep.startsWith('ssh://')) {
    return { isLocal: false, reason: 'ssh docker endpoint is remote' };
  }

  // 4. TCP / HTTP loopback
  if (ep.startsWith('tcp://') || ep.startsWith('http://') || ep.startsWith('https://')) {
    try {
      const url = new URL(ep.replace(/^tcp:/i, 'http:'));
      const hostname = url.hostname.toLowerCase();
      // Only strictly loopback hostnames / IPs
      if (
        hostname === '127.0.0.1' ||
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname === '[::1]'
      ) {
        return { isLocal: true, type: 'tcp', hostname, port: url.port };
      }
      return { isLocal: false, reason: `hostname '${hostname}' is not a local loopback` };
    } catch {
      return { isLocal: false, reason: 'malformed tcp/http URL' };
    }
  }

  return { isLocal: false, reason: `unsupported scheme in endpoint '${rawEndpoint}'` };
}

/**
 * Sanitizes and prepares environment variables for Docker CLI child processes.
 * Ensures properties explicitly set to undefined are pruned rather than passed.
 */
function buildDockerExecEnv(env) {
  const execEnv = { ...process.env, ...env };
  for (const key of Object.keys(execEnv)) {
    if (execEnv[key] === undefined) {
      delete execEnv[key];
    }
  }
  return execEnv;
}

/**
 * Resolves the active Docker config directory root (R5.3 Finding P1-B, R5.4 Finding P1).
 * Strictly honors DOCKER_CONFIG if provided, preserving path fidelity (no trimming of whitespace).
 * Defaults to HOME/.docker only when DOCKER_CONFIG is unset or empty string.
 * Never silently falls back to HOME when DOCKER_CONFIG is specified.
 */
export function getDockerConfigRoot(env = process.env) {
  if (env.DOCKER_CONFIG !== undefined && env.DOCKER_CONFIG !== null) {
    const rawConfig = String(env.DOCKER_CONFIG);
    if (rawConfig !== '') {
      return {
        path: path.resolve(rawConfig),
        isCustom: true,
      };
    }
  }
  const homeDir = env.HOME !== undefined && env.HOME !== null && String(env.HOME) !== ''
    ? String(env.HOME)
    : (process.env.HOME || os.homedir());
  if (!homeDir || typeof homeDir !== 'string' || homeDir === '') {
    return {
      path: null,
      isCustom: false,
      error: 'NO_HOME_DIR',
    };
  }
  return {
    path: path.join(homeDir, '.docker'),
    isCustom: false,
  };
}

/**
 * Resolves the actual daemon endpoint of a Docker context (R2-P1-02, R5.3 Finding P1-B).
 * Reads context metadata from the active config root or queries CLI inspect without trusting the context name.
 */
export function resolveDockerContextEndpoint(contextName, { contextInspector, env = process.env } = {}) {
  if (!contextName || typeof contextName !== 'string') return null;

  const trimmed = contextName.trim();
  // Reject flag-like names or illegal characters to prevent CLI option injection (R3-P3-01)
  if (trimmed.length === 0 || trimmed.startsWith('-') || !/^[a-zA-Z0-9_\-\.]+$/.test(trimmed)) {
    return null;
  }

  // Custom/mock context inspector (injected for tests)
  if (typeof contextInspector === 'function') {
    return contextInspector(trimmed);
  }

  const configRoot = getDockerConfigRoot(env);
  if (configRoot.error || !configRoot.path) {
    return null;
  }

  if (configRoot.isCustom && !fs.existsSync(configRoot.path)) {
    return null;
  }

  // 1. Try reading context metadata from configRoot/contexts/meta/ directly
  try {
    const metaDir = path.join(configRoot.path, 'contexts', 'meta');
    if (fs.existsSync(metaDir)) {
      const entries = fs.readdirSync(metaDir);
      for (const entry of entries) {
        try {
          const entryPath = path.join(metaDir, entry);
          const stat = fs.statSync(entryPath);
          let metaFilePath = null;
          if (stat.isFile()) {
            metaFilePath = entryPath;
          } else if (stat.isDirectory()) {
            const candidate = path.join(entryPath, 'meta.json');
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              metaFilePath = candidate;
            }
          }

          if (metaFilePath) {
            const content = fs.readFileSync(metaFilePath, 'utf8');
            const data = JSON.parse(content);
            if (data.Name === trimmed && data.Endpoints?.docker?.Host) {
              return data.Endpoints.docker.Host;
            }
          }
        } catch {
          // ignore corrupted single entry
        }
      }
    }
  } catch {
    // fallback to CLI
  }

  // 2. Try docker context inspect via CLI with explicit argument separator '--'
  try {
    const execEnv = buildDockerExecEnv(env);
    const stdout = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', '--', trimmed], {
      env: execEnv,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ep = stdout.trim();
    if (ep.length > 0) return ep;
  } catch {
    // unable to resolve
  }

  return null;
}

/**
 * Resolves the effective Docker endpoint following Docker CLI precedence (R5.3 Finding P1-A & P1-B).
 * Precedence:
 * 1. DOCKER_CONTEXT environment variable (overrides DOCKER_HOST and active context)
 * 2. DOCKER_HOST environment variable (if DOCKER_CONTEXT is not set or empty)
 * 3. Default/active context (configured via DOCKER_CONFIG/config.json, docker context show, or HOME/.docker)
 */
export function resolveEffectiveDockerEndpoint({ env = process.env, contextInspector, activeContextResolver } = {}) {
  // 1. DOCKER_CONTEXT environment variable (highest precedence in Docker CLI)
  if (env.DOCKER_CONTEXT !== undefined && env.DOCKER_CONTEXT !== null && String(env.DOCKER_CONTEXT).trim().length > 0) {
    const contextName = String(env.DOCKER_CONTEXT).trim();
    if (contextName.startsWith('-') || !/^[a-zA-Z0-9_\-\.]+$/.test(contextName)) {
      return {
        source: 'DOCKER_CONTEXT',
        context: contextName,
        rawEndpoint: null,
        error: 'INVALID_CONTEXT_NAME',
      };
    }
    const endpoint = resolveDockerContextEndpoint(contextName, { contextInspector, env });
    return {
      source: 'DOCKER_CONTEXT',
      context: contextName,
      rawEndpoint: endpoint,
    };
  }

  // 2. DOCKER_HOST environment variable (evaluated only if DOCKER_CONTEXT is not set)
  if (env.DOCKER_HOST !== undefined && env.DOCKER_HOST !== null && String(env.DOCKER_HOST).trim().length > 0) {
    return {
      source: 'DOCKER_HOST',
      context: null,
      rawEndpoint: String(env.DOCKER_HOST).trim(),
    };
  }

  // 3. Active/default context (evaluated when neither DOCKER_CONTEXT nor DOCKER_HOST is set)
  let contextName = null;
  if (typeof activeContextResolver === 'function') {
    contextName = activeContextResolver();
  } else {
    const configRoot = getDockerConfigRoot(env);
    if (configRoot.error || !configRoot.path) {
      return {
        source: 'DEFAULT_CONTEXT',
        context: null,
        rawEndpoint: null,
        error: configRoot.error || 'UNRESOLVABLE_CONFIG_ROOT',
      };
    }

    if (configRoot.isCustom) {
      if (!fs.existsSync(configRoot.path)) {
        return {
          source: 'DEFAULT_CONTEXT',
          context: null,
          rawEndpoint: null,
          error: 'DOCKER_CONFIG_DIR_NOT_FOUND',
        };
      }
    }

    const configPath = path.join(configRoot.path, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const rawContent = fs.readFileSync(configPath, 'utf8');
        const configJson = JSON.parse(rawContent);
        if (configJson.currentContext && typeof configJson.currentContext === 'string' && configJson.currentContext.trim().length > 0) {
          contextName = configJson.currentContext.trim();
        }
      } catch {
        return {
          source: 'DEFAULT_CONTEXT',
          context: null,
          rawEndpoint: null,
          error: 'CORRUPTED_DOCKER_CONFIG_JSON',
        };
      }
    }

    if (!contextName) {
      try {
        const execEnv = buildDockerExecEnv(env);
        const stdout = execFileSync('docker', ['context', 'show'], {
          env: execEnv,
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const trimmed = stdout.trim();
        if (trimmed.length > 0) {
          contextName = trimmed;
        }
      } catch {
        // Unable to resolve via CLI
      }
    }

    if (!contextName) {
      return {
        source: 'DEFAULT_CONTEXT',
        context: null,
        rawEndpoint: null,
        error: 'ACTIVE_CONTEXT_UNRESOLVABLE',
      };
    }
  }

  if (contextName && (contextName.startsWith('-') || !/^[a-zA-Z0-9_\-\.]+$/.test(contextName))) {
    return {
      source: 'DEFAULT_CONTEXT',
      context: contextName,
      rawEndpoint: null,
      error: 'INVALID_CONTEXT_NAME',
    };
  }

  const endpoint = resolveDockerContextEndpoint(contextName, { contextInspector, env });
  return {
    source: 'DEFAULT_CONTEXT',
    context: contextName,
    rawEndpoint: endpoint,
  };
}

/**
 * Enforces local-only database boundaries across container and direct psql modes.
 * Validates inherited PostgreSQL/Docker environment variables and rejects remote targets.
 */
export function validateTargetIsolation(targetOrOptions) {
  let opts;
  if (typeof targetOrOptions === 'string') {
    if (APPROVED_CONTAINERS.has(targetOrOptions)) {
      opts = { dbContainer: targetOrOptions, env: process.env };
    } else {
      opts = { dbHost: targetOrOptions, env: process.env };
    }
  } else {
    opts = targetOrOptions || {};
  }

  const { dbContainer = null, dbHost = null, env = process.env } = opts;

  // 1. Conflicting connection options
  if (dbContainer && dbHost) {
    fail('CONFLICTING_CONNECTION_OPTIONS', 'cannot specify both --db-container and --db-host; ambiguous connection target');
  }

  // 2. Validate inherited environment variables
  if (env.PGHOST && !isLocalEndpoint(env.PGHOST)) {
    fail('REMOTE_TARGET_BLOCKED', `remote PGHOST blocked: '${env.PGHOST}'. Only local rehearsal stack (127.0.0.1 / localhost) is permitted.`);
  }

  if (env.PGHOSTADDR) {
    const addr = env.PGHOSTADDR.toLowerCase().trim();
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '[::1]') {
      fail('REMOTE_TARGET_BLOCKED', `remote PGHOSTADDR blocked: '${env.PGHOSTADDR}'. Only local rehearsal stack is permitted.`);
    }
  }

  if (env.PGSERVICE || env.PGSERVICEFILE) {
    fail('REMOTE_TARGET_BLOCKED', 'PGSERVICE / PGSERVICEFILE connection configuration is blocked for rehearsal isolation security');
  }

  // Docker endpoint validation (follows Docker CLI precedence: DOCKER_CONTEXT > DOCKER_HOST > active context)
  if (dbContainer || (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT.trim().length > 0) || (env.DOCKER_HOST && env.DOCKER_HOST.trim().length > 0)) {
    const effective = resolveEffectiveDockerEndpoint({
      env,
      contextInspector: opts.contextInspector,
      activeContextResolver: opts.activeContextResolver,
    });

    if (effective.error) {
      fail('REMOTE_DOCKER_CONTEXT_BLOCKED', `unable to verify Docker endpoint due to ${effective.error}. Fail closed.`);
    }

    if (!effective.rawEndpoint) {
      const label = effective.source === 'DOCKER_CONTEXT' ? `DOCKER_CONTEXT '${effective.context}'` : (effective.context ? `Docker context '${effective.context}'` : 'Docker daemon');
      fail('REMOTE_DOCKER_CONTEXT_BLOCKED', `unable to verify actual endpoint for ${label}. Fail closed.`);
    }

    const epResult = parseAndValidateDockerEndpoint(effective.rawEndpoint);
    if (!epResult.isLocal) {
      if (effective.source === 'DOCKER_HOST') {
        fail('REMOTE_DOCKER_HOST_BLOCKED', `remote DOCKER_HOST blocked: '${effective.rawEndpoint}'. Only local Docker daemon is permitted. (${epResult.reason})`);
      } else {
        fail('REMOTE_DOCKER_CONTEXT_BLOCKED', `remote Docker context '${effective.context}' blocked: actual endpoint '${effective.rawEndpoint}' is not local. (${epResult.reason})`);
      }
    }
  }

  // 3. For Docker mode: container must be in approved allowlist
  if (dbContainer) {
    if (!APPROVED_CONTAINERS.has(dbContainer)) {
      fail('UNAPPROVED_CONTAINER', `container '${dbContainer}' is not in approved local rehearsal allowlist: ${[...APPROVED_CONTAINERS].join(', ')}`);
    }
    return;
  }

  // 4. For direct psql mode: cannot treat omitted host as local!
  if (!dbHost) {
    fail('MISSING_TARGET_ENDPOINT', 'direct psql execution requires explicit local --db-host (e.g. 127.0.0.1) or --db-container; omitted host cannot be assumed local');
  }

  if (!isLocalEndpoint(dbHost)) {
    fail('REMOTE_TARGET_BLOCKED', `remote target blocked: '${dbHost}'. Only local rehearsal stack (127.0.0.1 / localhost) is permitted.`);
  }
}

/**
 * Verifies database-side rehearsal sentinel identity (P1-02, P2-04).
 */
export async function verifyDatabaseTargetIdentity({
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
  expectedTarget = DEFAULT_TARGET_IDENTITY,
  executeSql = executeSqlAgainstDatabase,
  env = process.env,
}) {
  // Re-run the isolation gate before any injected executor is invoked so a
  // caller-provided executor can never bypass local-only target enforcement.
  validateTargetIsolation({ dbContainer, dbHost, env });

  const sql = `
SELECT json_build_object(
  'version_num', current_setting('server_version_num')::integer,
  'database', current_database(),
  'rehearsal_sentinel', current_setting('crm.rehearsal_identity', true),
  'has_marker_table', EXISTS(
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND (table_name = '_crm_disposable_test_marker' OR table_name = '_crm_rehearsal_sentinel')
  ),
  'db_comment', coalesce((SELECT description FROM pg_shdescription s JOIN pg_database d ON d.oid = s.objoid WHERE d.datname = current_database()), '')
)::text;
`;

  const { stdout } = await executeSql({
    sqlText: sql,
    dbContainer,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    tuplesOnly: true,
    env,
  });

  const parsed = JSON.parse(stdout.trim());
  const sentinel = parsed.rehearsal_sentinel || '';
  const comment = parsed.db_comment || '';
  const hasMarkerTable = Boolean(parsed.has_marker_table);

  const matched =
    sentinel === expectedTarget ||
    comment.includes(expectedTarget) ||
    (expectedTarget === 'crm-restore-rehearsal' && hasMarkerTable) ||
    (expectedTarget === 'crm-restore-rehearsal' && comment.includes('disposable-test'));

  if (!matched) {
    fail(
      'DATABASE_IDENTITY_VERIFICATION_FAILED',
      `database-side rehearsal sentinel verification failed: expected target '${expectedTarget}', but target database sentinel was '${sentinel || comment || 'unmarked'}'. Refusing to execute on unverified database.`,
    );
  }

  return parsed;
}

// -----------------------------------------------------------------------------
// SQL Plan Generator
// -----------------------------------------------------------------------------

/**
 * Generates deterministic SQL statement to alter owner of a single PostgreSQL object.
 */
export function generateAlterOwnerStatement(objectType, identity, targetOwner) {
  const parsed = parseObjectIdentity(objectType, identity);
  const qTarget = quoteIdent(targetOwner);

  switch (objectType) {
    case 'schema':
      return `ALTER SCHEMA ${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'table':
    case 'partitioned_table':
      return `ALTER TABLE ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'foreign_table':
      return `ALTER FOREIGN TABLE ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'sequence':
      return `ALTER SEQUENCE ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'view':
      return `ALTER VIEW ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'materialized_view':
      return `ALTER MATERIALIZED VIEW ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'type':
      return `ALTER TYPE ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'domain':
      return `ALTER DOMAIN ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)} OWNER TO ${qTarget};`;

    case 'function':
      return `ALTER FUNCTION ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)}(${parsed.args}) OWNER TO ${qTarget};`;

    case 'procedure':
      return `ALTER PROCEDURE ${quoteIdent(parsed.schema)}.${quoteIdent(parsed.name)}(${parsed.args}) OWNER TO ${qTarget};`;

    default:
      fail('UNSUPPORTED_OBJECT_TYPE', `unsupported object type '${objectType}' for '${identity}'`);
  }
}

/**
 * Generates complete deterministic SQL plan and computes approval hash.
 */
export function generateOwnerMapPlan({
  inventoryData,
  ownerMapData,
  targetRolesData = null,
  expectedProjectRef = null,
  expectedTarget = null,
}) {
  const { items: inventoryItems, sourceOwners } = validateOwnerInventory(inventoryData);
  const { mapData, mappingMap } = validateOwnerMap(ownerMapData, expectedProjectRef, expectedTarget);

  let targetRoleSet = null;
  if (targetRolesData) {
    targetRoleSet = extractRoleNames(targetRolesData);
  }

  reconcileOwnerMappings(sourceOwners, mappingMap, targetRoleSet);

  // Deterministic sort: objectType ascending, then identity ascending
  const sortedItems = [...inventoryItems].sort((a, b) => {
    const typeCmp = a.objectType.localeCompare(b.objectType);
    if (typeCmp !== 0) return typeCmp;
    return a.identity.localeCompare(b.identity);
  });

  const statements = [];
  for (const item of sortedItems) {
    const targetOwner = mappingMap.get(item.sourceOwner);
    const stmt = generateAlterOwnerStatement(item.objectType, item.identity, targetOwner);
    statements.push(stmt);
  }

  // Safety scan: ensure no prohibited DDL or escalation statements
  for (const stmt of statements) {
    const upper = stmt.toUpperCase();
    if (
      upper.includes('DROP ') ||
      upper.includes('CREATE ROLE') ||
      upper.includes('GRANT ') ||
      upper.includes('REVOKE ') ||
      upper.includes('SUPERUSER')
    ) {
      fail('UNAUTHORIZED_STATEMENT', `prohibited statement detected in generated plan: ${stmt}`);
    }
  }

  // Build deterministic SQL output
  const lines = [
    '-- CRM Owner Map Plan (Deterministic)',
    `-- Format: ${PLAN_REPORT_FORMAT}`,
    `-- Source Project: ${mapData.sourceProjectRef}`,
    `-- Target: ${mapData.target}`,
    `-- Object Count: ${statements.length}`,
    'BEGIN;',
    ...statements,
    'COMMIT;',
    '',
  ];

  const sqlText = lines.join('\n');
  validatePlanSqlGrammar(sqlText);
  const planSha256 = sha256Hex(sqlText);

  return {
    sqlText,
    planSha256,
    objectCount: statements.length,
    statements,
    mapData,
  };
}

// -----------------------------------------------------------------------------
// Live Database Execution Wrapper (Spawn Without Shell Interpolation)
// -----------------------------------------------------------------------------

export async function executeSqlAgainstDatabase({
  sqlText,
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
  tuplesOnly = false,
  env = process.env,
}) {
  validateTargetIsolation({ dbContainer, dbHost, env });

  let cmd;
  let args;

  if (dbContainer) {
    cmd = 'docker';
    args = [
      'exec',
      '-i',
      dbContainer,
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      dbUser,
      '-d',
      dbName,
    ];
    if (tuplesOnly) {
      args.push('-qAt');
    }
  } else {
    cmd = 'psql';
    args = ['-X', '-v', 'ON_ERROR_STOP=1', '-d', dbName, '-U', dbUser];
    if (tuplesOnly) {
      args.push('-qAt');
    }
    args.push('-h', dbHost);
    if (dbPort) args.push('-p', String(dbPort));
  }

  const childEnv = getSanitizedChildEnv(env);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      reject(new HelperError('DB_CONNECTION_FAILED', `failed to spawn ${cmd}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new HelperError('APPLY_FAILED', `database execution failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.stdin.write(sqlText);
    child.stdin.end();
  });
}

/**
 * Queries roles from a live target database / container.
 */
export async function queryLiveTargetRoles({
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
}) {
  const sql = "SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]'::json)::text FROM pg_roles;\n";
  const { stdout } = await executeSqlAgainstDatabase({
    sqlText: sql,
    dbContainer,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    tuplesOnly: true,
  });

  const rawJson = stdout.trim();
  const roleList = JSON.parse(rawJson);
  return new Set(roleList);
}

/**
 * Queries current object owners from live target database.
 */
export async function queryLiveTargetObjects({
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
}) {
  const sql = `
WITH objects AS (
  SELECT 'schema'::text AS object_type, quote_ident(nspname) AS identity, pg_get_userbyid(nspowner) AS owner 
  FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname <> 'information_schema'
  UNION ALL 
  SELECT CASE c.relkind 
    WHEN 'r' THEN 'table' 
    WHEN 'p' THEN 'partitioned_table' 
    WHEN 'S' THEN 'sequence' 
    WHEN 'v' THEN 'view' 
    WHEN 'm' THEN 'materialized_view' 
    WHEN 'f' THEN 'foreign_table' 
    ELSE c.relkind::text END, 
    format('%I.%I',n.nspname,c.relname), 
    pg_get_userbyid(c.relowner) 
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace 
  WHERE c.relkind IN ('r','p','S','v','m','f') AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL 
  SELECT CASE p.prokind 
    WHEN 'p' THEN 'procedure' 
    ELSE 'function' END, 
    format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)), 
    pg_get_userbyid(p.proowner) 
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace 
  WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
  UNION ALL 
  SELECT CASE t.typtype 
    WHEN 'd' THEN 'domain' 
    ELSE 'type' END, 
    format('%I.%I',n.nspname,t.typname), 
    pg_get_userbyid(t.typowner) 
  FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace 
  WHERE t.typrelid=0 AND t.typelem=0 AND t.typisdefined AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
) 
SELECT coalesce(jsonb_agg(
  jsonb_build_object('objectType',object_type,'identity',identity,'currentOwner',owner) 
  ORDER BY object_type,identity
),'[]'::jsonb)::text FROM objects;
`;

  const { stdout } = await executeSqlAgainstDatabase({
    sqlText: sql,
    dbContainer,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    tuplesOnly: true,
  });

  return JSON.parse(stdout.trim());
}

/**
 * Queries current routine catalog details from live target database.
 */
export async function queryLiveTargetRoutines({
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
}) {
  const sql = `
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'identity', format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
  'owner', pg_get_userbyid(p.proowner),
  'securityDefiner', p.prosecdef,
  'config', p.proconfig,
  'acl', p.proacl::text
) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)::text
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema' AND p.prokind IN ('f','p');
`;

  const { stdout } = await executeSqlAgainstDatabase({
    sqlText: sql,
    dbContainer,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    tuplesOnly: true,
  });

  return JSON.parse(stdout.trim());
}

// -----------------------------------------------------------------------------
// Core Command Handlers: plan, apply, verify
// -----------------------------------------------------------------------------

/**
 * Handler for 'plan' subcommand.
 */
export async function handlePlanCommand({
  inventoryPath,
  mapPath,
  rolesPath = null,
  outPath,
  reportPath = null,
  target = DEFAULT_TARGET_IDENTITY,
  sourceProjectRef = null,
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
}) {
  if (!inventoryPath) fail('MISSING_OPTION', '--inventory <path> is required');
  if (!mapPath) fail('MISSING_OPTION', '--map <path> is required');
  if (!outPath) fail('MISSING_OPTION', '--out <path> is required');

  const resolvedTarget = target || DEFAULT_TARGET_IDENTITY;
  validateMetadataIdentifier(resolvedTarget, 'target');
  if (sourceProjectRef) {
    validateMetadataIdentifier(sourceProjectRef, 'sourceProjectRef');
  }

  const rawInventory = await fsp.readFile(inventoryPath, 'utf8');
  const inventoryData = parseJsonStrict(rawInventory, 'DUPLICATE_JSON_KEY', 'owner-inventory.json');

  const rawMap = await fsp.readFile(mapPath, 'utf8');
  const ownerMapData = parseJsonStrict(rawMap, 'DUPLICATE_JSON_KEY', 'owner-map.json');

  let targetRolesData = null;
  if (rolesPath) {
    const rawRoles = await fsp.readFile(rolesPath, 'utf8');
    targetRolesData = parseJsonStrict(rawRoles, 'DUPLICATE_JSON_KEY', 'roles-inventory.json');
  } else if (dbContainer || dbHost) {
    await verifyDatabaseTargetIdentity({
      dbContainer,
      dbHost,
      dbPort,
      dbName,
      dbUser,
      expectedTarget: resolvedTarget,
    });
    targetRolesData = await queryLiveTargetRoles({ dbContainer, dbHost, dbPort, dbName, dbUser });
  }

  const result = generateOwnerMapPlan({
    inventoryData,
    ownerMapData,
    targetRolesData,
    expectedProjectRef: sourceProjectRef,
    expectedTarget: resolvedTarget,
  });

  // Write plan SQL
  await writeFileAtomic(outPath, result.sqlText, 0o600);

  const rolesValidated = Boolean(targetRolesData);
  const status = rolesValidated ? 'PLAN_GENERATED' : 'PLAN_INCOMPLETE_UNVERIFIED_ROLES';
  const applyReady = rolesValidated;

  const report = {
    format: PLAN_REPORT_FORMAT,
    sourceProjectRef: result.mapData.sourceProjectRef,
    target: result.mapData.target,
    inventorySha256: sha256Hex(rawInventory),
    ownerMapSha256: sha256Hex(rawMap),
    planSha256: result.planSha256,
    objectCount: result.objectCount,
    rolesValidated,
    applyReady,
    status,
  };

  if (reportPath) {
    await writeFileAtomic(reportPath, JSON.stringify(report, null, 2) + '\n', 0o600);
  }

  return { ...result, report };
}

/**
 * Handler for 'apply' subcommand.
 */
export async function handleApplyCommand({
  planPath,
  approvedSha256,
  mapPath = null,
  inventoryPath = null,
  target = DEFAULT_TARGET_IDENTITY,
  sourceProjectRef = null,
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
  reportPath = null,
  customExecutor = null,
}) {
  if (!planPath) fail('MISSING_OPTION', '--plan <path> is required');
  if (!approvedSha256) fail('MISSING_APPROVAL_HASH', '--approved-sha256 <sha256> is required to apply plan');

  const planSql = await fsp.readFile(planPath, 'utf8');
  validatePlanSqlGrammar(planSql);
  const actualSha256 = sha256Hex(planSql);

  const cleanApproved = approvedSha256.trim().toLowerCase();
  if (actualSha256 !== cleanApproved) {
    fail(
      'APPROVAL_HASH_MISMATCH',
      `plan hash mismatch: approved '${cleanApproved}', computed '${actualSha256}'. Refusing to apply modified or unapproved plan.`,
    );
  }

  if (!mapPath) {
    fail('MISSING_OPTION', '--map <path> is required to apply plan');
  }

  const resolvedTarget = target || DEFAULT_TARGET_IDENTITY;
  validateMetadataIdentifier(resolvedTarget, 'target');
  if (sourceProjectRef) {
    validateMetadataIdentifier(sourceProjectRef, 'sourceProjectRef');
  }
  const rawMap = await fsp.readFile(mapPath, 'utf8');
  const mapData = parseJsonStrict(rawMap, 'DUPLICATE_JSON_KEY', 'owner-map.json');
  const { mappingMap } = validateOwnerMap(mapData, null, resolvedTarget);

  if (inventoryPath) {
    const rawInv = await fsp.readFile(inventoryPath, 'utf8');
    const invData = parseJsonStrict(rawInv, 'DUPLICATE_JSON_KEY', 'owner-inventory.json');
    validateOwnerInventory(invData);
  }

  // Execute SQL plan
  let execResult;
  if (customExecutor) {
    execResult = await customExecutor(planSql);
  } else {
    if (!dbContainer && !dbHost) {
      fail('MISSING_TARGET_ENDPOINT', 'apply requires --db-container or --db-host to connect to database');
    }

    // Verify database-side rehearsal sentinel identity before applying SQL (P1-02, P2-04)
    await verifyDatabaseTargetIdentity({
      dbContainer,
      dbHost,
      dbPort,
      dbName,
      dbUser,
      expectedTarget: resolvedTarget,
    });

    // Verify target roles exist on target database before applying (P2-02)
    const liveRoles = await queryLiveTargetRoles({ dbContainer, dbHost, dbPort, dbName, dbUser });
    for (const tgtRole of mappingMap.values()) {
      if (!liveRoles.has(tgtRole)) {
        fail('NONEXISTENT_TARGET_ROLE', `target owner '${tgtRole}' does not exist on target database before apply`);
      }
    }

    execResult = await executeSqlAgainstDatabase({
      sqlText: planSql,
      dbContainer,
      dbHost,
      dbPort,
      dbName,
      dbUser,
    });
  }

  const report = {
    format: 'crm-owner-map-apply/v1',
    planSha256: actualSha256,
    target: resolvedTarget,
    appliedAt: new Date().toISOString(),
    status: 'APPLIED',
  };

  if (reportPath) {
    await writeFileAtomic(reportPath, JSON.stringify(report, null, 2) + '\n', 0o600);
  }

  return { success: true, planSha256: actualSha256, report, execResult };
}

/**
 * Normalizes config array or string for deterministic comparison.
 */
function normalizeProConfig(config) {
  if (!config) return null;
  if (Array.isArray(config)) {
    return [...config].sort();
  }
  return [String(config)];
}

/**
 * Handler for 'verify' subcommand.
 */
export async function handleVerifyCommand({
  inventoryPath,
  mapPath,
  catalogDetailsPath = null,
  targetInventoryPath = null,
  targetCatalogDetailsPath = null,
  target = DEFAULT_TARGET_IDENTITY,
  sourceProjectRef = null,
  dbContainer = null,
  dbHost = null,
  dbPort = null,
  dbName = 'postgres',
  dbUser = 'postgres',
  reportPath = null,
}) {
  if (!inventoryPath) fail('MISSING_OPTION', '--inventory <path> is required');
  if (!mapPath) fail('MISSING_OPTION', '--map <path> is required');

  const resolvedTarget = target || DEFAULT_TARGET_IDENTITY;
  validateMetadataIdentifier(resolvedTarget, 'target');
  if (sourceProjectRef) {
    validateMetadataIdentifier(sourceProjectRef, 'sourceProjectRef');
  }

  const rawInventory = await fsp.readFile(inventoryPath, 'utf8');
  const inventoryData = parseJsonStrict(rawInventory, 'DUPLICATE_JSON_KEY', 'owner-inventory.json');

  const rawMap = await fsp.readFile(mapPath, 'utf8');
  const ownerMapData = parseJsonStrict(rawMap, 'DUPLICATE_JSON_KEY', 'owner-map.json');

  const { items: sourceItems, sourceOwners } = validateOwnerInventory(inventoryData);
  const { mapData, mappingMap } = validateOwnerMap(ownerMapData, sourceProjectRef, resolvedTarget);

  reconcileOwnerMappings(sourceOwners, mappingMap, null);

  // Obtain target objects
  let targetObjectMap;
  if (targetInventoryPath) {
    const rawTarget = await fsp.readFile(targetInventoryPath, 'utf8');
    const targetObjectsRaw = parseJsonStrict(rawTarget, 'DUPLICATE_JSON_KEY', 'target-inventory.json');
    const validated = validateTargetInventory(targetObjectsRaw);
    targetObjectMap = validated.targetObjectMap;
  } else if (dbContainer || dbHost) {
    await verifyDatabaseTargetIdentity({
      dbContainer,
      dbHost,
      dbPort,
      dbName,
      dbUser,
      expectedTarget: resolvedTarget,
    });
    const liveObjects = await queryLiveTargetObjects({ dbContainer, dbHost, dbPort, dbName, dbUser });
    const validated = validateTargetInventory(liveObjects);
    targetObjectMap = validated.targetObjectMap;
  } else {
    fail('MISSING_TARGET_SOURCE', 'either --target-inventory <path> or database target (--db-container / --db-host) must be provided');
  }

  const discrepancies = [];
  let verifiedObjectsCount = 0;

  for (const item of sourceItems) {
    const expectedOwner = mappingMap.get(item.sourceOwner);
    const key = `${item.objectType}:${item.identity}`;
    const actualOwner = targetObjectMap.get(key);

    if (actualOwner === undefined) {
      discrepancies.push({
        category: 'MISSING_TARGET_OBJECT',
        objectType: item.objectType,
        identity: item.identity,
        expectedOwner,
        actualOwner: null,
        detail: `object '${item.objectType}' '${item.identity}' not found on target`,
      });
      continue;
    }

    if (actualOwner !== expectedOwner) {
      discrepancies.push({
        category: 'OWNER_MISMATCH',
        objectType: item.objectType,
        identity: item.identity,
        expectedOwner,
        actualOwner,
        detail: `ownership mismatch for '${item.identity}': expected '${expectedOwner}', got '${actualOwner}'`,
      });
    } else {
      verifiedObjectsCount++;
    }
  }

  // Routine attributes verification (P1-01, P2-01, P2-03)
  const routineObjects = sourceItems.filter((i) => i.objectType === 'function' || i.objectType === 'procedure');
  let verifiedRoutinesCount = 0;

  if (routineObjects.length > 0) {
    if (!catalogDetailsPath) {
      fail('MISSING_CATALOG_DETAILS', 'source inventory contains routines but --catalog-details was omitted');
    }

    const rawCatalog = await fsp.readFile(catalogDetailsPath, 'utf8');
    const sourceCatalog = parseJsonStrict(rawCatalog, 'DUPLICATE_JSON_KEY', 'catalog-details.json');

    if (!sourceCatalog || typeof sourceCatalog !== 'object' || !Array.isArray(sourceCatalog.routines)) {
      fail('MALFORMED_CATALOG_DETAILS', 'source catalog-details must contain a routines array');
    }

    if (sourceCatalog.routines.length === 0) {
      fail('EMPTY_ROUTINES_CATALOG', 'source inventory contains routines but source catalog-details routines array is empty');
    }

    // Validate entries and check duplicates in source catalog
    const seenSourceRoutineKeys = new Set();
    const sourceRoutineCatalogMap = new Map();
    for (const r of sourceCatalog.routines) {
      validateRoutineEntry(r, 'source catalog');
      if (seenSourceRoutineKeys.has(r.identity)) {
        fail('DUPLICATE_SOURCE_ROUTINE', `duplicate routine in source catalog: '${r.identity}'`);
      }
      seenSourceRoutineKeys.add(r.identity);
      sourceRoutineCatalogMap.set(r.identity, r);
    }

    // Exact-set reconciliation between routine identities in owner inventory and routine catalogs
    for (const item of routineObjects) {
      if (!sourceRoutineCatalogMap.has(item.identity)) {
        discrepancies.push({
          category: 'MISSING_SOURCE_ROUTINE',
          identity: item.identity,
          detail: `routine '${item.identity}' present in owner-inventory but missing from source catalog-details`,
        });
      }
    }

    const invRoutineSet = new Set(routineObjects.map((r) => r.identity));
    for (const r of sourceCatalog.routines) {
      if (!invRoutineSet.has(r.identity)) {
        discrepancies.push({
          category: 'UNMATCHED_CATALOG_ROUTINE',
          identity: r.identity,
          detail: `routine '${r.identity}' present in source catalog-details but absent from owner-inventory`,
        });
      }
    }

    // Obtain and validate target routine catalog
    let targetRoutines = null;
    if (targetCatalogDetailsPath) {
      const rawTargetCat = await fsp.readFile(targetCatalogDetailsPath, 'utf8');
      const targetCatalog = parseJsonStrict(rawTargetCat, 'DUPLICATE_JSON_KEY', 'target-catalog-details.json');
      if (!targetCatalog || typeof targetCatalog !== 'object' || !Array.isArray(targetCatalog.routines)) {
        fail('MALFORMED_TARGET_CATALOG_DETAILS', 'target catalog-details must contain a routines array');
      }
      targetRoutines = targetCatalog.routines;
    } else if (dbContainer || dbHost) {
      targetRoutines = await queryLiveTargetRoutines({ dbContainer, dbHost, dbPort, dbName, dbUser });
    } else {
      fail('MISSING_TARGET_ROUTINES', 'routine security verification requires --target-catalog-details or live database connection');
    }

    if (!targetRoutines || !Array.isArray(targetRoutines)) {
      fail('MISSING_TARGET_ROUTINES', 'target routines catalog is unavailable or invalid');
    }

    const targetRoutineMap = new Map();
    for (const r of targetRoutines) {
      validateRoutineEntry(r, 'target catalog');
      if (targetRoutineMap.has(r.identity)) {
        fail('DUPLICATE_TARGET_ROUTINE', `duplicate routine in target catalog: '${r.identity}'`);
      }
      targetRoutineMap.set(r.identity, r);
    }

    // Compare each routine in source catalog
    for (const srcRoutine of sourceCatalog.routines) {
      const routineDiscrepanciesBefore = discrepancies.length;
      const tgtRoutine = targetRoutineMap.get(srcRoutine.identity);

      if (!tgtRoutine) {
        discrepancies.push({
          category: 'MISSING_TARGET_ROUTINE',
          identity: srcRoutine.identity,
          detail: `routine '${srcRoutine.identity}' not found on target catalog`,
        });
      } else {
        const expectedOwner = mappingMap.get(srcRoutine.owner) || srcRoutine.owner;
        const actualOwner = tgtRoutine.owner;
        if (actualOwner !== expectedOwner) {
          discrepancies.push({
            category: 'OWNER_MISMATCH',
            identity: srcRoutine.identity,
            expected: expectedOwner,
            actual: actualOwner,
            detail: `routine proowner mismatch for '${srcRoutine.identity}': expected '${expectedOwner}', got '${actualOwner}'`,
          });
        }

        // Security Definer check
        if (Boolean(srcRoutine.securityDefiner) !== Boolean(tgtRoutine.securityDefiner)) {
          discrepancies.push({
            category: 'SECURITY_DEFINER_MISMATCH',
            identity: srcRoutine.identity,
            expected: Boolean(srcRoutine.securityDefiner),
            actual: Boolean(tgtRoutine.securityDefiner),
            detail: `routine prosecdef mismatch for '${srcRoutine.identity}': expected ${srcRoutine.securityDefiner}, got ${tgtRoutine.securityDefiner}`,
          });
        }

        // proconfig check
        const srcCfg = normalizeProConfig(srcRoutine.config);
        const tgtCfg = normalizeProConfig(tgtRoutine.config);
        const srcCfgStr = JSON.stringify(srcCfg);
        const tgtCfgStr = JSON.stringify(tgtCfg);
        if (srcCfgStr !== tgtCfgStr) {
          discrepancies.push({
            category: 'PROCONFIG_MISMATCH',
            identity: srcRoutine.identity,
            expected: srcCfg,
            actual: tgtCfg,
            detail: `routine proconfig mismatch for '${srcRoutine.identity}': expected ${srcCfgStr}, got ${tgtCfgStr}`,
          });
        }

        // EXECUTE ACL check
        const srcAcl = srcRoutine.acl || null;
        const tgtAcl = tgtRoutine.acl || null;
        if (srcAcl !== tgtAcl) {
          discrepancies.push({
            category: 'ACL_MISMATCH',
            identity: srcRoutine.identity,
            expected: srcAcl,
            actual: tgtAcl,
            detail: `routine ACL mismatch for '${srcRoutine.identity}': expected '${srcAcl}', got '${tgtAcl}'`,
          });
        }
      }

      // P2-03: increment verified count only if this specific routine added zero discrepancies
      const routineDiscrepanciesAdded = discrepancies.length - routineDiscrepanciesBefore;
      if (routineDiscrepanciesAdded === 0) {
        verifiedRoutinesCount++;
      }
    }
  } else if (catalogDetailsPath) {
    // If no routines in inventory but catalogDetailsPath is provided, validate it
    const rawCatalog = await fsp.readFile(catalogDetailsPath, 'utf8');
    const sourceCatalog = parseJsonStrict(rawCatalog, 'DUPLICATE_JSON_KEY', 'catalog-details.json');
    if (sourceCatalog?.routines && Array.isArray(sourceCatalog.routines) && sourceCatalog.routines.length > 0) {
      for (const r of sourceCatalog.routines) {
        discrepancies.push({
          category: 'UNMATCHED_CATALOG_ROUTINE',
          identity: r.identity,
          detail: `routine '${r.identity}' present in catalog-details but absent from owner-inventory`,
        });
      }
    }
  }

  const status = discrepancies.length === 0 ? 'VERIFIED' : 'BLOCKED';

  const report = {
    format: VERIFY_REPORT_FORMAT,
    sourceProjectRef: mapData.sourceProjectRef,
    target: mapData.target,
    status,
    verifiedAt: new Date().toISOString(),
    summary: {
      totalObjects: sourceItems.length,
      verifiedObjectsCount,
      mismatchedObjectsCount: discrepancies.filter((d) => d.category === 'OWNER_MISMATCH' || d.category === 'MISSING_TARGET_OBJECT').length,
      verifiedRoutinesCount,
      discrepanciesCount: discrepancies.length,
    },
    discrepancies,
  };

  if (reportPath) {
    await writeFileAtomic(reportPath, JSON.stringify(report, null, 2) + '\n', 0o600);
  }

  if (status === 'BLOCKED') {
    fail('VERIFICATION_BLOCKED', `ownership verification BLOCKED: ${discrepancies.length} discrepancies detected`, discrepancies);
  }

  return { status: 'VERIFIED', report };
}

// -----------------------------------------------------------------------------
// CLI Argument Parsing & Runner
// -----------------------------------------------------------------------------

export function printHelp(subcommand = null) {
  if (subcommand === 'plan') {
    console.log(`
Usage: node scripts/backup/owner-map.mjs plan [options]

Generates a deterministic ALTER ... OWNER TO SQL plan from owner-inventory.json and owner-map.json.

Options:
  --inventory <path>           Path to source owner-inventory.json (required)
  --map <path>                 Path to approved owner-map.json (required)
  --roles <path>               Path to target roles inventory JSON (optional if target DB provided)
  --out <path>                 Path to write generated plan.sql (required)
  --report <path>              Path to write plan JSON report (optional)
  --target <label>             Target label (must match owner-map.json target)
  --source-project-ref <ref>   Expected source project reference
  --db-container <name>        Target Docker container name (optional)
  --db-host <host>             Target DB host (local loopback only)
  --db-port <port>             Target DB port
  --db-name <name>             Target DB database name (default: postgres)
  --db-user <user>             Target DB user (default: postgres)
  -h, --help                   Show this help message
`);
    return;
  }

  if (subcommand === 'apply') {
    console.log(`
Usage: node scripts/backup/owner-map.mjs apply [options]

Applies an approved ALTER ... OWNER TO SQL plan to the local restore PostgreSQL target.

Options:
  --plan <path>                Path to plan.sql (required)
  --approved-sha256 <hash>     Database-reviewer approved plan SHA-256 (required)
  --map <path>                 Path to owner-map.json to verify target identity (required)
  --target <label>             Target label (default: crm-restore-rehearsal)
  --report <path>              Path to write apply JSON report (optional)
  --db-container <name>        Target Docker container name
  --db-host <host>             Target DB host (local loopback only)
  --db-port <port>             Target DB port
  --db-name <name>             Target DB database name (default: postgres)
  --db-user <user>             Target DB user (default: postgres)
  -h, --help                   Show this help message
`);
    return;
  }

  if (subcommand === 'verify') {
    console.log(`
Usage: node scripts/backup/owner-map.mjs verify [options]

Verifies that target PostgreSQL objects have been correctly transferred to approved target owners
and that routine security attributes (prosecdef, proconfig, ACL) remain intact.

Options:
  --inventory <path>               Path to source owner-inventory.json (required)
  --map <path>                     Path to approved owner-map.json (required)
  --catalog-details <path>         Path to source catalog-details.json for routine security checks
  --target-inventory <path>        Path to target owner-inventory.json (for offline verification)
  --target-catalog-details <path>  Path to target catalog-details.json (for offline routine verification)
  --target <label>                 Target label (must match owner-map.json target)
  --report <path>                  Path to write verification JSON report (optional)
  --db-container <name>            Target Docker container name
  --db-host <host>                 Target DB host (local loopback only)
  --db-port <port>                 Target DB port
  --db-name <name>                 Target DB database name (default: postgres)
  --db-user <user>                 Target DB user (default: postgres)
  -h, --help                       Show this help message
`);
    return;
  }

  console.log(`
Usage: node scripts/backup/owner-map.mjs <command> [options]

PostgreSQL Ownership Mapping Generator & Verifier (Helper #6)

Commands:
  plan      Generate deterministic SQL plan and approval SHA-256
  apply     Apply approved plan with strict hash enforcement
  verify    Verify post-apply object ownership and routine security attributes

Run 'node scripts/backup/owner-map.mjs <command> --help' for command-specific options.
`);
}

export function parseCliArgs(argv) {
  const options = Object.create(null);
  let subcommand = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!subcommand && !arg.startsWith('-')) {
      subcommand = arg;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        options[key] = argv[i + 1];
        i++;
      } else {
        options[key] = true;
      }
    }
  }

  return { subcommand, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { subcommand, options } = parseCliArgs(argv);

  if (!subcommand || options.help) {
    printHelp(subcommand);
    process.exit(0);
  }

  try {
    switch (subcommand) {
      case 'plan': {
        const res = await handlePlanCommand({
          inventoryPath: options.inventory,
          mapPath: options.map,
          rolesPath: options.roles,
          outPath: options.out,
          reportPath: options.report,
          target: options.target,
          sourceProjectRef: options['source-project-ref'],
          dbContainer: options['db-container'],
          dbHost: options['db-host'],
          dbPort: options['db-port'],
          dbName: options['db-name'] || 'postgres',
          dbUser: options['db-user'] || 'postgres',
        });
        console.log(`Plan generated successfully.`);
        console.log(`Plan SHA-256: ${res.planSha256}`);
        console.log(`Objects in plan: ${res.objectCount}`);
        break;
      }

      case 'apply': {
        const res = await handleApplyCommand({
          planPath: options.plan,
          approvedSha256: options['approved-sha256'],
          mapPath: options.map,
          inventoryPath: options.inventory,
          target: options.target,
          dbContainer: options['db-container'],
          dbHost: options['db-host'],
          dbPort: options['db-port'],
          dbName: options['db-name'] || 'postgres',
          dbUser: options['db-user'] || 'postgres',
          reportPath: options.report,
        });
        console.log(`Plan applied successfully.`);
        console.log(`Applied Plan SHA-256: ${res.planSha256}`);
        break;
      }

      case 'verify': {
        const res = await handleVerifyCommand({
          inventoryPath: options.inventory,
          mapPath: options.map,
          catalogDetailsPath: options['catalog-details'],
          targetInventoryPath: options['target-inventory'],
          targetCatalogDetailsPath: options['target-catalog-details'],
          target: options.target,
          sourceProjectRef: options['source-project-ref'],
          dbContainer: options['db-container'],
          dbHost: options['db-host'],
          dbPort: options['db-port'],
          dbName: options['db-name'] || 'postgres',
          dbUser: options['db-user'] || 'postgres',
          reportPath: options.report,
        });
        console.log(`Verification PASSED.`);
        console.log(`Summary: ${JSON.stringify(res.report.summary)}`);
        break;
      }

      default:
        console.error(`Unknown command: '${subcommand}'`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof HelperError) {
      console.error(`Error [${err.code}]: ${err.message}`);
      if (err.details && Array.isArray(err.details)) {
        for (const d of err.details.slice(0, 5)) {
          console.error(`  - ${d.detail || JSON.stringify(d)}`);
        }
        if (err.details.length > 5) {
          console.error(`  ... and ${err.details.length - 5} more discrepancies`);
        }
      }
      process.exit(1);
    }
    console.error(`Unexpected Error:`, err);
    process.exit(1);
  }
}

// Auto-run when invoked directly as CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
