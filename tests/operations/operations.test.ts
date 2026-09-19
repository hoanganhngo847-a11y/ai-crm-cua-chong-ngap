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

/**
 * In-Memory Mock Supabase Client Builder
 * Hỗ trợ mô phỏng chính xác các thao tác DB của Supabase Query Builder:
 * from(), select(), insert(), update(), eq(), single(), maybeSingle()
 */
function createMockClient(initialData: {
    contracts?: any[];
    orders?: any[];
    production_orders?: any[];
    installations?: any[];
    warranty_tickets?: any[];
    audit_logs?: any[];
    appointments?: any[];
    company_members?: any[];
}) {
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

        const builder: any = {
            eq(field: string, value: any) {
                filters[field] = value;
                return builder;
            },
            select(_fields?: string) {
                return builder;
            },
            insert(payload: any) {
                insertPayload = payload;
                const row = {
                    id: payload.id || `mock-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    ...payload,
                };
                if (!db[table]) db[table] = [];
                db[table].push(row);
                insertCalls.push({ table, payload: row });
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
                return { data: rows.length > 0 ? rows[0] : null, error: null };
            },
            async single() {
                if (updatePayload) {
                    const rows = (db[table] || []).filter((item) => {
                        return Object.entries(filters).every(([k, v]) => item[k] === v);
                    });
                    if (rows.length === 0) {
                        return { data: null, error: { message: `Record not found for update in ${table}` } };
                    }
                    rows.forEach((row) => Object.assign(row, updatePayload));
                    updateCalls.push({ table, payload: updatePayload, filters: { ...filters } });
                    return { data: rows[0], error: null };
                }

                if (insertPayload) {
                    const lastInserted = db[table][db[table].length - 1];
                    return { data: lastInserted, error: null };
                }

                const rows = (db[table] || []).filter((item) => {
                    return Object.entries(filters).every(([k, v]) => item[k] === v);
                });
                if (rows.length === 0) {
                    return { data: null, error: { message: `Record not found in ${table}` } };
                }
                return { data: rows[0], error: null };
            },
        };

        // If insert or update returns promise directly (not calling .single() or .maybeSingle())
        builder.then = function (resolve: any, _reject: any) {
            if (updatePayload) {
                const rows = (db[table] || []).filter((item) => {
                    return Object.entries(filters).every(([k, v]) => item[k] === v);
                });
                rows.forEach((row) => Object.assign(row, updatePayload));
                updateCalls.push({ table, payload: updatePayload, filters: { ...filters } });
                resolve({ data: rows, error: null });
            } else if (insertPayload) {
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
        completeInstallationAndHandover,
        dispatchOrderCompletionEvent,
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
                // TECH_USER_2 gọi cập nhật
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
                assert.strictEqual(
                    err.message,
                    'Bạn không được phân công thực hiện công việc này'
                );
                return true;
            },
            'Phải chặn Kỹ thuật viên không được phân công cập nhật tiến độ'
        );

        // 1b: TECHNICIAN không được phân công cố gắng nghiệm thu hoàn tất -> 403 AuthError
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    {
                        installationId: INSTALLATION_ID,
                        photos: ['installation-docs/site_photo.jpg'],
                        handoverRef: 'installation-docs/handover_signed.pdf',
                    },
                    mockUnauthorizedTech,
                    { userId: TECH_USER_2, role: 'TECHNICIAN' }
                );
            },
            (err: any) => {
                assert.ok(err instanceof AuthError, 'Phải ném lỗi kiểu AuthError');
                assert.strictEqual(err.status, 403);
                assert.strictEqual(
                    err.message,
                    'Bạn không được phân công thực hiện công việc này'
                );
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
                assert.strictEqual(
                    err.message,
                    'Bạn không được phân công thực hiện công việc này'
                );
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
    // TEST 2: Chặn gọi generic status update lên 'COMPLETED' (P0 & P1)
    // =========================================================================
    console.log('▶ TEST 2: Chặn gọi generic status update lên "COMPLETED" & State Machine');
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

        // 2c: Chuyển đổi hợp lệ SCHEDULED -> IN_TRANSIT -> INSTALLING
        await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'IN_TRANSIT', mockClient);
        assert.strictEqual(mockClient._db.installations[0].status, 'IN_TRANSIT');

        await updateInstallationStatus(COMPANY_ID, INSTALLATION_ID, 'INSTALLING', mockClient);
        assert.strictEqual(mockClient._db.installations[0].status, 'INSTALLING');

        console.log('  ✔ Test 2 ĐẠT: Đã chặn triệt để cửa sau COMPLETED và kiểm soát State Machine lắp đặt.');
    }

    // =========================================================================
    // TEST 3: Chặn photos/handoverRef giả mạo (fake storage ref) (P0)
    // =========================================================================
    console.log('▶ TEST 3: Chặn photos/handoverRef giả mạo (fake storage ref)');
    {
        const mockClient = createMockClient({
            installations: [
                {
                    id: INSTALLATION_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'INSTALLING',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
        });

        // 3a: Chuỗi rác trong photos
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    {
                        installationId: INSTALLATION_ID,
                        photos: ['random-fake-garbage-string-xyz'],
                        handoverRef: 'installation-docs/signed_handover.pdf',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('Ảnh nghiệm thu không hợp lệ') &&
                    err.message.includes('installation-docs/'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn chuỗi rác trong photos'
        );

        // 3b: URL ngoài giả mạo (untrusted domain)
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    {
                        installationId: INSTALLATION_ID,
                        photos: ['https://attacker-evil-domain.com/fake_proof.jpg'],
                        handoverRef: 'installation-docs/signed_handover.pdf',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('Ảnh nghiệm thu không hợp lệ'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn URL ngoài không thuộc hệ thống'
        );

        // 3c: handoverRef là file nội bộ không có prefix hợp lệ
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    {
                        installationId: INSTALLATION_ID,
                        photos: ['installation-docs/photo_01.jpg'],
                        handoverRef: 'local_handover_without_prefix.pdf',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('Biên bản bàn giao không hợp lệ') &&
                    err.message.includes('installation-docs/'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn biên bản bàn giao thiếu tiền tố storage hợp lệ'
        );

        // 3d: Storage Reference hợp lệ ('installation-docs/...') -> Hoàn tất thành công
        await completeInstallationAndHandover(
            COMPANY_ID,
            {
                installationId: INSTALLATION_ID,
                photos: ['installation-docs/photo_01.jpg', 'https://storage.local/photo_02.jpg'],
                handoverRef: 'installation-docs/handover_signed_order101.pdf',
            },
            mockClient
        );
        assert.strictEqual(mockClient._db.installations[0].status, 'COMPLETED');
        assert.strictEqual(mockClient._db.orders[0].order_status, 'COMPLETED');

        console.log('  ✔ Test 3 ĐẠT: Đã chặn photos/handoverRef giả mạo và xác thực storage reference nghiêm ngặt.');
    }

    // =========================================================================
    // TEST 4: Chặn tạo production order hoặc schedule installation trên đơn hàng đã CANCELLED (P0)
    // =========================================================================
    console.log('▶ TEST 4: Chặn tạo production order hoặc schedule installation trên đơn đã CANCELLED / sai trạng thái');
    {
        // 4a: createProductionOrder trên đơn CANCELLED -> Chặn tuyệt đối
        const mockCancelledOrder = createMockClient({
            contracts: [
                {
                    id: 'contract-cancel',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'SIGNED',
                    signed_file_ref: 'contracts/signed.pdf',
                    is_current: true,
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'CANCELLED' }],
            production_orders: [],
        });

        await assert.rejects(
            async () => {
                await createProductionOrder(
                    COMPANY_ID,
                    {
                        orderId: ORDER_ID,
                        specs: { width: 1000 },
                        materials: { frame: 'inox' },
                        deadline: '2026-10-10',
                    },
                    mockCancelledOrder
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('đơn hàng đã bị hủy (CANCELLED)'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải từ chối tạo lệnh sản xuất trên đơn hàng CANCELLED'
        );

        // 4b: createProductionOrder trên đơn đã IN_PRODUCTION -> Chặn
        const mockInProdOrder = createMockClient({
            contracts: [
                {
                    id: 'contract-inprod',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'SIGNED',
                    signed_file_ref: 'contracts/signed.pdf',
                    is_current: true,
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            production_orders: [],
        });

        await assert.rejects(
            async () => {
                await createProductionOrder(
                    COMPANY_ID,
                    {
                        orderId: ORDER_ID,
                        specs: { width: 1000 },
                        materials: { frame: 'inox' },
                        deadline: '2026-10-10',
                    },
                    mockInProdOrder
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('IN_PRODUCTION'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn tạo lệnh sản xuất khi đơn hàng đã IN_PRODUCTION'
        );

        // 4c: createProductionOrder trên đơn hàng DRAFT (chưa đủ điều kiện) -> Chặn
        const mockDraftOrder = createMockClient({
            contracts: [
                {
                    id: 'contract-draft',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'SIGNED',
                    signed_file_ref: 'contracts/signed.pdf',
                    is_current: true,
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'DRAFT' }],
            production_orders: [],
        });

        await assert.rejects(
            async () => {
                await createProductionOrder(
                    COMPANY_ID,
                    {
                        orderId: ORDER_ID,
                        specs: { width: 1000 },
                        materials: { frame: 'inox' },
                        deadline: '2026-10-10',
                    },
                    mockDraftOrder
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('không hợp lệ'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn tạo lệnh sản xuất khi đơn hàng chưa ở CONTRACT_SIGNED hoặc DEPOSIT_CONFIRMED'
        );

        // 4d: scheduleInstallation trên đơn hàng CANCELLED -> Chặn tuyệt đối
        const mockScheduleCancelled = createMockClient({
            production_orders: [
                {
                    id: 'po-1',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'READY_FOR_DISPATCH',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'CANCELLED' }],
            installations: [],
        });

        await assert.rejects(
            async () => {
                await scheduleInstallation(
                    COMPANY_ID,
                    {
                        customerId: CUSTOMER_ID,
                        orderId: ORDER_ID,
                        appointmentId: APPOINTMENT_ID,
                        crew: [TECH_USER_1],
                    },
                    mockScheduleCancelled
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('CANCELLED'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn lên lịch lắp đặt khi đơn hàng đã CANCELLED'
        );

        // 4e: scheduleInstallation khi đơn hàng chưa READY_FOR_INSTALL -> Chặn
        const mockScheduleNotReady = createMockClient({
            production_orders: [
                {
                    id: 'po-1',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'READY_FOR_DISPATCH',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            installations: [],
        });

        await assert.rejects(
            async () => {
                await scheduleInstallation(
                    COMPANY_ID,
                    {
                        customerId: CUSTOMER_ID,
                        orderId: ORDER_ID,
                        appointmentId: APPOINTMENT_ID,
                        crew: [TECH_USER_1],
                    },
                    mockScheduleNotReady
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('READY_FOR_INSTALL'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn khi order_status !== READY_FOR_INSTALL'
        );

        // 4f: createProductionOrder trên đơn hàng hợp lệ DEPOSIT_CONFIRMED -> Thành công
        const mockValidProdOrder = createMockClient({
            contracts: [
                {
                    id: 'contract-valid',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'SIGNED',
                    signed_file_ref: 'contracts/signed.pdf',
                    is_current: true,
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'DEPOSIT_CONFIRMED' }],
            production_orders: [],
        });

        const createdProd = await createProductionOrder(
            COMPANY_ID,
            {
                orderId: ORDER_ID,
                specs: { width: 1200, height: 600 },
                materials: { frame: 'inox_304' },
                deadline: '2026-10-01',
            },
            mockValidProdOrder
        );
        assert.strictEqual(createdProd.status, 'RELEASED_TO_FACTORY');
        assert.strictEqual(mockValidProdOrder._db.orders[0].order_status, 'IN_PRODUCTION');

        // 4g: scheduleInstallation trên đơn hàng READY_FOR_INSTALL và lệnh xưởng READY_FOR_DISPATCH -> Thành công
        const mockValidSchedule = createMockClient({
            production_orders: [
                {
                    id: 'po-ready',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'READY_FOR_DISPATCH',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'READY_FOR_INSTALL' }],
            installations: [],
        });

        const scheduled = await scheduleInstallation(
            COMPANY_ID,
            {
                customerId: CUSTOMER_ID,
                orderId: ORDER_ID,
                appointmentId: APPOINTMENT_ID,
                crew: [TECH_USER_1],
            },
            mockValidSchedule
        );
        assert.strictEqual(scheduled.status, 'SCHEDULED');

        console.log('  ✔ Test 4 ĐẠT: Ràng buộc trạng thái đơn hàng (chặn CANCELLED/IN_PRODUCTION, yêu cầu CONTRACT_SIGNED/DEPOSIT_CONFIRMED/READY_FOR_INSTALL).');
    }

    // =========================================================================
    // TEST 5: Chặn TECHNICIAN sửa warranty ticket của người khác (P0)
    // =========================================================================
    console.log('▶ TEST 5: Chặn TECHNICIAN sửa warranty ticket của người khác');
    {
        const TICKET_ID = 'wt-501';

        const mockClient = createMockClient({
            warranty_tickets: [
                {
                    id: TICKET_ID,
                    company_id: COMPANY_ID,
                    customer_id: CUSTOMER_ID,
                    order_id: ORDER_ID,
                    status: 'ASSIGNED',
                    assigned_to: TECH_USER_1, // Phân công cho TECH_USER_1
                },
            ],
        });

        // 5a: TECH_USER_2 cố gắng sửa ticket của TECH_USER_1 -> 403 AuthError
        await assert.rejects(
            async () => {
                await updateWarrantyStatus(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        status: 'IN_PROGRESS',
                        notes: 'Kỹ thuật viên 2 tự ý can thiệp',
                    },
                    mockClient,
                    { userId: TECH_USER_2, role: 'TECHNICIAN' }
                );
            },
            (err: any) => {
                assert.ok(err instanceof AuthError, 'Phải là AuthError');
                assert.strictEqual(err.status, 403);
                assert.strictEqual(
                    err.message,
                    'Bạn không được phân công thực hiện phiếu bảo hành này'
                );
                return true;
            },
            'Phải chặn Kỹ thuật viên sửa phiếu bảo hành của người khác'
        );

        // 5b: TECH_USER_1 (người được gán) cập nhật tiến độ -> Thành công
        await updateWarrantyStatus(
            COMPANY_ID,
            {
                ticketId: TICKET_ID,
                status: 'IN_PROGRESS',
                notes: 'Đang tiến hành thay ron chống thấm',
            },
            mockClient,
            { userId: TECH_USER_1, role: 'TECHNICIAN' }
        );
        assert.strictEqual(mockClient._db.warranty_tickets[0].status, 'IN_PROGRESS');

        // 5c: BOSS_ADMIN can thiệp cập nhật -> Luôn được phép
        await updateWarrantyStatus(
            COMPANY_ID,
            {
                ticketId: TICKET_ID,
                status: 'RESOLVED',
                notes: 'Sếp duyệt hoàn tất nghiệm thu bảo hành',
            },
            mockClient,
            { userId: BOSS_USER, role: 'BOSS_ADMIN' }
        );
        assert.strictEqual(mockClient._db.warranty_tickets[0].status, 'RESOLVED');

        console.log('  ✔ Test 5 ĐẠT: Giới hạn quyền TECHNICIAN chỉ được sửa ticket được phân công cho mình.');
    }

    // =========================================================================
    // TEST 6: Chặn gán warranty ticket cho user không phải active technician (P1)
    // =========================================================================
    console.log('▶ TEST 6: Chặn gán warranty ticket cho user không phải active technician');
    {
        const TICKET_ID = 'wt-601';

        const mockClient = createMockClient({
            company_members: [
                {
                    id: 'cm-1',
                    company_id: COMPANY_ID,
                    user_id: 'tech-active',
                    role: 'TECHNICIAN',
                    status: 'ACTIVE',
                },
                {
                    id: 'cm-2',
                    company_id: COMPANY_ID,
                    user_id: 'tech-inactive',
                    role: 'TECHNICIAN',
                    status: 'INACTIVE', // Đã nghỉ việc/tạm khóa
                },
                {
                    id: 'cm-3',
                    company_id: COMPANY_ID,
                    user_id: 'sale-user',
                    role: 'SALE', // Không phải TECHNICIAN
                    status: 'ACTIVE',
                },
            ],
            warranty_tickets: [
                {
                    id: TICKET_ID,
                    company_id: COMPANY_ID,
                    status: 'OPEN',
                    assigned_to: null,
                },
            ],
        });

        // 6a: Gán cho user không tồn tại trong company_members
        await assert.rejects(
            async () => {
                await assignWarrantyTicket(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        technicianId: 'ghost-user',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('Kỹ thuật viên không tồn tại trong công ty'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải từ chối gán cho user không tồn tại'
        );

        // 6b: Gán cho user có role SALE (không phải TECHNICIAN)
        await assert.rejects(
            async () => {
                await assignWarrantyTicket(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        technicianId: 'sale-user',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('Chỉ được phân công cho nhân viên có vai trò TECHNICIAN đang hoạt động'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải từ chối gán cho nhân viên không có vai trò TECHNICIAN'
        );

        // 6c: Gán cho technician có status INACTIVE
        await assert.rejects(
            async () => {
                await assignWarrantyTicket(
                    COMPANY_ID,
                    {
                        ticketId: TICKET_ID,
                        technicianId: 'tech-inactive',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('Chỉ được phân công cho nhân viên có vai trò TECHNICIAN đang hoạt động'),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải từ chối gán cho Kỹ thuật viên không ở trạng thái ACTIVE'
        );

        // 6d: Gán cho technician hợp lệ (ACTIVE + TECHNICIAN) -> Thành công
        await assignWarrantyTicket(
            COMPANY_ID,
            {
                ticketId: TICKET_ID,
                technicianId: 'tech-active',
            },
            mockClient
        );

        const assignedTicket = mockClient._db.warranty_tickets[0];
        assert.strictEqual(assignedTicket.status, 'ASSIGNED');
        assert.strictEqual(assignedTicket.assigned_to, 'tech-active');

        console.log('  ✔ Test 6 ĐẠT: Xác minh gán quyền Kỹ thuật viên qua company_members (ACTIVE + TECHNICIAN).');
    }

    // =========================================================================
    // TEST 7: Kiểm thử khôi phục kẹt trạng thái (Resilient Idempotency) & State Machine phụ
    // =========================================================================
    console.log('▶ TEST 7: Kiểm thử khôi phục kẹt trạng thái (Resilient Idempotency) & State Machine');
    {
        // 7a: Khôi phục kẹt trạng thái: Cài đặt COMPLETED nhưng đơn hàng kẹt ở INSTALLING
        const mockStuck = createMockClient({
            installations: [
                {
                    id: 'inst-stuck-001',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'COMPLETED',
                    photos: ['installation-docs/installed.jpg'],
                    handover_ref: 'installation-docs/handover_001.pdf',
                },
            ],
            orders: [
                {
                    id: ORDER_ID,
                    company_id: COMPANY_ID,
                    order_status: 'INSTALLING', // Bị kẹt
                },
            ],
        });

        // Chạy bù để giải cứu đơn hàng
        await completeInstallationAndHandover(
            COMPANY_ID,
            {
                installationId: 'inst-stuck-001',
                photos: ['installation-docs/installed.jpg'],
                handoverRef: 'installation-docs/handover_001.pdf',
            },
            mockStuck
        );

        assert.strictEqual(
            mockStuck._db.orders[0].order_status,
            'COMPLETED',
            'Đơn hàng kẹt trạng thái phải được chạy bù cập nhật thành COMPLETED'
        );

        // Gọi lần 2: Khi cả 2 đã COMPLETED -> Thoát sớm idempotent, không cập nhật DB
        const updateCallsBefore = mockStuck._updateCalls.length;
        await completeInstallationAndHandover(
            COMPANY_ID,
            {
                installationId: 'inst-stuck-001',
                photos: ['installation-docs/installed.jpg'],
                handoverRef: 'installation-docs/handover_001.pdf',
            },
            mockStuck
        );
        assert.strictEqual(
            mockStuck._updateCalls.length,
            updateCallsBefore,
            'Khi cả 2 đã COMPLETED, hệ thống phải idempotent thoát sớm mà không cập nhật thừa'
        );

        // 7b: Kiểm tra Audit Log Sanitization trong production: Chỉ lưu { from_status, to_status, qc_status, actor_id }, không lưu raw note
        const PROD_ID = 'po-audit-test';
        const mockProdAudit = createMockClient({
            production_orders: [
                {
                    id: PROD_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'RELEASED_TO_FACTORY',
                    qc_status: 'PENDING',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            audit_logs: [],
        });

        await updateProductionProgress(
            COMPANY_ID,
            {
                productionOrderId: PROD_ID,
                status: 'IN_PRODUCTION',
                note: 'Ghi chú nhạy cảm: Chứa số điện thoại bí mật 0912345678',
                actorId: BOSS_USER,
            },
            undefined,
            undefined,
            undefined,
            mockProdAudit
        );

        const audit1 = mockProdAudit._db.audit_logs[0];
        assert.ok(audit1, 'Bắt buộc phải có audit_log');
        assert.strictEqual(audit1.metadata.from_status, 'RELEASED_TO_FACTORY');
        assert.strictEqual(audit1.metadata.to_status, 'IN_PRODUCTION');
        assert.strictEqual(audit1.metadata.qc_status, 'PENDING');
        assert.strictEqual(audit1.metadata.actor_id, BOSS_USER);
        assert.strictEqual(audit1.metadata.note, undefined, 'TUYỆT ĐỐI KHÔNG lưu raw note trong metadata');
        assert.strictEqual(audit1.metadata.notes, undefined, 'TUYỆT ĐỐI KHÔNG lưu raw notes trong metadata');

        // Tiến hành QC và kiểm tra sanitized metadata
        mockProdAudit._db.production_orders[0].status = 'QC_IN_PROGRESS';
        await recordQualityCheck(
            COMPANY_ID,
            {
                productionOrderId: PROD_ID,
                qcStatus: 'PASSED',
                inspectorId: BOSS_USER,
                notes: 'Ghi chú QC bí mật của xưởng',
            },
            undefined,
            undefined,
            undefined,
            mockProdAudit
        );

        const audit2 = mockProdAudit._db.audit_logs[1];
        assert.strictEqual(audit2.metadata.from_status, 'QC_IN_PROGRESS');
        assert.strictEqual(audit2.metadata.to_status, 'READY_FOR_DISPATCH');
        assert.strictEqual(audit2.metadata.qc_status, 'PASSED');
        assert.strictEqual(audit2.metadata.actor_id, BOSS_USER);
        assert.strictEqual(audit2.metadata.notes, undefined, 'TUYỆT ĐỐI KHÔNG lưu raw notes');

        // 7c: reopenWarrantyTicket State Machine: Chỉ cho phép khi ticket ở RESOLVED hoặc CLOSED
        const mockTicketStateMachine = createMockClient({
            warranty_tickets: [
                {
                    id: 'wt-open',
                    company_id: COMPANY_ID,
                    status: 'IN_PROGRESS', // Đang xử lý, chưa đóng
                    notes: 'Đang sửa chữa',
                },
            ],
        });

        await assert.rejects(
            async () => {
                await reopenWarrantyTicket(
                    COMPANY_ID,
                    {
                        ticketId: 'wt-open',
                        reason: 'Khách hàng báo vẫn chưa ổn',
                    },
                    mockTicketStateMachine
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes("Chỉ cho phép mở lại khi phiếu đã ở trạng thái 'RESOLVED' hoặc 'CLOSED'"),
                    `Lỗi: ${err.message}`
                );
                return true;
            },
            'Phải chặn mở lại ticket khi chưa ở trạng thái RESOLVED hoặc CLOSED'
        );

        // Mở lại thành công khi ở trạng thái RESOLVED
        mockTicketStateMachine._db.warranty_tickets[0].status = 'RESOLVED';
        await reopenWarrantyTicket(
            COMPANY_ID,
            {
                ticketId: 'wt-open',
                reason: 'Sau trận mưa lớn lại phát sinh rò rỉ nhẹ',
            },
            mockTicketStateMachine
        );
        assert.strictEqual(mockTicketStateMachine._db.warranty_tickets[0].status, 'REOPENED');
        assert.ok(mockTicketStateMachine._db.warranty_tickets[0].notes.includes('REOPEN: Sau trận mưa lớn'));

        console.log('  ✔ Test 7 ĐẠT: Resilient Idempotency, Audit Sanitization và State Machine hoạt động hoàn hảo.');
    }

    console.log('\n================================================================');
    console.log('TẤT CẢ 7/7 TEST BẢO MẬT & NGHIỆP VỤ ĐÃ VƯỢT QUA VỚI ĐỘ CHÍNH XÁC TUYỆT ĐỐI!');
    console.log('================================================================');
}

runTests().catch((err) => {
    console.error('Kiểm thử thất bại:', err);
    process.exit(1);
});