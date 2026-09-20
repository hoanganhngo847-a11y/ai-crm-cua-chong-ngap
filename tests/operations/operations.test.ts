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
 * from(), select(), insert(), update(), eq(), single(), maybeSingle()
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
    },
    options?: {
        failTables?: { [table: string]: 'insert' | 'update' | 'delete' | 'all' };
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
                if (!options?.failTables?.[table] || options.failTables[table] !== 'insert' && options.failTables[table] !== 'all') {
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

        // If insert, update, or delete returns promise directly (not calling .single() or .maybeSingle())
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

    return {
        from: (table: string) => queryBuilder(table),
        _db: db,
        _updateCalls: updateCalls,
        _insertCalls: insertCalls,
    };
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
    } = await import('../../features/installation/installation-service');
    const {
        assignWarrantyTicket,
        createWarrantyTicket,
        reopenWarrantyTicket,
        updateWarrantyStatus,
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

    // =========================================================================
    // TEST 1: Chặn TECHNICIAN sửa/hoàn tất installation khi không phải assignee (P0)
    // =========================================================================
    console.log('▶ TEST 1: Chặn TECHNICIAN sửa/hoàn tất installation khi không phải assignee');
    {
        // 1a: TECHNICIAN không được phân công cố gắng cập nhật trạng thái lắp đặt -> 403 AuthError
        const mockUnauthorizedTech = createMockClient({
            appointments: [
                {
                    id: APPOINTMENT_ID,
                    company_id: COMPANY_ID,
                    assignee_id: TECH_USER_1, // Phân công cho TECH_USER_1
                    status: 'ASSIGNED',
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

        // 1b: TECHNICIAN không được phân công cố gắng nghiệm thu hoàn tất -> 403 AuthError
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

        // 1c: TECHNICIAN đúng assignee nhưng lịch hẹn đã CANCELLED -> 403 AuthError
        const mockCancelledAppt = createMockClient({
            appointments: [
                {
                    id: APPOINTMENT_ID,
                    company_id: COMPANY_ID,
                    assignee_id: TECH_USER_1,
                    status: 'CANCELLED', // Lịch hẹn đã hủy!
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

        // 1d: TECHNICIAN đúng assignee và lịch hẹn IN_PROGRESS -> Cập nhật thành công
        const mockValidTech = createMockClient({
            appointments: [
                {
                    id: APPOINTMENT_ID,
                    company_id: COMPANY_ID,
                    assignee_id: TECH_USER_1,
                    status: 'IN_PROGRESS',
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

        // 2a: Chặn trực tiếp cập nhật lên 'COMPLETED' qua updateInstallationStatus
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

        // 2b: Chặn chuyển đổi trạng thái vi phạm State Machine (SCHEDULED -> HANDOVER_PENDING)
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

        // 2c: Chuyển đổi hợp lệ SCHEDULED -> IN_TRANSIT -> INSTALLING -> TESTING -> HANDOVER_PENDING
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
    // TEST A (P0 MỚI): Khóa State Machine nghiệm thu lắp đặt (installation)
    // Chỉ cho phép completeInstallationAndHandover khi installRecord.status === 'HANDOVER_PENDING'
    // =========================================================================
    console.log('▶ TEST A (P0): Khóa State Machine nghiệm thu lắp đặt (chỉ cho phép ở HANDOVER_PENDING)');
    {
        // Aa: Chặn khi installation đang ở INSTALLING
        const mockInstalling = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS' }],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'INSTALLING', // Chưa đến HANDOVER_PENDING
                    photos: ['installation-docs/photo_01.jpg'],
                    handover_ref: 'installation-docs/handover.pdf',
                },
            ],
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

        // Ab: Chặn khi appointment liên kết không phải IN_PROGRESS hoặc ACCEPTED
        const mockInvalidAppt = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'SCHEDULED' }], // Sai trạng thái
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'HANDOVER_PENDING',
                    photos: ['installation-docs/photo_01.jpg'],
                    handover_ref: 'installation-docs/handover.pdf',
                },
            ],
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

        // Ac: Chặn khi đơn hàng liên kết không ở READY_FOR_INSTALL hoặc INSTALLING
        const mockInvalidOrder = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS' }],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }], // Sai trạng thái
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    appointment_id: APPOINTMENT_ID,
                    status: 'HANDOVER_PENDING',
                    photos: ['installation-docs/photo_01.jpg'],
                    handover_ref: 'installation-docs/handover.pdf',
                },
            ],
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
    // TEST B (P0 MỚI): Khắc phục Storage Evidence do Browser tự khai & Kiểm tra Canonical Evidence
    // =========================================================================
    console.log('▶ TEST B (P0): Khắc phục Storage Evidence do Browser tự khai (attachInstallationEvidence & canonical DB check)');
    {
        const mockClient = createMockClient({
            appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS', assignee_id: TECH_USER_1 }],
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

        // Ba: Chặn attachInstallationEvidence khi fileKey là link rác hoặc domain không tin cậy
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
            'Phải chặn đính kèm tài liệu với fileKey không hợp lệ'
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
                assert.ok(
                    err.message.includes('MISSING_EVIDENCE'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn nghiệm thu nếu DB chưa có đầy đủ bằng chứng'
        );

        // Bc: Đính kèm ảnh hiện trường hợp lệ qua attachInstallationEvidence
        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: INSTALLATION_ID,
                fileKey: 'installation-docs/field_proof_01.jpg',
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

        // Bd: Đính kèm biên bản bàn giao hợp lệ qua attachInstallationEvidence
        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: INSTALLATION_ID,
                fileKey: 'installation-docs/handover_signed_order101.pdf',
                type: 'handover',
            },
            mockClient,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );

        // Be: Bây giờ đã đủ evidence từ DB -> Nghiệm thu thành công!
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
    // TEST C (P0 MỚI): Chặn updateProductionProgress nhảy cóc sang READY_FOR_DISPATCH hoặc QC_PASSED
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

        // Ca: Thử set 'QC_PASSED' qua generic updateProductionProgress -> Chặn
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

        // Cb: Thử set 'READY_FOR_DISPATCH' qua generic updateProductionProgress -> Chặn
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

        // Cc: Thử set 'QC_FAILED' qua generic updateProductionProgress -> Chặn
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

        // Cd: Chuyển đổi hợp lệ: IN_PRODUCTION -> QC_IN_PROGRESS -> Thành công
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
    // TEST D (P0 MỚI): Chặn recordQualityCheck khi lệnh xưởng chưa ở QC_IN_PROGRESS
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
                    status: 'IN_PRODUCTION', // Chưa ở QC_IN_PROGRESS!
                    qc_status: 'PENDING',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            audit_logs: [],
        });

        // Da: Thử duyệt QC khi lệnh chưa ở QC_IN_PROGRESS -> Bị chặn ngay
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

        // Db: Chuyển sang QC_IN_PROGRESS và duyệt QC PASSED -> Thành công, chuyển sang READY_FOR_DISPATCH và đồng bộ orders
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
    // TEST E (P1 MỚI): Chặn gán kỹ thuật viên vào ticket bảo hành đã RESOLVED/CLOSED & State Machine Bảo hành
    // =========================================================================
    console.log('▶ TEST E (P1): Chặn gán kỹ thuật viên vào ticket bảo hành đã RESOLVED/CLOSED & State Machine');
    {
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
                    status: 'RESOLVED', // Ticket đã hoàn tất!
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
                    err.message.includes('INVALID_STATE_TRANSITION') &&
                    err.message.includes('đã ở trạng thái'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn update trên ticket đã RESOLVED/CLOSED'
        );

        // Ee: Chặn tạo phiếu bảo hành khi đơn hàng chưa hoàn tất nghiệm thu COMPLETED
        const mockOrderNotCompleted = createMockClient({
            orders: [
                {
                    id: ORDER_ID,
                    company_id: COMPANY_ID,
                    customer_id: CUSTOMER_ID,
                    order_status: 'INSTALLING', // Chưa COMPLETED!
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
                    { userId: TECH_USER_2, role: 'TECHNICIAN' } // TECH_USER_2 không phải assignee!
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
                    role: 'SALE', // Không phải TECHNICIAN!
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
    // TEST G (P0 MỚI): Bảo đảm Tính nguyên tử (Atomicity) & Fail-closed Rollback
    // =========================================================================
    console.log('▶ TEST G (P0): Bảo đảm tính nguyên tử (Atomicity) & Fail-closed Rollback khi lỗi');
    {
        // Ga: completeInstallationAndHandover: Order update thất bại -> Rollback installations về HANDOVER_PENDING
        const mockOrderFailClient = createMockClient(
            {
                appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS' }],
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
                installations: [
                    {
                        id: INSTALLATION_ID,
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        appointment_id: APPOINTMENT_ID,
                        status: 'HANDOVER_PENDING',
                        photos: ['installation-docs/photo.jpg'],
                        handover_ref: 'installation-docs/handover.pdf',
                    },
                ],
            },
            { failTables: { orders: 'update' } } // Giả lập lỗi cập nhật orders
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

        // Gb: completeInstallationAndHandover: Audit log thất bại -> Fail-closed rollback toàn bộ
        const mockAuditFailClient = createMockClient(
            {
                appointments: [{ id: APPOINTMENT_ID, company_id: COMPANY_ID, status: 'IN_PROGRESS' }],
                orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
                installations: [
                    {
                        id: INSTALLATION_ID,
                        company_id: COMPANY_ID,
                        order_id: ORDER_ID,
                        appointment_id: APPOINTMENT_ID,
                        status: 'HANDOVER_PENDING',
                        photos: ['installation-docs/photo.jpg'],
                        handover_ref: 'installation-docs/handover.pdf',
                    },
                ],
            },
            { failTables: { audit_logs: 'insert' } } // Giả lập lỗi ghi audit_logs
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

        // Gc: recordQualityCheck: Cập nhật orders sang READY_FOR_INSTALL thất bại -> Rollback lệnh xưởng
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
            { failTables: { orders: 'update' } }
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

        // Gd: recordQualityCheck: Ghi audit_logs thất bại -> Rollback cả orders và production_orders (Fail-closed)
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
            { failTables: { audit_logs: 'insert' } }
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

        // Ge: updateProductionProgress: Ghi audit_logs thất bại -> Rollback production_orders
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
            { failTables: { audit_logs: 'insert' } }
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

        // Gf: createProductionOrder: Cập nhật orders thất bại -> Rollback lệnh xưởng (xóa bản ghi)
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
            { failTables: { orders: 'update' } }
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
                    status: 'IN_PROGRESS',
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

        // 5. Lên lịch lắp đặt
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

        // 7. Thợ tải lên chứng từ nghiệm thu hợp lệ qua attachInstallationEvidence
        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: installDto.id,
                fileKey: 'installation-docs/e2e_photo.jpg',
                type: 'photo',
            },
            e2eMock,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        await attachInstallationEvidence(
            COMPANY_ID,
            {
                installationId: installDto.id,
                fileKey: 'installation-docs/e2e_handover.pdf',
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