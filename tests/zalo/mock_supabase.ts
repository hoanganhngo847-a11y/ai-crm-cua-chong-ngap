/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-Memory Mock Supabase Client for Testing Zalo Omnichannel & Care Modules.
 * Allows pure, isolated unit and integration testing without a running Postgres instance.
 * Supports unique constraint enforcement for idempotency claims, outbox delivery, and atomic RPCs.
 */

export interface MockDatabase {
  companies: any[];
  customers: any[];
  identities: any[];
  conversations: any[];
  interactions: any[];
  interaction_raw_contents: any[];
  care_campaigns: any[];
  care_deliveries: any[];
  care_schedules: any[];
  zalo_oa_configs: any[];
  zalo_oa_secrets: any[];
  zalo_ingress_events: any[];
  zalo_outbound_deliveries: any[];
  _failProcessIngress?: boolean;
  _failPrivateRaw?: boolean;
  _failOutboundFinalize?: boolean;
  [table: string]: any;
}

export function createMockDatabase(seed: Partial<MockDatabase> = {}): MockDatabase {
  return {
    companies: seed.companies || [
      { id: '11111111-1111-1111-1111-111111111111', name: 'Công ty Cửa Chống Ngập', status: 'ACTIVE' },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Công ty Cửa Chống Ngập Chi Nhánh 2', status: 'ACTIVE' },
    ],
    customers: seed.customers || [],
    identities: seed.identities || [],
    conversations: seed.conversations || [],
    interactions: seed.interactions || [],
    interaction_raw_contents: seed.interaction_raw_contents || [],
    care_campaigns: seed.care_campaigns || [],
    care_deliveries: seed.care_deliveries || [],
    care_schedules: seed.care_schedules || [],
    zalo_oa_configs: seed.zalo_oa_configs || [],
    zalo_oa_secrets: seed.zalo_oa_secrets || [],
    zalo_ingress_events: seed.zalo_ingress_events || [],
    zalo_outbound_deliveries: seed.zalo_outbound_deliveries || [],
    ...seed,
  };
}

class MockQueryBuilder {
  private filters: Array<(item: any) => boolean> = [];
  private orderFn: ((a: any, b: any) => number) | null = null;
  private rangeBounds: [number, number] | null = null;
  private selectFields: string = '*';
  private operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' = 'SELECT';
  private insertData: any = null;
  private updateData: any = null;

  constructor(
    private table: string,
    private db: MockDatabase
  ) {
    if (!this.db[this.table]) {
      this.db[this.table] = [];
    }
  }

  select(fields = '*') {
    this.selectFields = fields;
    return this;
  }

  insert(data: any) {
    this.operation = 'INSERT';
    this.insertData = data;
    return this;
  }

  update(data: any) {
    this.operation = 'UPDATE';
    this.updateData = data;
    return this;
  }

  delete() {
    this.operation = 'DELETE';
    return this;
  }

  eq(field: string, value: any) {
    this.filters.push((item) => item[field] === value);
    return this;
  }

  in(field: string, values: any[]) {
    this.filters.push((item) => values.includes(item[field]));
    return this;
  }

  lte(field: string, value: any) {
    this.filters.push((item) => item[field] <= value);
    return this;
  }

  order(field: string, options: { ascending?: boolean } = {}) {
    const asc = options.ascending !== false;
    this.orderFn = (a, b) => {
      if (a[field] < b[field]) return asc ? -1 : 1;
      if (a[field] > b[field]) return asc ? 1 : -1;
      return 0;
    };
    return this;
  }

  range(from: number, to: number) {
    this.rangeBounds = [from, to];
    return this;
  }

  limit(n: number) {
    this.rangeBounds = [0, n - 1];
    return this;
  }

  private execute() {
    const list = this.db[this.table] || [];

    if (this.operation === 'INSERT') {
      const rows = Array.isArray(this.insertData) ? this.insertData : [this.insertData];
      const inserted: any[] = [];

      for (const row of rows) {
        // Enforce UNIQUE(company_id, oa_id, external_ref) on zalo_ingress_events
        if (this.table === 'zalo_ingress_events') {
          const duplicate = list.find(
            (e: any) =>
              e.company_id === row.company_id &&
              e.oa_id === row.oa_id &&
              e.external_ref === row.external_ref
          );
          if (duplicate) {
            return {
              data: null,
              error: {
                message: 'duplicate key value violates unique constraint "uq_zalo_ingress_events_claim"',
                code: '23505',
              },
            };
          }
        }

        // Enforce UNIQUE(idempotency_key) or UNIQUE(company_id, channel, command_id) on zalo_outbound_deliveries
        if (this.table === 'zalo_outbound_deliveries') {
          if (this.db._failOutboxInsert) {
            return {
              data: null,
              error: {
                message: 'Outbox disk full / lock claim timeout',
                code: '53100',
              },
            };
          }
          if (row.idempotency_key) {
            const duplicate = list.find((e: any) => e.idempotency_key === row.idempotency_key);
            if (duplicate) {
              return {
                data: null,
                error: {
                  message: 'duplicate key value violates unique constraint "uq_zalo_outbound_deliveries_idempotency"',
                  code: '23505',
                },
              };
            }
          }
          if (row.command_id) {
            const duplicate = list.find(
              (e: any) =>
                e.company_id === row.company_id &&
                e.channel === (row.channel || 'ZALO') &&
                e.command_id === row.command_id
            );
            if (duplicate) {
              return {
                data: null,
                error: {
                  message: 'duplicate key value violates unique constraint "uq_zalo_outbound_command"',
                  code: '23505',
                },
              };
            }
          }
        }

        // Enforce UNIQUE(care_schedule_id, send_target_date) on care_deliveries
        if (this.table === 'care_deliveries' && row.care_schedule_id && row.send_target_date) {
          const duplicate = list.find(
            (e: any) =>
              e.care_schedule_id === row.care_schedule_id &&
              e.send_target_date === row.send_target_date
          );
          if (duplicate) {
            return {
              data: null,
              error: {
                message: 'duplicate key value violates unique constraint "uq_care_deliveries_schedule_date"',
                code: '23505',
              },
            };
          }
        }

        const item = {
          id: row.id || `mock_${this.table}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          created_at: row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || new Date().toISOString(),
          ...row,
        };
        list.push(item);
        inserted.push(item);
      }

      const resultData = Array.isArray(this.insertData) ? inserted : inserted[0];
      return { data: resultData, error: null };
    }

    if (this.operation === 'UPDATE') {
      const matched = list.filter((item: any) => this.filters.every((f) => f(item)));
      for (const item of matched) {
        Object.assign(item, this.updateData, { updated_at: new Date().toISOString() });
      }
      return { data: matched, error: null };
    }

    if (this.operation === 'DELETE') {
      const remaining = list.filter((item: any) => !this.filters.every((f) => f(item)));
      this.db[this.table] = remaining;
      return { data: null, error: null };
    }

    // SELECT
    let result = list.filter((item: any) => this.filters.every((f) => f(item)));

    if (this.orderFn) {
      result.sort(this.orderFn);
    }

    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      result = result.slice(from, to + 1);
    }

    // Handle simple join simulation: customers(name)
    if (this.selectFields.includes('customers(name)')) {
      result = result.map((item: any) => {
        const cust = this.db.customers?.find((c: any) => c.id === item.customer_id);
        return {
          ...item,
          customers: cust ? { name: cust.name } : null,
        };
      });
    }

    return { data: result, error: null };
  }

  async single() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (Array.isArray(data)) {
      if (data.length === 0) return { data: null, error: new Error('Row not found') };
      return { data: data[0], error: null };
    }
    return { data, error: null };
  }

  async maybeSingle() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (Array.isArray(data)) {
      return { data: data[0] || null, error: null };
    }
    return { data, error: null };
  }

  // Promise interface
  then(onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

export function createMockSupabase(db?: MockDatabase) {
  const database = db || createMockDatabase();

  const client: any = {
    from: (table: string) => new MockQueryBuilder(table, database),
    schema: (schemaName: string) => ({
      from: (table: string) => new MockQueryBuilder(schemaName === 'private' ? table : `${schemaName}.${table}`, database),
    }),
    rpc: async function(this: any, fnName: string, params: any) {
      const activeClient = this || client;

      // 1. zalo_claim_ingress_event
      if (fnName === 'zalo_claim_ingress_event') {
        const { p_company_id, p_oa_id, p_external_ref, p_event_name, p_sender_id, p_recipient_id } = params;
        const list = database.zalo_ingress_events;
        const existing = list.find(
          (e: any) => e.company_id === p_company_id && e.oa_id === p_oa_id && e.external_ref === p_external_ref
        );

        if (!existing) {
          const newId = `mock_ingress_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          const newRecord = {
            id: newId,
            company_id: p_company_id,
            oa_id: p_oa_id,
            external_ref: p_external_ref,
            event_name: p_event_name,
            sender_id: p_sender_id,
            recipient_id: p_recipient_id,
            status: 'CLAIMED',
            lease_until: new Date(Date.now() + 120000).toISOString(),
            retry_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          list.push(newRecord);
          return { data: [{ claim_status: 'CLAIMED', event_id: newId, retry_count: 0 }], error: null };
        }

        if (existing.status === 'PROCESSED') {
          return { data: [{ claim_status: 'DUPLICATE', event_id: existing.id, retry_count: existing.retry_count }], error: null };
        }

        const nowTime = Date.now();
        const leaseTime = existing.lease_until ? new Date(existing.lease_until).getTime() : 0;

        if (existing.status === 'FAILED' || (existing.status === 'CLAIMED' && leaseTime < nowTime)) {
          existing.status = 'CLAIMED';
          existing.retry_count = (existing.retry_count || 0) + 1;
          existing.lease_until = new Date(Date.now() + 120000).toISOString();
          existing.last_error = null;
          existing.updated_at = new Date().toISOString();
          return { data: [{ claim_status: 'CLAIMED', event_id: existing.id, retry_count: existing.retry_count }], error: null };
        }

        // Active lease
        return { data: [{ claim_status: 'BUSY', event_id: existing.id, retry_count: existing.retry_count }], error: null };
      }

      // 2. zalo_process_ingress_message
      if (fnName === 'zalo_process_ingress_message') {
        if (database._failProcessIngress || database._failPrivateRaw) {
          return {
            data: null,
            error: { message: 'Security Zone Ingress Violation: Database error in private vault / transaction failure' },
          };
        }

        // Test if caller client has a failing private schema override
        if (activeClient && typeof activeClient.schema === 'function') {
          try {
            const rawBuilder = activeClient.schema('private').from('interaction_raw_contents');
            if (rawBuilder && typeof rawBuilder.insert === 'function') {
              const res = await rawBuilder.insert({});
              if (res?.error) {
                return {
                  data: null,
                  error: {
                    message: `Security Zone Ingress Violation: Failed to persist raw interaction content in private zone: ${res.error.message}`,
                  },
                };
              }
            }
          } catch (err: any) {
            return {
              data: null,
              error: { message: `Security Zone Ingress Violation: ${err.message}` },
            };
          }
        }

        const {
          p_company_id,
          p_oa_id,
          p_external_ref,
          p_raw_msg_id,
          p_zalo_user_uid,
          p_user_name,
          p_event_name,
          p_sender_id,
          p_recipient_id,
          p_is_inbound,
          p_sanitized_content,
          p_raw_content,
          p_raw_payload,
          p_timestamp,
        } = params;

        // Customer & Identity
        let customerId: string;
        let isNewCustomer = false;
        const existingIdent = database.identities.find(
          (i: any) => i.company_id === p_company_id && i.channel === 'ZALO' && i.external_id === p_zalo_user_uid
        );

        if (existingIdent) {
          customerId = existingIdent.customer_id;
        } else {
          isNewCustomer = true;
          customerId = `cust_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          database.customers.push({
            id: customerId,
            company_id: p_company_id,
            name: p_user_name || `Khách Zalo ${p_zalo_user_uid.slice(-4)}`,
            source: 'ZALO_OA',
            stage: 'LEAD_NEW',
            created_at: new Date().toISOString(),
          });
          database.identities.push({
            id: `ident_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            company_id: p_company_id,
            customer_id: customerId,
            channel: 'ZALO',
            external_id: p_zalo_user_uid,
            verified: false,
            metadata: { zalo_uid: p_zalo_user_uid },
            created_at: new Date().toISOString(),
          });
        }

        // Conversation
        let conversationId: string;
        const existingConv = database.conversations.find(
          (c: any) => c.company_id === p_company_id && c.channel === 'ZALO' && c.external_conversation_id === p_zalo_user_uid
        );

        if (existingConv) {
          conversationId = existingConv.id;
          existingConv.last_message_at = new Date().toISOString();
          if (p_is_inbound) {
            existingConv.unread_count = (existingConv.unread_count || 0) + 1;
          }
          existingConv.status = 'OPEN';
          existingConv.updated_at = new Date().toISOString();
        } else {
          conversationId = `conv_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          database.conversations.push({
            id: conversationId,
            company_id: p_company_id,
            customer_id: customerId,
            channel: 'ZALO',
            external_conversation_id: p_zalo_user_uid,
            last_message_at: new Date().toISOString(),
            unread_count: p_is_inbound ? 1 : 0,
            status: 'OPEN',
            created_at: new Date().toISOString(),
          });
        }

        // Interaction (external_ref is namespaced)
        const interactionId = `int_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        database.interactions.push({
          id: interactionId,
          company_id: p_company_id,
          customer_id: customerId,
          conversation_id: conversationId,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: p_is_inbound ? 'INBOUND' : 'OUTBOUND',
          sanitized_content: p_sanitized_content,
          sanitization_status: 'SUCCEEDED',
          sanitized_at: new Date().toISOString(),
          sanitizer_version: 'v1.0',
          external_ref: p_external_ref, // Lỗi 13 fix: namespacedExternalRef
          actor_type: p_is_inbound ? 'CUSTOMER' : 'SALE',
          created_at: new Date().toISOString(),
        });

        // Private raw content (rawMsgId stored in source_metadata.provider_msg_id)
        database.interaction_raw_contents.push({
          interaction_id: interactionId,
          company_id: p_company_id,
          raw_content: p_raw_content,
          raw_payload: p_raw_payload,
          source_metadata: {
            oa_id: p_oa_id,
            sender_id: p_sender_id,
            recipient_id: p_recipient_id,
            timestamp: p_timestamp,
            event_name: p_event_name,
            provider_msg_id: p_raw_msg_id,
          },
          created_at: new Date().toISOString(),
        });

        // Mark ingress event as PROCESSED
        const ingressEvent = database.zalo_ingress_events.find(
          (e: any) => e.company_id === p_company_id && e.oa_id === p_oa_id && e.external_ref === p_external_ref
        );
        if (ingressEvent) {
          ingressEvent.status = 'PROCESSED';
          ingressEvent.lease_until = null;
          ingressEvent.last_error = null;
          ingressEvent.updated_at = new Date().toISOString();
        }

        return {
          data: {
            customer_id: customerId,
            conversation_id: conversationId,
            interaction_id: interactionId,
            is_new_customer: isNewCustomer,
          },
          error: null,
        };
      }

      // 3. zalo_finalize_outbound_reply
      if (fnName === 'zalo_finalize_outbound_reply') {
        if (database._failOutboundFinalize) {
          return {
            data: null,
            error: { message: 'Database transaction failed during outbound reply finalization' },
          };
        }

        const {
          p_company_id,
          p_delivery_id,
          p_conversation_id,
          p_customer_id,
          p_recipient_zalo_uid,
          p_content,
          p_sanitized_content,
          p_provider_msg_id,
          p_actor_type,
          p_actor_user_id,
          p_raw_payload,
        } = params;

        const interactionId = `int_out_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        database.interactions.push({
          id: interactionId,
          company_id: p_company_id,
          customer_id: p_customer_id,
          conversation_id: p_conversation_id,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: 'OUTBOUND',
          sanitized_content: p_sanitized_content,
          sanitization_status: 'SUCCEEDED',
          sanitized_at: new Date().toISOString(),
          sanitizer_version: 'v1.0',
          external_ref: p_provider_msg_id,
          actor_type: p_actor_type || 'SALE',
          actor_user_id: p_actor_user_id,
          created_at: new Date().toISOString(),
        });

        database.interaction_raw_contents.push({
          interaction_id: interactionId,
          company_id: p_company_id,
          raw_content: p_content,
          raw_payload: p_raw_payload,
          source_metadata: {
            recipient_zalo_id: p_recipient_zalo_uid,
            actor_user_id: p_actor_user_id,
            provider_msg_id: p_provider_msg_id,
          },
          created_at: new Date().toISOString(),
        });

        // Update conversation
        const conv = database.conversations.find((c: any) => c.id === p_conversation_id);
        if (conv) {
          conv.last_message_at = new Date().toISOString();
          conv.updated_at = new Date().toISOString();
        }

        // Update delivery
        if (p_delivery_id) {
          const delivery = database.zalo_outbound_deliveries.find((d: any) => d.id === p_delivery_id);
          if (delivery) {
            delivery.status = 'SENT';
            delivery.provider_msg_id = p_provider_msg_id;
            delivery.interaction_id = interactionId;
            delivery.lease_until = null;
            delivery.updated_at = new Date().toISOString();
          }
        }

        return { data: interactionId, error: null };
      }

      // 4. care_scheduler_claim_delivery
      if (fnName === 'care_scheduler_claim_delivery') {
        const { p_company_id, p_schedule_id, p_customer_id, p_target_date, p_message_content } = params;
        const list = database.care_deliveries;
        const existing = list.find(
          (d: any) => d.care_schedule_id === p_schedule_id && d.send_target_date === p_target_date
        );

        const nowTime = Date.now();

        if (!existing) {
          const newId = `care_deliv_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          list.push({
            id: newId,
            company_id: p_company_id,
            customer_id: p_customer_id,
            channel: 'ZALO',
            care_schedule_id: p_schedule_id,
            send_target_date: p_target_date,
            idempotency_key: `care_sched:${p_schedule_id}:${p_target_date}:ZALO`,
            message_content: p_message_content,
            status: 'SENDING',
            lease_until: new Date(Date.now() + 300000).toISOString(),
            attempt_count: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          return { data: newId, error: null };
        }

        const leaseTime = existing.lease_until ? new Date(existing.lease_until).getTime() : 0;
        if (existing.status === 'FAILED' || (existing.status === 'SENDING' && leaseTime < nowTime)) {
          existing.status = 'SENDING';
          existing.lease_until = new Date(Date.now() + 300000).toISOString();
          existing.attempt_count = (existing.attempt_count || 0) + 1;
          existing.updated_at = new Date().toISOString();
          return { data: existing.id, error: null };
        }

        // Already SENT or active SENDING lease: Cannot claim
        return { data: null, error: null };
      }

      return { data: null, error: new Error(`Unknown RPC function ${fnName}`) };
    },
    _db: database,
  };

  return client;
}
