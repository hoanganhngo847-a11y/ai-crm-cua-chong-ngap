import 'server-only';

import { ALLOWED_BRAIN_CHANNELS } from './contracts';
import {
  BRAIN_CONTEXT_TOOL_NAMES,
  type BrainContextDataSource,
  type BrainContextErrorCode,
  type BrainContextGateway,
  type BrainContextScope,
  type BrainContextSession,
  type BrainContextToolCall,
  type BrainContextToolName,
  type BrainContextToolResult,
} from './context-contracts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FROZEN_CONTEXT_TOOLS: readonly BrainContextToolName[] = Object.freeze([...BRAIN_CONTEXT_TOOL_NAMES]);
const MAX_KNOWLEDGE_QUERY = 300;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    output[key] = descriptor.value;
  }
  return output;
}

function validateScope(raw: unknown): BrainContextScope | null {
  const input = plainRecord(raw);
  if (!input) return null;
  const keys = Object.keys(input);
  const allowed = ['companyId', 'customerId', 'conversationId', 'channel', 'traceId'];
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) return null;
  if (![input.companyId, input.customerId, input.conversationId, input.traceId].every(
    (value) => typeof value === 'string' && UUID_RE.test(value),
  )) return null;
  if (typeof input.channel !== 'string' || !ALLOWED_BRAIN_CHANNELS.includes(input.channel as never)) return null;
  return Object.freeze({
    companyId: input.companyId as string,
    customerId: input.customerId as string,
    conversationId: input.conversationId as string,
    channel: input.channel as BrainContextScope['channel'],
    traceId: input.traceId as string,
  });
}

function validateToolCall(raw: unknown): BrainContextToolCall | null {
  const input = plainRecord(raw);
  if (!input) return null;
  const keys = Object.keys(input);
  if (keys.some((key) => key !== 'name' && key !== 'arguments') || !Object.prototype.hasOwnProperty.call(input, 'name')) {
    return null;
  }
  if (typeof input.name !== 'string' || !BRAIN_CONTEXT_TOOL_NAMES.includes(input.name as BrainContextToolName)) {
    return null;
  }

  if (input.name === 'search_company_knowledge') {
    if (!Object.prototype.hasOwnProperty.call(input, 'arguments')) return null;
    const args = plainRecord(input.arguments);
    if (!args || Object.keys(args).length !== 1 || !Object.prototype.hasOwnProperty.call(args, 'query')) return null;
    if (typeof args.query !== 'string') return null;
    const query = args.query.trim();
    if (query.length < 1 || query.length > MAX_KNOWLEDGE_QUERY || /[\u0000-\u001f\u007f]/.test(query)) return null;
    return Object.freeze({
      name: 'search_company_knowledge' as const,
      arguments: Object.freeze({ query }),
    });
  }

  if (Object.prototype.hasOwnProperty.call(input, 'arguments')) {
    const args = plainRecord(input.arguments);
    // All non-search tools accept an exact empty object only. Authority and row limits remain server-owned.
    if (!args || Object.keys(args).length !== 0) return null;
  }
  return Object.freeze({
    name: input.name as Exclude<BrainContextToolName, 'search_company_knowledge'>,
    arguments: Object.freeze({}),
  });
}

function failed(tool: BrainContextToolName | null, errorCode: BrainContextErrorCode): BrainContextToolResult {
  return Object.freeze({ ok: false, tool, errorCode });
}

function succeeded(tool: BrainContextToolName, data: Extract<BrainContextToolResult, { ok: true }>['data']): BrainContextToolResult {
  return Object.freeze({ ok: true, tool, data });
}

export function createBrainContextGateway(dataSource: BrainContextDataSource): BrainContextGateway {
  if (!dataSource || typeof dataSource !== 'object') throw new Error('BRAIN_CONTEXT_DATASOURCE_REQUIRED');

  return Object.freeze({
    bind(rawScope: unknown): BrainContextSession {
      const scope = validateScope(rawScope);
      if (!scope) {
        return Object.freeze({
          tools: Object.freeze([]),
          async execute(): Promise<BrainContextToolResult> {
            return failed(null, 'BRAIN_CONTEXT_INVALID_SCOPE');
          },
        });
      }

      return Object.freeze({
        tools: FROZEN_CONTEXT_TOOLS,
        async execute(rawCall: unknown): Promise<BrainContextToolResult> {
          const call = validateToolCall(rawCall);
          if (!call) return failed(null, 'BRAIN_CONTEXT_TOOL_NOT_ALLOWED');

          try {
            switch (call.name) {
              case 'get_customer_profile': {
                const profile = await dataSource.getCustomerProfile(scope);
                return profile ? succeeded(call.name, profile) : failed(call.name, 'BRAIN_CONTEXT_NOT_FOUND');
              }
              case 'get_recent_conversations':
                return succeeded(call.name, await dataSource.getRecentConversations(scope));
              case 'get_recent_interactions':
                return succeeded(call.name, await dataSource.getRecentInteractions(scope));
              case 'get_customer_stage_history':
                return succeeded(call.name, await dataSource.getCustomerStageHistory(scope));
              case 'get_upcoming_appointments':
                return succeeded(call.name, await dataSource.getUpcomingAppointments(scope));
              case 'get_call_history':
                return succeeded(call.name, await dataSource.getCallHistory(scope));
              case 'get_recent_call_summaries':
                return succeeded(call.name, await dataSource.getRecentCallSummaries(scope));
              case 'get_customer_memory':
                return succeeded(call.name, await dataSource.getCustomerMemory(scope));
              case 'search_company_knowledge':
                return succeeded(call.name, await dataSource.searchCompanyKnowledge(scope, call.arguments.query));
              default: {
                const exhaustive: never = call;
                void exhaustive;
                return failed(null, 'BRAIN_CONTEXT_TOOL_NOT_ALLOWED');
              }
            }
          } catch {
            // DB/provider details must never cross the context boundary.
            return failed(call.name, 'BRAIN_CONTEXT_UNAVAILABLE');
          }
        },
      });
    },
  });
}
