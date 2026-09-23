import assert from 'assert';

// Resilient fallback for server-only when tsx is executed directly without --conditions=react-server
try {
    const serverOnlyPath = require.resolve('server-only');
    require.cache[serverOnlyPath] = {
        id: serverOnlyPath,
        filename: serverOnlyPath,
        loaded: true,
        exports: {},
    } as any;
} catch {
    // Ignore
}

import type { SettableInstallationStatus } from '../../features/installation/types';
import type { SettableProductionStatus } from '../../features/production/types';

/**
 * In-Memory Mock Supabase Client Builder
 * Hỗ trợ mô phỏng chính xác các thao tác DB của Supabase Query Builder:
 * from(), select(), insert(), update(), delete(), eq(), single(), maybeSingle()
 * Hỗ trợ mock Supabase Storage: storage.from(bucket).upload(), list(), exists()
 * Hỗ trợ mock Postgres RPC Transaction: rpc(fnName, args) cho tính nguyên tử (Atomicity - P0)
 * Hỗ trợ simulate lỗi để kiểm tra Atomicity & Rollback (P0).
 */
function createMockClient(
    initialData: {
        contracts?: any[];
        orders?: any[];
        production_orders?: any[];
        installations?: any[];
        warranty_tickets?: any[];
        audit_logs?: any[];
        appointments?: any[];
        company_members?: any[];
        storageFiles?: { [bucket: string]: string[] };
    },
    options?: {
        failTables?: { [table: string]: 'insert' | 'update' | 'delete' | 'all' };
        failStorage?: { [bucket: string]: 'upload' | 'list' };
        failRpc?: string;
        disableRpc?: boolean;
    }
) {
    const db: Record<string, any[]> = {
        contracts: initialData.contracts ? [...initialData.contracts] : [],
        orders: initialData.orders ? [...initialData.orders] : [],
        production_orders: initialData.production_orders ? [...initialData.production_orders] : [],
        installations: initialData.installations ? [...initialData.installations] : [],
        warranty_tickets: initialData.warranty_tickets ? [...initialData.warranty_tickets] : [],
        audit_logs: initialData.audit_logs ? [...initialData.audit_logs] : [],
        appointments: initialData.appointments ? [...initialData.appointments] : [],
        company_members: initialData.company_members ? [...initialData.company_members] : [],
    };

    const updateCalls: Array<{ table: string; payload: any; filters: Record<string, any> }> = [];
    const insertCalls: Array<{ table: string; payload: any }> = [];

    const storageFiles: Record<string, Set<string>> = {
        'installation-docs': new Set(initialData.storageFiles?.['installation-docs'] || []),
    };

    function queryBuilder(table: string) {
        let filters: Record<string, any> = {};
        let updatePayload: any = null;
        let insertPayload: any = null;
        let isDelete = false;

        const builder: any = {
            eq(field: string, value: any) {
                filters[field] = value;
                return builder;
            },
            select(_fields?: string) {
                return builder;
            },
            delete() {
                isDelete = true;
                return builder;
            },
            insert(payload: any) {
                insertPayload = payload;
                if (!options?.failTables?.[table] || (options.failTables[table] !== 'insert' && options.failTables[table] !== 'all')) {
                    const row = {
                        id: payload.id || `mock-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        ...payload,
                    };
                    if (!db[table]) db[table] = [];
                    db[table].push(row);
                    insertCalls.push({ table, payload: row });
                }
                return builder;
            },
            update(payload: any) {
                updatePayload = payload;
                return builder;
            },
            async maybeSingle() {
                const rows = (db[table] || []).filter((item) => {
                    return Object.entries(filters).every(([k, v]) => item[k] === v);
                });
                return { data: rows.length > 0 ? { ...rows[0] } : null, error: null };
            },
            async single() {
                if (isDelete) {
                    if (options?.failTables?.[table] === 'delete' || options?.failTables?.[table] === 'all') {
                        return { data: null, error: { message: `Simulated delete error on ${table}` } };
                    }
                    const deleted = (db[table] || []).filter((item) => {
                        return Object.entries(filters).every(([k, v]) => item[k] === v);
                    });
                    db[table] = (db[table] || []).filter((item) => {
                        return !Object.entries(filters).every(([k, v]) => item[k] === v);
                    });
                    return { data: deleted[0] ? { ...deleted[0] } : null, error: null };
                }

                if (updatePayload) {
                    if (options?.failTables?.[table] === 'update' || options?.failTables?.[table] === 'all') {
                        return { data: null, error: { message: `Simulated update error on ${table}` } };
                    }
                    const rows = (db[table] || []).filter((item) => {
                        return Object.entries(filters).every(([k, v]) => item[k] === v);
                    });
                    if (rows.length === 0) {
                        return { data: null, error: { message: `Record not found for update in ${table}` } };
                    }
                    rows.forEach((row) => Object.assign(row, updatePayload));
                    updateCalls.push({ table, payload: updatePayload, filters: { ...filters } });
                    return { data: { ...rows[0] }, error: null };
                }

                if (insertPayload) {
                    if (options?.failTables?.[table] === 'insert' || options?.failTables?.[table] === 'all') {
                        return { data: null, error: { message: `Simulated insert error on ${table}` } };
                    }
                    const lastInserted = db[table][db[table].length - 1];
                    return { data: { ...lastInserted }, error: null };
                }

                const rows = (db[table] || []).filter((item) => {
                    return Object.entries(filters).every(([k, v]) => item[k] === v);
                });
                if (rows.length === 0) {
                    return { data: null, error: { message: `Record not found in ${table}` } };
                }
                return { data: { ...rows[0] }, error: null };
            },
        };

        builder.then = function (resolve: any, _reject: any) {
            if (isDelete) {
                if (options?.failTables?.[table] === 'delete' || options?.failTables?.[table] === 'all') {
                    resolve({ data: null, error: { message: `Simulated delete error on ${table}` } });
                    return;
                }
                const deleted = (db[table] || []).filter((item) => {
                    return Object.entries(filters).every(([k, v]) => item[k] === v);
                });
                db[table] = (db[table] || []).filter((item) => {
                    return !Object.entries(filters).every(([k, v]) => item[k] === v);
                });
                resolve({ data: deleted, error: null });
            } else if (updatePayload) {
                if (options?.failTables?.[table] === 'update' || options?.failTables?.[table] === 'all') {
                    resolve({ data: null, error: { message: `Simulated update error on ${table}` } });
                    return;
                }
                const rows = (db[table] || []).filter((item) => {
                    return Object.entries(filters).every(([k, v]) => item[k] === v);
                });
                rows.forEach((row) => Object.assign(row, updatePayload));
                updateCalls.push({ table, payload: updatePayload, filters: { ...filters } });
                resolve({ data: rows, error: null });
            } else if (insertPayload) {
                if (options?.failTables?.[table] === 'insert' || options?.failTables?.[table] === 'all') {
                    resolve({ data: null, error: { message: `Simulated insert error on ${table}` } });
                    return;
                }
                resolve({ data: insertPayload, error: null });
            } else {
                resolve({ data: db[table] || [], error: null });
            }
        };

        return builder;
    }

    const storage = {
        from: (bucket: string) => {
            if (!storageFiles[bucket]) storageFiles[bucket] = new Set();
            return {
                upload: async (path: string, _file: any, _opts?: any) => {
                    if (options?.failStorage?.[bucket] === 'upload') {
                        return { data: null, error: { message: `Simulated storage upload error on ${bucket}` } };
                    }
                    storageFiles[bucket].add(path);
                    return { data: { path }, error: null };
                },
                list: async (folder: string, listOptions?: { search?: string }) => {
                    if (options?.failStorage?.[bucket] === 'list') {
                        return { data: null, error: { message: `Simulated storage list error on ${bucket}` } };
                    }
                    const files = Array.from(storageFiles[bucket]);
                    const search = listOptions?.search;
                    const matched = files
                        .filter((f) => f.startsWith(folder ? `${folder}/` : ''))
                        .map((f) => {
                            const name = f.split('/').pop() || f;
                            return { name, id: name };
                        })
                        .filter((item) => !search || item.name.includes(search));
                    return { data: matched, error: null };
                },
                exists: async (path: string) => {
                    return { data: storageFiles[bucket].has(path), error: null };
                },
            };
        },
    };

    const client: any = {
        from: (table: string) => queryBuilder(table),
        storage,
        _db: db,
        _storageFiles: storageFiles,
        _updateCalls: updateCalls,
        _insertCalls: insertCalls,
    };

    if (!options?.disableRpc) {
        client.rpc = async (fnName: string, args: any) => {
            if (fnName === 'complete_installation_atomic') {
                if (options?.failTables?.audit_logs || options?.failRpc === 'complete_installation_atomic') {
                    return {
                        data: null,
                        error: { message: 'Transaction rolled back in complete_installation_atomic (audit_logs error)' },
                    };
                }
                if (options?.failTables?.orders) {
                    return {
                        data: null,
                        error: { message: 'Transaction rolled back in complete_installation_atomic (orders error)' },
                    };
                }
                const inst = db.installations.find((i) => i.company_id === args.p_company_id && i.id === args.p_installation_id);
                if (!inst) return { data: null, error: { message: 'RESOURCE_NOT_FOUND: Không tìm thấy thông tin lắp đặt.' } };
                if (inst.status !== 'HANDOVER_PENDING' && inst.status !== 'COMPLETED') {
                    return { data: null, error: { message: `INVALID_STATE_TRANSITION: Chỉ cho phép nghiệm thu ở HANDOVER_PENDING.` } };
                }
                const ord = db.orders.find((o) => o.company_id === args.p_company_id && o.id === inst.order_id);
                if (!ord) return { data: null, error: { message: 'RESOURCE_NOT_FOUND: Không tìm thấy thông tin đơn hàng.' } };

                inst.status = 'COMPLETED';
                inst.completed_at = args.p_completed_at || new Date().toISOString();
                ord.order_status = 'COMPLETED';
                db.audit_logs.push({
                    id: `audit-${Date.now()}`,
                    company_id: args.p_company_id,
                    user_id: args.p_actor_id,
                    action: 'COMPLETE_INSTALLATION_AND_HANDOVER',
                    resource_type: 'installations',
                    resource_id: args.p_installation_id,
                    result: 'SUCCESS',
                    metadata: { to_status: 'COMPLETED' },
                });
                return { data: { success: true, installation_id: args.p_installation_id, order_id: inst.order_id }, error: null };
            }

            if (fnName === 'record_quality_check_atomic') {
                if (options?.failTables?.audit_logs || options?.failRpc === 'record_quality_check_atomic') {
                    return {
                        data: null,
                        error: { message: 'Transaction rolled back in record_quality_check_atomic (audit_logs error)' },
                    };
                }
                if (options?.failTables?.orders) {
                    return {
                        data: null,
                        error: { message: 'Transaction rolled back in record_quality_check_atomic (orders error)' },
                    };
                }
                const prod = db.production_orders.find((p) => p.company_id === args.p_company_id && p.id === args.p_production_order_id);
                if (!prod) return { data: null, error: { message: 'RESOURCE_NOT_FOUND: Không tìm thấy lệnh sản xuất.' } };
                if (prod.status !== 'QC_IN_PROGRESS') {
                    return { data: null, error: { message: `INVALID_STATE_TRANSITION: Lệnh xưởng phải ở trạng thái QC_IN_PROGRESS.` } };
                }
                const nextStatus = args.p_qc_status === 'PASSED' ? 'READY_FOR_DISPATCH' : 'QC_FAILED';
                prod.status = nextStatus;
                prod.qc_status = args.p_qc_status;
                if (args.p_qc_status === 'PASSED') {
                    const ord = db.orders.find((o) => o.company_id === args.p_company_id && o.id === prod.order_id);
                    if (ord) ord.order_status = 'READY_FOR_INSTALL';
                }
                db.audit_logs.push({
                    id: `audit-${Date.now()}`,
                    company_id: args.p_company_id,
                    user_id: args.p_inspector_id,
                    action: 'RECORD_QUALITY_CHECK',
                    resource_type: 'production_orders',
                    resource_id: args.p_production_order_id,
                    result: 'SUCCESS',
                    metadata: { to_status: nextStatus },
                });
                return { data: { success: true, status: nextStatus }, error: null };
            }

            return { data: null, error: { message: `Unknown RPC function: ${fnName}` } };
        };
    }

    return client;
}

async function runTests() {
    const { AuthError } = await import('../../lib/auth/context');
    const {
        createProductionOrder,
        recordQualityCheck,
        updateProductionProgress,
    } = await import('../../features/production/production-service');
    const {
        attachInstallationEvidence,
        completeInstallationAndHandover,
        scheduleInstallation,
        updateInstallationStatus,
        isValidInstallationStorageRef,
        isValidCanonicalInstallationStorageRef,
    } = await import('../../features/installation/installation-service');
    const {
        assignWarrantyTicket,
        createWarrantyTicket,
        reopenWarrantyTicket,
        updateWarrantyStatus,
        VALID_WARRANTY_TRANSITIONS,
    } = await import('../../features/warranty/warranty-service');

    console.log('================================================================');
    console.log('BẮT ĐẦU BỘ KIỂM THỬ THỰC CHẤT BẢO MẬT & VẬN HÀNH (MEMBER 8)');
    console.log('================================================================\n');

    const COMPANY_ID = 'comp-test-001';
    const ORDER_ID = 'order-test-101';
    const CUSTOMER_ID = 'cust-test-201';
    const APPOINTMENT_ID = 'appt-test-301';
    const INSTALLATION_ID = 'inst-test-401';
    const TECH_USER_1 = 'tech-user-001';
    const TECH_USER_2 = 'tech-user-002';
    const BOSS_USER = 'boss-admin-001';

    // Canonical test paths
    const CANONICAL_PHOTO = `${COMPANY_ID}/installations/${INSTALLATION_ID}/photo_01.jpg`;
    const CANONICAL_HANDOVER = `${COMPANY_ID}/installations/${INSTALLATION_ID}/handover_01.pdf`;

    // =========================================================================
    // TEST 1: Chặn TECHNICIAN sửa/hoàn tất installation khi không phải assignee (P0)
    // =========================================================================
    console.log('▶ TEST 1: Chặn TECHNICIAN sửa/hoàn tất installation khi không phải assignee');
    {
        const mockUnauthorizedTech = createMockClient({
            appointments: [
                {
                    id: APPOINTMENT_ID,
                    company_id: COMPANY_ID,
                    assignee_id: TECH_USER_1,
                    status: 'ASSIGNED',
                    type: 'INSTALLATION',
                },
            ],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'SCHEDULED',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'READY_FOR_INSTALL' }],
        });

        await assert.rejects(
            async () => {
                await updateInstallationStatus(
                    COMPANY_ID,
                    INSTALLATION_ID,
                    'IN_TRANSIT',
                    mockUnauthorizedTech,
                    { userId: TECH_USER_2, role: 'TECHNICIAN' }
                );
            },
            (err: any) => {
                assert.ok(err instanceof AuthError, 'Phải ném lỗi kiểu AuthError');
                assert.strictEqual(err.status, 403, 'Mã lỗi phải là 403');
                assert.ok(err.message.includes('Bạn không được phân công thực hiện công việc này'));
                return true;
            },
            'Phải chặn Kỹ thuật viên không được phân công cập nhật tiến độ'
        );

        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockUnauthorizedTech,
                    { userId: TECH_USER_2, role: 'TECHNICIAN' }
                );
            },
            (err: any) => {
                assert.ok(err instanceof AuthError, 'Phải ném lỗi kiểu AuthError');
                assert.strictEqual(err.status, 403);
                assert.ok(err.message.includes('Bạn không được phân công thực hiện công việc này'));
                return true;
            },
            'Phải chặn Kỹ thuật viên không được phân công nghiệm thu'
        );

        const mockCancelledAppt = createMockClient({
            appointments: [
                {
                    id: APPOINTMENT_ID,
                    company_id: COMPANY_ID,
                    assignee_id: TECH_USER_1,
                    status: 'CANCELLED',
                    type: 'INSTALLATION',
                },
            ],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'SCHEDULED',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'READY_FOR_INSTALL' }],
        });

        await assert.rejects(
            async () => {
                await updateInstallationStatus(
                    COMPANY_ID,
                    INSTALLATION_ID,
                    'IN_TRANSIT',
                    mockCancelledAppt,
                    { userId: TECH_USER_1, role: 'TECHNICIAN' }
                );
            },
            (err: any) => {
                assert.ok(err instanceof AuthError);
                assert.strictEqual(err.status, 403);
                assert.ok(err.message.includes('Bạn không được phân công thực hiện công việc này'));
                return true;
            },
            'Phải chặn khi lịch hẹn liên kết không ở trạng thái hợp lệ'
        );

        const mockValidTech = createMockClient({
            appointments: [
                {
                    id: APPOINTMENT_ID,
                    company_id: COMPANY_ID,
                    assignee_id: TECH_USER_1,
                    status: 'IN_PROGRESS',
                    type: 'INSTALLATION',
                },
            ],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'SCHEDULED',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'READY_FOR_INSTALL' }],
        });

        await updateInstallationStatus(
            COMPANY_ID,
            INSTALLATION_ID,
            'IN_TRANSIT',
            mockValidTech,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        assert.strictEqual(
            mockValidTech._db.installations[0].status,
            'IN_TRANSIT',
            'Kỹ thuật viên được phân công phải cập nhật thành công'
        );

        console.log('  ✔ Test 1 ĐẠT: Khoanh vùng quyền Kỹ thuật viên qua appointments.assignee_id chuẩn xác (403).');
    }

    // =========================================================================
    // TEST 2: Chặn gọi generic status update lên 'COMPLETED' & State Machine Lắp đặt (P0 & P1)
    // =========================================================================
    console.log('▶ TEST 2: Chặn gọi generic status update lên "COMPLETED" & State Machine Lắp đặt');
    {
        const mockClient = createMockClient({
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'SCHEDULED',
                },
            ],
        });

        await assert.rejects(
            async () => {
                await updateInstallationStatus(
                    COMPANY_ID,
                    INSTALLATION_ID,
                    'COMPLETED' as unknown as SettableInstallationStatus,
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes("'COMPLETED' không được phép cập nhật trực tiếp"),
                    `Thông điệp lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn tuyệt đối cửa sau COMPLETED qua hàm cập nhật thông thường'
        );

        await assert.rejects(
            async () => {
                await updateInstallationStatus(
                    COMPANY_ID,
                    INSTALLATION_ID,
                    'HANDOVER_PENDING',
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('Chuyển đổi trạng thái lắp đặt không hợp lệ'),
                    `Thông điệp lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn nhảy cóc trạng thái trái phép'
        );

        await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'IN_TRANSIT', mockClient);
        assert.strictEqual(mockClient._db.installations[0].status, 'IN_TRANSIT');

        await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'INSTALLING', mockClient);
        assert.strictEqual(mockClient._db.installations[0].status, 'INSTALLING');

        await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'TESTING', mockClient);
        assert.strictEqual(mockClient._db.installations[0].status, 'TESTING');

        await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'HANDOVER_PENDING', mockClient);
        assert.strictEqual(mockClient._db.installations[0].status, 'HANDOVER_PENDING');

        console.log('  ✔ Test 2 ĐẠT: Đã chặn triệt để cửa sau COMPLETED và kiểm soát State Machine lắp đặt.');
    }

    // =========================================================================
    // TEST A (P0): Khóa State Machine nghiệm thu lắp đặt (chỉ cho phép ở HANDOVER_PENDING)
    // =========================================================================
    console.log('▶ TEST A (P0): Khóa State Machine nghiệm thu lắp đặt (chỉ cho phép ở HANDOVER_PENDING)');
    {
        const mockInstalling = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS', type: 'INSTALLATION' }],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'INSTALLING',
                    photos: [CANONICAL_PHOTO],
                    handover_ref: CANONICAL_HANDOVER,
                },
            ],
            storageFiles: {
                'installation-docs': [CANONICAL_PHOTO, CANONICAL_HANDOVER],
            },
        });

        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockInstalling
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('HANDOVER_PENDING'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn nghiệm thu khi đơn lắp đặt chưa ở HANDOVER_PENDING'
        );

        const mockInvalidAppt = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'SCHEDULED', type: 'INSTALLATION' }],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'HANDOVER_PENDING',
                    photos: [CANONICAL_PHOTO],
                    handover_ref: CANONICAL_HANDOVER,
                },
            ],
            storageFiles: {
                'installation-docs': [CANONICAL_PHOTO, CANONICAL_HANDOVER],
            },
        });

        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockInvalidAppt
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('Lịch hẹn liên kết'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn nghiệm thu khi lịch hẹn liên kết chưa ở IN_PROGRESS/ACCEPTED'
        );

        const mockInvalidOrder = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS', type: 'INSTALLATION' }],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'HANDOVER_PENDING',
                    photos: [CANONICAL_PHOTO],
                    handover_ref: CANONICAL_HANDOVER,
                },
            ],
            storageFiles: {
                'installation-docs': [CANONICAL_PHOTO, CANONICAL_HANDOVER],
            },
        });

        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockInvalidOrder
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('Đơn hàng liên kết'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn nghiệm thu khi đơn hàng không ở READY_FOR_INSTALL/INSTALLING'
        );

        console.log('  ✔ Test A ĐẠT: Khóa cứng State Machine nghiệm thu, bắt buộc HANDOVER_PENDING và kiểm tra linked appointments & orders.');
    }

    // =========================================================================
    // TEST B (P0): Khóa Toàn diện Storage Evidence Phía Server (Canonical & Bucket Verification)
    // =========================================================================
    console.log('▶ TEST B (P0): Khắc phục Storage Evidence do Browser tự khai (attachInstallationEvidence & canonical DB check)');
    {
        const mockClient = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS', assignee_id: TECH_USER_1, type: 'INSTALLATION' }],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'HANDOVER_PENDING',
                    photos: [],
                    handover_ref: null,
                },
            ],
        });

        // B0: Kiểm tra tính an toàn của hàm thẩm định đường dẫn lưu trữ
        assert.strictEqual(isValidInstallationStorageRef('installation-docs/proof.jpg'), true, 'Đường dẫn installation-docs phải hợp lệ');
        assert.strictEqual(isValidInstallationStorageRef('https://evil.com/fake.jpg'), false, 'URL bên ngoài không đáng tin cậy phải bị chặn');
        assert.strictEqual(isValidInstallationStorageRef('malicious_executable.exe'), false, 'Chuỗi ngẫu nhiên phải bị chặn');

        // B0.1: Kiểm tra hàm thẩm định canonical path chuẩn theo công ty và mã lắp đặt
        assert.strictEqual(
            isValidCanonicalInstallationStorageRef(COMPANY_ID, INSTALLATION_ID, CANONICAL_PHOTO),
            true,
            'Canonical path theo công ty và mã lắp đặt phải hợp lệ'
        );
        assert.strictEqual(
            isValidCanonicalInstallationStorageRef(COMPANY_ID, INSTALLATION_ID, 'other-company/installations/' + INSTALLATION_ID + '/photo.jpg'),
            false,
            'Sai công ty phải bị chặn'
        );
        assert.strictEqual(
            isValidCanonicalInstallationStorageRef(COMPANY_ID, INSTALLATION_ID, COMPANY_ID + '/installations/other-inst/photo.jpg'),
            false,
            'Sai mã lắp đặt phải bị chặn'
        );
        assert.strictEqual(
            isValidCanonicalInstallationStorageRef(COMPANY_ID, INSTALLATION_ID, 'installation-docs/fake.jpg'),
            false,
            'FileKey tự chế không thuộc canonical path phải bị chặn'
        );

        // Ba: Chặn attachInstallationEvidence khi fileKey là file tự chế hoặc link ngoài
        await assert.rejects(
            async () => {
                await attachInstallationEvidence(
                    COMPANY_ID,
                    {
                        installationId: INSTALLATION_ID,
                        fileKey: 'fake_browser_self_declared_path.exe',
                        type: 'photo',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('INVALID_STORAGE_REF'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn đính kèm tài liệu với fileKey không thuộc canonical structure'
        );

        // Ba2: Chặn attachInstallationEvidence khi fileKey tự chế kiểu installation-docs/fake.jpg
        await assert.rejects(
            async () => {
                await attachInstallationEvidence(
                    COMPANY_ID,
                    {
                        installationId: INSTALLATION_ID,
                        fileKey: 'installation-docs/fake.jpg',
                        type: 'photo',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('INVALID_STORAGE_REF'));
                return true;
            },
            'Phải chặn tuyệt đối fileKey tự chế installation-docs/fake.jpg'
        );

        // Ba3: Chặn attachInstallationEvidence khi fileKey có canonical path nhưng CHƯA TỒN TẠI trong Storage
        await assert.rejects(
            async () => {
                await attachInstallationEvidence(
                    COMPANY_ID,
                    {
                        installationId: INSTALLATION_ID,
                        fileKey: CANONICAL_PHOTO,
                        type: 'photo',
                    },
                    mockClient,
                    { userId: TECH_USER_1, role: 'TECHNICIAN' }
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('STORAGE_OBJECT_NOT_FOUND'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn khi file chưa được upload thực sự lên Storage bucket'
        );

        // Bb: Chặn completeInstallationAndHandover khi DB chưa có photos hoặc handover_ref (Fail-closed)
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('MISSING_EVIDENCE'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn nghiệm thu nếu DB chưa có đầy đủ bằng chứng'
        );

        // Bc: Upload tệp hợp lệ lên mock Storage rồi đính kèm ảnh
        await mockClient.storage.from('installation-docs').upload(CANONICAL_PHOTO, Buffer.from('mock photo data'));
        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: INSTALLATION_ID,
                fileKey: CANONICAL_PHOTO,
                type: 'photo',
            },
            mockClient,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );

        // Vẫn chưa có handover_ref -> Vẫn phải chặn
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('MISSING_EVIDENCE'));
                return true;
            },
            'Phải chặn khi mới chỉ có photos mà chưa có handover_ref'
        );

        // Bd: Upload tệp biên bản bàn giao lên mock Storage rồi đính kèm
        await mockClient.storage.from('installation-docs').upload(CANONICAL_HANDOVER, Buffer.from('mock pdf data'));
        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: INSTALLATION_ID,
                fileKey: CANONICAL_HANDOVER,
                type: 'handover',
            },
            mockClient,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );

        // Be: Bây giờ đã đủ evidence canonical và tồn tại trong bucket -> Nghiệm thu thành công!
        await completeInstallationAndHandover(
            COMPANY_ID,
            { installationId: INSTALLATION_ID },
            mockClient
        );

        assert.strictEqual(mockClient._db.installations[0].status, 'COMPLETED');
        assert.strictEqual(mockClient._db.orders[0].order_status, 'COMPLETED');

        console.log('  ✔ Test B ĐẠT: Server tự đọc evidence từ DB qua attachInstallationEvidence, fail-closed triệt để khi thiếu chứng từ.');
    }

    // =========================================================================
    // TEST C (P0): Chặn updateProductionProgress nhảy cóc sang READY_FOR_DISPATCH hoặc QC_PASSED
    // =========================================================================
    console.log('▶ TEST C (P0): Chặn updateProductionProgress nhảy cóc sang READY_FOR_DISPATCH / QC_PASSED');
    {
        const PROD_ID = 'po-test-state-c';
        const mockProdClient = createMockClient({
            production_orders: [
                {
                    id: PROD_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'IN_PRODUCTION',
                    qc_status: 'PENDING',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            audit_logs: [],
        });

        await assert.rejects(
            async () => {
                await updateProductionProgress(
                    COMPANY_ID,
                    {
                        productionOrderId: PROD_ID,
                        status: 'QC_PASSED' as unknown as SettableProductionStatus,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockProdClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('recordQualityCheck'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn generic update set QC_PASSED'
        );

        await assert.rejects(
            async () => {
                await updateProductionProgress(
                    COMPANY_ID,
                    {
                        productionOrderId: PROD_ID,
                        status: 'READY_FOR_DISPATCH' as unknown as SettableProductionStatus,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockProdClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('recordQualityCheck'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn generic update set READY_FOR_DISPATCH'
        );

        await assert.rejects(
            async () => {
                await updateProductionProgress(
                    COMPANY_ID,
                    {
                        productionOrderId: PROD_ID,
                        status: 'QC_FAILED' as unknown as SettableProductionStatus,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockProdClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('recordQualityCheck'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn generic update set QC_FAILED'
        );

        await updateProductionProgress(
            COMPANY_ID,
            {
                productionOrderId: PROD_ID,
                status: 'QC_IN_PROGRESS',
            },
            undefined,
            undefined,
            undefined,
            mockProdClient
        );
        assert.strictEqual(mockProdClient._db.production_orders[0].status, 'QC_IN_PROGRESS');

        console.log('  ✔ Test C ĐẠT: Đã loại bỏ hoàn toàn QC_PASSED/QC_FAILED/READY_FOR_DISPATCH khỏi updateProductionProgress.');
    }

    // =========================================================================
    // TEST D (P0): Chặn recordQualityCheck khi lệnh xưởng chưa ở QC_IN_PROGRESS
    // =========================================================================
    console.log('▶ TEST D (P0): Chặn recordQualityCheck khi lệnh xưởng chưa ở QC_IN_PROGRESS');
    {
        const PROD_ID = 'po-test-state-d';
        const mockProdClient = createMockClient({
            production_orders: [
                {
                    id: PROD_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'IN_PRODUCTION',
                    qc_status: 'PENDING',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            audit_logs: [],
        });

        await assert.rejects(
            async () => {
                await recordQualityCheck(
                    COMPANY_ID,
                    {
                        productionOrderId: PROD_ID,
                        qcStatus: 'PASSED',
                        inspectorId: BOSS_USER,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockProdClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('QC_IN_PROGRESS'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn duyệt QC khi lệnh xưởng chưa chuyển sang QC_IN_PROGRESS'
        );

        mockProdClient._db.production_orders[0].status = 'QC_IN_PROGRESS';

        await recordQualityCheck(
            COMPANY_ID,
            {
                productionOrderId: PROD_ID,
                qcStatus: 'PASSED',
                inspectorId: BOSS_USER,
            },
            undefined,
            undefined,
            undefined,
            mockProdClient
        );

        assert.strictEqual(mockProdClient._db.production_orders[0].status, 'READY_FOR_DISPATCH');
        assert.strictEqual(mockProdClient._db.production_orders[0].qc_status, 'PASSED');
        assert.strictEqual(mockProdClient._db.orders[0].order_status, 'READY_FOR_INSTALL');

        console.log('  ✔ Test D ĐẠT: Kiểm tra chặt chẽ điều kiện QC_IN_PROGRESS trước khi duyệt QC và tự động kích hoạt READY_FOR_DISPATCH.');
    }

    // =========================================================================
    // TEST E (P1): Chặn gán kỹ thuật viên vào ticket bảo hành đã RESOLVED/CLOSED & State Machine
    // =========================================================================
    console.log('▶ TEST E (P1): Chặn gán kỹ thuật viên vào ticket bảo hành đã RESOLVED/CLOSED & State Machine');
    {
        // Kiểm tra khai báo cấu trúc VALID_WARRANTY_TRANSITIONS
        assert.deepStrictEqual(VALID_WARRANTY_TRANSITIONS.OPEN, ['ASSIGNED', 'CANCELLED']);
        assert.deepStrictEqual(VALID_WARRANTY_TRANSITIONS.ASSIGNED, ['IN_PROGRESS', 'OPEN', 'CANCELLED']);
        assert.deepStrictEqual(VALID_WARRANTY_TRANSITIONS.IN_PROGRESS, ['RESOLVED', 'FAILED']);
        assert.deepStrictEqual(VALID_WARRANTY_TRANSITIONS.RESOLVED, ['CLOSED', 'REOPENED']);
        assert.deepStrictEqual(VALID_WARRANTY_TRANSITIONS.CLOSED, ['REOPENED']);
        assert.deepStrictEqual(VALID_WARRANTY_TRANSITIONS.REOPENED, ['ASSIGNED', 'IN_PROGRESS']);

        const TICKET_ID = 'wt-test-e-001';
        const mockClient = createMockClient({
            company_members: [
                {
                    id: 'cm-tech-1',
                    company_id: COMPANY_ID,
                    user_id: TECH_USER_1,
                    role: 'TECHNICIAN',
                    status: 'ACTIVE',
                },
            ],
            warranty_tickets: [
                {
                    id: TICKET_ID,
                    company_id: COMPANY_ID,
                    status: 'RESOLVED',
                    assigned_to: TECH_USER_1,
                    notes: 'Đã xử lý xong',
                },
            ],
        });

        // Ea: Chặn gán kỹ thuật viên khi ticket đã RESOLVED
        await assert.rejects(
            async () => {
                await assignWarrantyTicket(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        technicianId: TECH_USER_1,
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('OPEN'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn phân công ticket khi đã RESOLVED'
        );

        // Eb: Chặn gán kỹ thuật viên khi ticket đã CLOSED
        mockClient._db.warranty_tickets[0].status = 'CLOSED';
        await assert.rejects(
            async () => {
                await assignWarrantyTicket(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        technicianId: TECH_USER_1,
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('INVALID_STATE_TRANSITION'));
                return true;
            },
            'Phải chặn phân công ticket khi đã CLOSED'
        );

        // Ec: Chặn updateWarrantyStatus cố gắng chuyển sang REOPENED trực tiếp
        mockClient._db.warranty_tickets[0].status = 'ASSIGNED';
        await assert.rejects(
            async () => {
                await updateWarrantyStatus(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        status: 'REOPENED',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('reopenWarrantyTicket'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn generic update nhảy sang REOPENED'
        );

        // Ed: Chặn updateWarrantyStatus trên ticket đã RESOLVED hoặc CLOSED
        mockClient._db.warranty_tickets[0].status = 'RESOLVED';
        await assert.rejects(
            async () => {
                await updateWarrantyStatus(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        status: 'IN_PROGRESS',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn update trên ticket đã RESOLVED/CLOSED'
        );

        // Ed2: Chặn transition không hợp lệ OPEN -> CLOSED (chỉ cho phép ASSIGNED hoặc CANCELLED)
        mockClient._db.warranty_tickets[0].status = 'OPEN';
        await assert.rejects(
            async () => {
                await updateWarrantyStatus(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        status: 'CLOSED',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('INVALID_STATE_TRANSITION'));
                return true;
            },
            'Phải chặn chuyển đổi trực tiếp OPEN -> CLOSED'
        );

        // Ed3: Chặn transition không hợp lệ RESOLVED -> ASSIGNED
        mockClient._db.warranty_tickets[0].status = 'RESOLVED';
        await assert.rejects(
            async () => {
                await updateWarrantyStatus(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        status: 'ASSIGNED',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('INVALID_STATE_TRANSITION'));
                return true;
            },
            'Phải chặn chuyển đổi RESOLVED -> ASSIGNED'
        );

        // Ee: Chặn tạo phiếu bảo hành khi đơn hàng chưa hoàn tất nghiệm thu COMPLETED
        const mockOrderNotCompleted = createMockClient({
            orders: [
                {
                    id: ORDER_ID,
                    company_id: COMPANY_ID,
                    customer_id: CUSTOMER_ID,
                    order_status: 'INSTALLING',
                },
            ],
        });

        await assert.rejects(
            async () => {
                await createWarrantyTicket(
                    COMPANY_ID,
                    {
                        customerId: CUSTOMER_ID,
                        orderId: ORDER_ID,
                        issue: 'Hở gioăng chắn nước',
                    },
                    mockOrderNotCompleted
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('COMPLETED'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn tạo phiếu bảo hành khi đơn hàng chưa COMPLETED'
        );

        // Ef: Chặn Kỹ thuật viên cập nhật phiếu bảo hành được giao cho người khác (403 AuthError)
        mockClient._db.warranty_tickets[0].status = 'ASSIGNED';
        mockClient._db.warranty_tickets[0].assigned_to = TECH_USER_1;

        await assert.rejects(
            async () => {
                await updateWarrantyStatus(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        status: 'IN_PROGRESS',
                    },
                    mockClient,
                    { userId: TECH_USER_2, role: 'TECHNICIAN' }
                );
            },
            (err: any) => {
                assert.ok(err instanceof AuthError, 'Phải ném AuthError');
                assert.strictEqual(err.status, 403);
                assert.ok(err.message.includes('Bạn không được phân công thực hiện phiếu bảo hành này'));
                return true;
            },
            'Phải chặn Kỹ thuật viên sửa ticket bảo hành của người khác'
        );

        // Eg: Chặn phân công cho nhân viên không có vai trò TECHNICIAN hoặc không ACTIVE
        const mockInvalidMember = createMockClient({
            company_members: [
                {
                    id: 'cm-sale-1',
                    company_id: COMPANY_ID,
                    user_id: 'sale-user-001',
                    role: 'SALE',
                    status: 'ACTIVE',
                },
            ],
            warranty_tickets: [
                {
                    id: 'wt-open-001',
                    company_id: COMPANY_ID,
                    status: 'OPEN',
                },
            ],
        });

        await assert.rejects(
            async () => {
                await assignWarrantyTicket(
                    COMPANY_ID,
                    {
                        ticketId: 'wt-open-001',
                        technicianId: 'sale-user-001',
                    },
                    mockInvalidMember
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('PERMISSION_DENIED'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn phân công bảo hành cho nhân viên không phải TECHNICIAN ACTIVE'
        );

        console.log('  ✔ Test E ĐẠT: Đã khóa State Machine bảo hành, kiểm tra chặt chẽ điều kiện COMPLETED và phân quyền Kỹ thuật viên.');
    }

    // =========================================================================
    // TEST H (P1): Kiểm tra Lịch hẹn Liên kết khi Lên lịch Lắp đặt (scheduleInstallation)
    // =========================================================================
    console.log('▶ TEST H (P1): Kiểm tra trạng thái appointment liên kết khi scheduleInstallation');
    {
        // Base valid data setup
        const baseOrder = { id: ORDER_ID, company_id: COMPANY_ID, customer_id: CUSTOMER_ID, order_status: 'READY_FOR_INSTALL' };
        const baseProdOrder = { id: 'po-test-h', company_id: COMPANY_ID, order_id: ORDER_ID, status: 'READY_FOR_DISPATCH' };

        // Ha: Lịch hẹn không tồn tại
        const mockNoAppt = createMockClient({
            orders: [baseOrder],
            production_orders: [baseProdOrder],
            appointments: [],
        });

        await assert.rejects(
            async () => {
                await scheduleInstallation(
                    COMPANY_ID,
                    { customerId: CUSTOMER_ID, orderId: ORDER_ID, appointmentId: 'non-existent-appt', crew: [TECH_USER_1] },
                    mockNoAppt
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('RESOURCE_NOT_FOUND'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn khi lịch hẹn không tồn tại'
        );

        // Hb: Lịch hẹn thuộc công ty khác
        const mockOtherCompanyAppt = createMockClient({
            orders: [baseOrder],
            production_orders: [baseProdOrder],
            appointments: [
                { id: 'appt-other-comp', company_id: 'other-company', type: 'INSTALLATION', status: 'ASSIGNED' },
            ],
        });

        await assert.rejects(
            async () => {
                await scheduleInstallation(
                    COMPANY_ID,
                    { customerId: CUSTOMER_ID, orderId: ORDER_ID, appointmentId: 'appt-other-comp', crew: [TECH_USER_1] },
                    mockOtherCompanyAppt
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('RESOURCE_NOT_FOUND'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn khi lịch hẹn thuộc công ty khác'
        );

        // Hc: Lịch hẹn không phải loại INSTALLATION (ví dụ SURVEY)
        const mockSurveyAppt = createMockClient({
            orders: [baseOrder],
            production_orders: [baseProdOrder],
            appointments: [
                { id: 'appt-survey-type', company_id: COMPANY_ID, type: 'SURVEY', status: 'ASSIGNED' },
            ],
        });

        await assert.rejects(
            async () => {
                await scheduleInstallation(
                    COMPANY_ID,
                    { customerId: CUSTOMER_ID, orderId: ORDER_ID, appointmentId: 'appt-survey-type', crew: [TECH_USER_1] },
                    mockSurveyAppt
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('INVALID_INPUT') && err.message.includes('INSTALLATION'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn khi lịch hẹn có type là SURVEY'
        );

        // Hd: Lịch hẹn có trạng thái không hợp lệ (ví dụ CANCELLED hoặc COMPLETED)
        const mockCancelledAppt = createMockClient({
            orders: [baseOrder],
            production_orders: [baseProdOrder],
            appointments: [
                { id: 'appt-cancelled-status', company_id: COMPANY_ID, type: 'INSTALLATION', status: 'CANCELLED' },
            ],
        });

        await assert.rejects(
            async () => {
                await scheduleInstallation(
                    COMPANY_ID,
                    { customerId: CUSTOMER_ID, orderId: ORDER_ID, appointmentId: 'appt-cancelled-status', crew: [TECH_USER_1] },
                    mockCancelledAppt
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('INVALID_STATE_TRANSITION'), `Lỗi: ${err.message}`);
                return true;
            },
            'Phải chặn khi lịch hẹn ở trạng thái CANCELLED'
        );

        // He: Lịch hẹn hợp lệ (type: INSTALLATION, status: ASSIGNED) -> Thành công
        const mockValidAppt = createMockClient({
            orders: [baseOrder],
            production_orders: [baseProdOrder],
            appointments: [
                { id: 'appt-valid-install', company_id: COMPANY_ID, type: 'INSTALLATION', status: 'ASSIGNED' },
            ],
        });

        const scheduled = await scheduleInstallation(
            COMPANY_ID,
            { customerId: CUSTOMER_ID, orderId: ORDER_ID, appointmentId: 'appt-valid-install', crew: [TECH_USER_1] },
            mockValidAppt
        );

        assert.strictEqual(scheduled.status, 'SCHEDULED');
        assert.strictEqual(mockValidAppt._db.installations[0].status, 'SCHEDULED');

        console.log('  ✔ Test H ĐẠT: Kiểm tra chặt chẽ điều kiện appointment liên kết trước khi scheduleInstallation.');
    }

    // =========================================================================
    // TEST G (P0): Bảo đảm Tính nguyên tử (Atomicity) & Transaction Rollback
    // =========================================================================
    console.log('▶ TEST G (P0): Bảo đảm tính nguyên tử (Atomicity) & Fail-closed Rollback khi lỗi');
    {
        // ---------------------------------------------------------------------
        // G-RPC 1: completeInstallationAndHandover qua Postgres RPC Atomicity
        // Khi audit_logs lỗi trong Postgres RPC, transaction tự động ROLLBACK:
        // installation không COMPLETED và order không COMPLETED.
        // ---------------------------------------------------------------------
        const mockRpcAuditFailClient = createMockClient(
            {
                appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS', type: 'INSTALLATION' }],
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
                installations: [
                    {
                        id: INSTALLATION_ID,
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        appointment_id: APPOINTMENT_ID,
                        status: 'HANDOVER_PENDING',
                        photos: [CANONICAL_PHOTO],
                        handover_ref: CANONICAL_HANDOVER,
                    },
                ],
                storageFiles: {
                    'installation-docs': [CANONICAL_PHOTO, CANONICAL_HANDOVER],
                },
            },
            { failTables: { audit_logs: 'insert' } } // Kích hoạt lỗi audit_logs trong RPC
        );

        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockRpcAuditFailClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('Transaction rolled back') || err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi RPC thất bại do audit_logs'
        );

        assert.strictEqual(
            mockRpcAuditFailClient._db.installations[0].status,
            'HANDOVER_PENDING',
            'Postgres Transaction đảm bảo installations không bị đổi sang COMPLETED khi RPC thất bại'
        );
        assert.strictEqual(
            mockRpcAuditFailClient._db.orders[0].order_status,
            'INSTALLING',
            'Postgres Transaction đảm bảo orders không bị đổi sang COMPLETED khi RPC thất bại'
        );

        // ---------------------------------------------------------------------
        // G-RPC 2: recordQualityCheck qua Postgres RPC Atomicity
        // Khi audit_logs lỗi trong Postgres RPC, production_order không READY_FOR_DISPATCH
        // và orders không READY_FOR_INSTALL.
        // ---------------------------------------------------------------------
        const mockRpcQcAuditFail = createMockClient(
            {
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
                production_orders: [
                    {
                        id: 'po-test-qc-rpc-fail',
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        status: 'QC_IN_PROGRESS',
                        qc_status: 'PENDING',
                    },
                ],
                audit_logs: [],
            },
            { failTables: { audit_logs: 'insert' } }
        );

        await assert.rejects(
            async () => {
                await recordQualityCheck(
                    COMPANY_ID,
                    {
                        productionOrderId: 'po-test-qc-rpc-fail',
                        qcStatus: 'PASSED',
                        inspectorId: BOSS_USER,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockRpcQcAuditFail
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('Transaction rolled back') || err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi QC RPC thất bại do audit_logs'
        );

        assert.strictEqual(
            mockRpcQcAuditFail._db.production_orders[0].status,
            'QC_IN_PROGRESS',
            'Postgres Transaction đảm bảo production_orders không đổi sang READY_FOR_DISPATCH khi RPC thất bại'
        );
        assert.strictEqual(
            mockRpcQcAuditFail._db.orders[0].order_status,
            'IN_PRODUCTION',
            'Postgres Transaction đảm bảo orders không đổi sang READY_FOR_INSTALL khi RPC thất bại'
        );

        // ---------------------------------------------------------------------
        // G-Fallback 1: completeInstallationAndHandover Fallback Rollback (khi disableRpc)
        // ---------------------------------------------------------------------
        const mockOrderFailClient = createMockClient(
            {
                appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS', type: 'INSTALLATION' }],
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
                installations: [
                    {
                        id: INSTALLATION_ID,
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        appointment_id: APPOINTMENT_ID,
                        status: 'HANDOVER_PENDING',
                        photos: [CANONICAL_PHOTO],
                        handover_ref: CANONICAL_HANDOVER,
                    },
                ],
                storageFiles: {
                    'installation-docs': [CANONICAL_PHOTO, CANONICAL_HANDOVER],
                },
            },
            { failTables: { orders: 'update' }, disableRpc: true }
        );

        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockOrderFailClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi cập nhật đơn hàng thất bại'
        );

        assert.strictEqual(
            mockOrderFailClient._db.installations[0].status,
            'HANDOVER_PENDING',
            'Installation phải được rollback về HANDOVER_PENDING'
        );

        // G-Fallback 2: completeInstallationAndHandover: Audit log thất bại -> Fail-closed rollback toàn bộ
        const mockAuditFailClient = createMockClient(
            {
                appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS', type: 'INSTALLATION' }],
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
                installations: [
                    {
                        id: INSTALLATION_ID,
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        appointment_id: APPOINTMENT_ID,
                        status: 'HANDOVER_PENDING',
                        photos: [CANONICAL_PHOTO],
                        handover_ref: CANONICAL_HANDOVER,
                    },
                ],
                storageFiles: {
                    'installation-docs': [CANONICAL_PHOTO, CANONICAL_HANDOVER],
                },
            },
            { failTables: { audit_logs: 'insert' }, disableRpc: true }
        );

        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    { installationId: INSTALLATION_ID },
                    mockAuditFailClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi ghi audit thất bại (Fail-closed)'
        );

        assert.strictEqual(
            mockAuditFailClient._db.installations[0].status,
            'HANDOVER_PENDING',
            'Installation phải được rollback về HANDOVER_PENDING khi audit thất bại'
        );
        assert.strictEqual(
            mockAuditFailClient._db.orders[0].order_status,
            'INSTALLING',
            'Order phải giữ nguyên / rollback về INSTALLING khi audit thất bại'
        );

        // G-Fallback 3: recordQualityCheck: Cập nhật orders thất bại -> Rollback lệnh xưởng
        const mockQcOrderFailClient = createMockClient(
            {
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
                production_orders: [
                    {
                        id: 'po-test-qc-fail',
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        status: 'QC_IN_PROGRESS',
                        qc_status: 'PENDING',
                    },
                ],
                audit_logs: [],
            },
            { failTables: { orders: 'update' }, disableRpc: true }
        );

        await assert.rejects(
            async () => {
                await recordQualityCheck(
                    COMPANY_ID,
                    {
                        productionOrderId: 'po-test-qc-fail',
                        qcStatus: 'PASSED',
                        inspectorId: BOSS_USER,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockQcOrderFailClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi cập nhật đơn hàng ở bước QC thất bại'
        );

        assert.strictEqual(
            mockQcOrderFailClient._db.production_orders[0].status,
            'QC_IN_PROGRESS',
            'Lệnh xưởng phải rollback về QC_IN_PROGRESS'
        );
        assert.strictEqual(
            mockQcOrderFailClient._db.production_orders[0].qc_status,
            'PENDING',
            'Trạng thái QC phải rollback về PENDING'
        );

        // G-Fallback 4: recordQualityCheck: Ghi audit_logs thất bại -> Rollback cả orders và production_orders
        const mockQcAuditFailClient = createMockClient(
            {
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
                production_orders: [
                    {
                        id: 'po-test-qc-audit-fail',
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        status: 'QC_IN_PROGRESS',
                        qc_status: 'PENDING',
                    },
                ],
                audit_logs: [],
            },
            { failTables: { audit_logs: 'insert' }, disableRpc: true }
        );

        await assert.rejects(
            async () => {
                await recordQualityCheck(
                    COMPANY_ID,
                    {
                        productionOrderId: 'po-test-qc-audit-fail',
                        qcStatus: 'PASSED',
                        inspectorId: BOSS_USER,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockQcAuditFailClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi ghi audit QC thất bại'
        );

        assert.strictEqual(
            mockQcAuditFailClient._db.production_orders[0].status,
            'QC_IN_PROGRESS',
            'Lệnh xưởng phải rollback về QC_IN_PROGRESS'
        );
        assert.strictEqual(
            mockQcAuditFailClient._db.orders[0].order_status,
            'IN_PRODUCTION',
            'Đơn hàng phải rollback về IN_PRODUCTION'
        );

        // G-Fallback 5: updateProductionProgress: Ghi audit_logs thất bại -> Rollback production_orders
        const mockProgAuditFailClient = createMockClient(
            {
                production_orders: [
                    {
                        id: 'po-test-prog-audit-fail',
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        status: 'IN_PRODUCTION',
                        qc_status: 'PENDING',
                    },
                ],
                audit_logs: [],
            },
            { failTables: { audit_logs: 'insert' }, disableRpc: true }
        );

        await assert.rejects(
            async () => {
                await updateProductionProgress(
                    COMPANY_ID,
                    {
                        productionOrderId: 'po-test-prog-audit-fail',
                        status: 'QC_IN_PROGRESS',
                        actorId: BOSS_USER,
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockProgAuditFailClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi ghi audit tiến độ thất bại'
        );

        assert.strictEqual(
            mockProgAuditFailClient._db.production_orders[0].status,
            'IN_PRODUCTION',
            'Lệnh xưởng phải rollback về trạng thái IN_PRODUCTION ban đầu'
        );

        // G-Fallback 6: createProductionOrder: Cập nhật orders thất bại -> Rollback xóa lệnh xưởng
        const mockCreateProdFailClient = createMockClient(
            {
                contracts: [
                    {
                        id: 'contract-fail-test',
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        status: 'SIGNED',
                        signed_file_ref: 'contracts/signed.pdf',
                        is_current: true,
                    },
                ],
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'CONTRACT_SIGNED' }],
                production_orders: [],
            },
            { failTables: { orders: 'update' }, disableRpc: true }
        );

        await assert.rejects(
            async () => {
                await createProductionOrder(
                    COMPANY_ID,
                    {
                        orderId: ORDER_ID,
                        specs: { width: 1200, height: 600 },
                        materials: { material: 'inox_304' },
                        deadline: '2026-12-01',
                    },
                    mockCreateProdFailClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('rollback'));
                return true;
            },
            'Phải ném lỗi khi cập nhật đơn hàng thất bại khi tạo lệnh xưởng'
        );

        assert.strictEqual(
            mockCreateProdFailClient._db.production_orders.length,
            0,
            'Lệnh xưởng vừa tạo phải được xóa sạch (rollback delete) khi bước tiếp theo thất bại'
        );

        console.log('  ✔ Test G ĐẠT: Atomicity & Rollback an toàn (Fail-closed) cho toàn bộ quy trình: Nghiệm thu, QC, Tiến độ xưởng và Tạo lệnh sản xuất.');
    }

    // =========================================================================
    // TEST F (END-TO-END): Kiểm tra luồng chuyển đổi trạng thái toàn vẹn (E2E valid flow)
    // =========================================================================
    console.log('▶ TEST F (E2E): Kiểm tra luồng chuyển đổi trạng thái toàn vẹn (End-to-End valid flow)');
    {
        const E2E_ORDER_ID = 'e2e-order-888';
        const E2E_CUSTOMER_ID = 'e2e-cust-888';
        const E2E_APPOINTMENT_ID = 'e2e-appt-888';

        const e2eMock = createMockClient({
            contracts: [
                {
                    id: 'contract-e2e',
                    company_id: COMPANY_ID,
                    order_id: E2E_ORDER_ID,
                    status: 'SIGNED',
                    signed_file_ref: 'contracts/signed_e2e.pdf',
                    is_current: true,
                },
            ],
            orders: [
                {
                    id: E2E_ORDER_ID,
                    company_id: COMPANY_ID,
                    customer_id: E2E_CUSTOMER_ID,
                    order_status: 'DEPOSIT_CONFIRMED',
                },
            ],
            company_members: [
                {
                    id: 'cm-tech',
                    company_id: COMPANY_ID,
                    user_id: TECH_USER_1,
                    role: 'TECHNICIAN',
                    status: 'ACTIVE',
                },
            ],
            appointments: [
                {
                    id: E2E_APPOINTMENT_ID,
                    company_id: COMPANY_ID,
                    assignee_id: TECH_USER_1,
                    status: 'ASSIGNED',
                    type: 'INSTALLATION',
                },
            ],
            production_orders: [],
            installations: [],
            warranty_tickets: [],
            audit_logs: [],
        });

        // 1. Tạo lệnh sản xuất
        const prodOrder = await createProductionOrder(
            COMPANY_ID,
            {
                orderId: E2E_ORDER_ID,
                specs: { width: 1400, height: 700 },
                materials: { material: 'inox_316' },
                deadline: '2026-11-01',
            },
            e2eMock
        );
        assert.strictEqual(prodOrder.status, 'RELEASED_TO_FACTORY');
        assert.strictEqual(e2eMock._db.orders[0].order_status, 'IN_PRODUCTION');

        // 2. Xưởng tiếp nhận sản xuất
        await updateProductionProgress(
            COMPANY_ID,
            {
                productionOrderId: prodOrder.id,
                status: 'IN_PRODUCTION',
                actorId: BOSS_USER,
            },
            undefined,
            undefined,
            undefined,
            e2eMock
        );
        assert.strictEqual(e2eMock._db.production_orders[0].status, 'IN_PRODUCTION');

        // 3. Xưởng chuyển sang QC kiểm định
        await updateProductionProgress(
            COMPANY_ID,
            {
                productionOrderId: prodOrder.id,
                status: 'QC_IN_PROGRESS',
                actorId: BOSS_USER,
            },
            undefined,
            undefined,
            undefined,
            e2eMock
        );
        assert.strictEqual(e2eMock._db.production_orders[0].status, 'QC_IN_PROGRESS');

        // 4. KCS kiểm định đạt (QC_PASSED)
        await recordQualityCheck(
            COMPANY_ID,
            {
                productionOrderId: prodOrder.id,
                qcStatus: 'PASSED',
                inspectorId: BOSS_USER,
            },
            undefined,
            undefined,
            undefined,
            e2eMock
        );
        assert.strictEqual(e2eMock._db.production_orders[0].status, 'READY_FOR_DISPATCH');
        assert.strictEqual(e2eMock._db.production_orders[0].qc_status, 'PASSED');
        assert.strictEqual(e2eMock._db.orders[0].order_status, 'READY_FOR_INSTALL');

        // 5. Lên lịch lắp đặt (Appointment có type = INSTALLATION và status = ASSIGNED)
        const installDto = await scheduleInstallation(
            COMPANY_ID,
            {
                customerId: E2E_CUSTOMER_ID,
                orderId: E2E_ORDER_ID,
                appointmentId: E2E_APPOINTMENT_ID,
                crew: [TECH_USER_1],
            },
            e2eMock
        );
        assert.strictEqual(installDto.status, 'SCHEDULED');

        // Cập nhật appointment sang IN_PROGRESS cho bước thi công
        e2eMock._db.appointments[0].status = 'IN_PROGRESS';

        // 6. Thợ hiện trường cập nhật tiến độ thi công: SCHEDULED -> IN_TRANSIT -> INSTALLING -> TESTING -> HANDOVER_PENDING
        await updateInstallationStatus(
            COMPANY_ID,
            installDto.id,
            'IN_TRANSIT',
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        await updateInstallationStatus(
            COMPANY_ID,
            installDto.id,
            'INSTALLING',
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        await updateInstallationStatus(
            COMPANY_ID,
            installDto.id,
            'TESTING',
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        await updateInstallationStatus(
            COMPANY_ID,
            installDto.id,
            'HANDOVER_PENDING',
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        assert.strictEqual(e2eMock._db.installations[0].status, 'HANDOVER_PENDING');

        // 7. Thợ tải lên chứng từ nghiệm thu canonical vào Storage rồi đính kèm qua attachInstallationEvidence
        const e2ePhotoKey = `${COMPANY_ID}/installations/${installDto.id}/photo_e2e_01.jpg`;
        const e2eHandoverKey = `${COMPANY_ID}/installations/${installDto.id}/handover_e2e_01.pdf`;

        await e2eMock.storage.from('installation-docs').upload(e2ePhotoKey, Buffer.from('photo data'));
        await e2eMock.storage.from('installation-docs').upload(e2eHandoverKey, Buffer.from('handover pdf data'));

        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: installDto.id,
                fileKey: e2ePhotoKey,
                type: 'photo',
            },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: installDto.id,
                fileKey: e2eHandoverKey,
                type: 'handover',
            },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );

        // 8. Hoàn tất bàn giao & nghiệm thu
        await completeInstallationAndHandover(
            COMPANY_ID,
            { installationId: installDto.id },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        assert.strictEqual(e2eMock._db.installations[0].status, 'COMPLETED');
        assert.strictEqual(e2eMock._db.orders[0].order_status, 'COMPLETED');

        // 9. Khách hàng mở phiếu bảo hành sau lắp đặt
        const ticket = await createWarrantyTicket(
            COMPANY_ID,
            {
                customerId: E2E_CUSTOMER_ID,
                orderId: E2E_ORDER_ID,
                installationId: installDto.id,
                issue: 'Gioăng cao su bị hở nhẹ sau trận bão',
            },
            e2eMock
        );
        assert.strictEqual(ticket.status, 'OPEN');

        // 10. Phân công Kỹ thuật viên bảo hành
        await assignWarrantyTicket(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                technicianId: TECH_USER_1,
            },
            e2eMock
        );
        assert.strictEqual(e2eMock._db.warranty_tickets[0].status, 'ASSIGNED');

        // 11. Thợ cập nhật tiến độ xử lý và giải quyết xong
        await updateWarrantyStatus(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                status: 'IN_PROGRESS',
            },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        await updateWarrantyStatus(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                status: 'RESOLVED',
                notes: 'Đã bơm keo và cố định nẹp chắn nước',
            },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        assert.strictEqual(e2eMock._db.warranty_tickets[0].status, 'RESOLVED');

        // 12. Phát sinh vấn đề mở lại phiếu qua reopenWarrantyTicket
        await reopenWarrantyTicket(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                reason: 'Khách yêu cầu kiểm tra lại độ đàn hồi sau khi bơm keo',
            },
            e2eMock
        );
        assert.strictEqual(e2eMock._db.warranty_tickets[0].status, 'REOPENED');

        // 13. Phân công lại và đóng phiếu hoàn tất
        await assignWarrantyTicket(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                technicianId: TECH_USER_1,
            },
            e2eMock
        );
        assert.strictEqual(e2eMock._db.warranty_tickets[0].status, 'ASSIGNED');

        await updateWarrantyStatus(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                status: 'IN_PROGRESS',
            },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        assert.strictEqual(e2eMock._db.warranty_tickets[0].status, 'IN_PROGRESS');

        await updateWarrantyStatus(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                status: 'RESOLVED',
                notes: 'Đã kiểm tra lại độ đàn hồi và gia cố hoàn tất',
            },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        assert.strictEqual(e2eMock._db.warranty_tickets[0].status, 'RESOLVED');

        await updateWarrantyStatus(
            COMPANY_ID,
            {
                ticketId: ticket.id,
                status: 'CLOSED',
                notes: 'Khách hàng hoàn toàn hài lòng sau khi test nước thực tế',
            },
            e2eMock
        );
        assert.strictEqual(e2eMock._db.warranty_tickets[0].status, 'CLOSED');

        console.log('  ✔ Test F ĐẠT: Luồng End-to-End toàn vẹn từ Hợp đồng -> Sản xuất -> QC -> Lắp đặt -> Nghiệm thu -> Bảo hành khép kín.');
    }

    console.log('\n================================================================');
    console.log('TẤT CẢ CÁC BÀI KIỂM THỬ P0 & P1 ĐÃ VƯỢT QUA VỚI ĐỘ CHÍNH XÁC TUYỆT ĐỐI!');
    console.log('================================================================');
}

runTests().catch((err) => {
    console.error('Kiểm thử thất bại:', err);
    process.exit(1);
});