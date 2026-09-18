import assert from 'assert';
import {
    createProductionOrder,
    recordQualityCheck,
    updateProductionProgress,
} from '../../features/production/production-service';
import {
    completeInstallationAndHandover,
    dispatchOrderCompletionEvent,
} from '../../features/installation/installation-service';
import {
    createWarrantyTicket,
    reopenWarrantyTicket,
} from '../../features/warranty/warranty-service';

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
}) {
    const db: Record<string, any[]> = {
        contracts: initialData.contracts ? [...initialData.contracts] : [],
        orders: initialData.orders ? [...initialData.orders] : [],
        production_orders: initialData.production_orders ? [...initialData.production_orders] : [],
        installations: initialData.installations ? [...initialData.installations] : [],
        warranty_tickets: initialData.warranty_tickets ? [...initialData.warranty_tickets] : [],
        audit_logs: initialData.audit_logs ? [...initialData.audit_logs] : [],
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
    console.log('================================================================');
    console.log('BẮT ĐẦU BỘ KIỂM THỬ THỰC CHẤT PHÂN HỆ VẬN HÀNH & HẬU MÃI (MEMBER 8)');
    console.log('================================================================\n');

    const COMPANY_ID = 'comp-test-001';
    const ORDER_ID = 'order-test-101';
    const CUSTOMER_ID = 'cust-test-201';

    // =========================================================================
    // Test 1: createProductionOrder ném lỗi khi contract chưa SIGNED hoặc thiếu signed_file_ref
    // =========================================================================
    console.log('▶ TEST 1: createProductionOrder - Ràng buộc hợp đồng đã ký & tệp hợp đồng');
    {
        // Case 1a: Hợp đồng ở trạng thái DRAFT (chưa SIGNED)
        const mockDraft = createMockClient({
            contracts: [
                {
                    id: 'contract-1',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'DRAFT',
                    signed_file_ref: 'contracts/signed_draft.pdf',
                    is_current: true,
                },
            ],
            production_orders: [],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'CONFIRMED' }],
        });

        await assert.rejects(
            async () => {
                await createProductionOrder(
                    COMPANY_ID,
                    {
                        orderId: ORDER_ID,
                        specs: { width: 1200, height: 600 },
                        materials: { frame: 'inox_304' },
                        deadline: '2026-10-01',
                    },
                    mockDraft
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('chưa có hợp đồng đã ký hoặc chưa tải lên tệp hợp đồng hợp lệ'),
                    `Thông điệp lỗi không đúng: ${err.message}`
                );
                return true;
            },
            'Phải từ chối tạo lệnh sản xuất khi contract.status !== SIGNED'
        );

        // Case 1b: Hợp đồng đã SIGNED nhưng thiếu signed_file_ref
        const mockMissingFile = createMockClient({
            contracts: [
                {
                    id: 'contract-2',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'SIGNED',
                    signed_file_ref: null,
                    is_current: true,
                },
            ],
            production_orders: [],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'CONFIRMED' }],
        });

        await assert.rejects(
            async () => {
                await createProductionOrder(
                    COMPANY_ID,
                    {
                        orderId: ORDER_ID,
                        specs: { width: 1200, height: 600 },
                        materials: { frame: 'inox_304' },
                        deadline: '2026-10-01',
                    },
                    mockMissingFile
                );
            },
            (err: Error) => {
                assert.ok(
                    err.message.includes('chưa có hợp đồng đã ký hoặc chưa tải lên tệp hợp đồng hợp lệ'),
                    `Thông điệp lỗi không đúng: ${err.message}`
                );
                return true;
            },
            'Phải từ chối tạo lệnh sản xuất khi signed_file_ref rỗng/null'
        );

        // Case 1c: Hợp đồng SIGNED và có signed_file_ref hợp lệ -> Tạo thành công và cập nhật đơn hàng
        const mockValid = createMockClient({
            contracts: [
                {
                    id: 'contract-3',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'SIGNED',
                    signed_file_ref: 'contracts/signed_order_101.pdf',
                    is_current: true,
                },
            ],
            production_orders: [],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'CONFIRMED' }],
        });

        const prodOrder = await createProductionOrder(
            COMPANY_ID,
            {
                orderId: ORDER_ID,
                specs: { width: 1200, height: 600 },
                materials: { frame: 'inox_304' },
                deadline: '2026-10-01',
            },
            mockValid
        );

        assert.strictEqual(prodOrder.status, 'RELEASED_TO_FACTORY', 'Trạng thái ban đầu phải là RELEASED_TO_FACTORY');
        assert.strictEqual(prodOrder.qcStatus, 'PENDING', 'QC ban đầu phải là PENDING');
        assert.strictEqual(mockValid._db.orders[0].order_status, 'IN_PRODUCTION', 'Trạng thái đơn hàng phải đổi sang IN_PRODUCTION');
        console.log('  ✔ Test 1 ĐẠT: Kiểm tra chặt chẽ điều kiện hợp đồng đã ký và tệp đính kèm.');
    }

    // =========================================================================
    // Test 2: completeInstallationAndHandover ném lỗi khi photos rỗng hoặc thiếu handover_ref
    // =========================================================================
    console.log('▶ TEST 2: completeInstallationAndHandover - Ràng buộc ảnh hiện trường & biên bản');
    {
        const mockClient = createMockClient({
            installations: [
                {
                    id: 'inst-001',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'INSTALLING',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'INSTALLING' }],
        });

        // Case 2a: photos rỗng
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    {
                        installationId: 'inst-001',
                        photos: [],
                        handoverRef: 'handover_signed_001.pdf',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.strictEqual(
                    err.message,
                    'Nghiệm thu bắt buộc phải có ảnh chụp hiện trường đã lắp đặt.'
                );
                return true;
            },
            'Phải ném lỗi khi danh sách photos rỗng'
        );

        // Case 2b: thiếu handoverRef
        await assert.rejects(
            async () => {
                await completeInstallationAndHandover(
                    COMPANY_ID,
                    {
                        installationId: 'inst-001',
                        photos: ['https://storage.local/photo1.jpg'],
                        handoverRef: '   ',
                    },
                    mockClient
                );
            },
            (err: Error) => {
                assert.strictEqual(
                    err.message,
                    'Nghiệm thu bắt buộc phải đính kèm file biên bản bàn giao có chữ ký khách hàng.'
                );
                return true;
            },
            'Phải ném lỗi khi handoverRef là chuỗi rỗng'
        );
        console.log('  ✔ Test 2 ĐẠT: Đã chặn triệt để nghiệm thu thiếu ảnh hoặc thiếu biên bản ký.');
    }

    // =========================================================================
    // Test 3: completeInstallationAndHandover khôi phục cập nhật đơn hàng thành công khi cài đặt đã COMPLETED nhưng order bị kẹt trạng thái cũ
    // =========================================================================
    console.log('▶ TEST 3: completeInstallationAndHandover - Phục hồi kẹt trạng thái (Resilient Idempotency)');
    {
        // Giả lập tình huống lỗi mạng: Lắp đặt đã lưu COMPLETED ở lần gọi trước, nhưng đơn hàng bị kẹt ở trạng thái INSTALLING
        const mockStuck = createMockClient({
            installations: [
                {
                    id: 'inst-stuck-001',
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'COMPLETED',
                    photos: ['https://storage.local/installed.jpg'],
                    handover_ref: 'handover_001.pdf',
                },
            ],
            orders: [
                {
                    id: ORDER_ID,
                    company_id: COMPANY_ID,
                    order_status: 'INSTALLING', // Kẹt trạng thái cũ!
                },
            ],
        });

        // Gọi lại completeInstallationAndHandover để chạy bù
        await completeInstallationAndHandover(
            COMPANY_ID,
            {
                installationId: 'inst-stuck-001',
                photos: ['https://storage.local/installed.jpg'],
                handoverRef: 'handover_001.pdf',
            },
            mockStuck
        );

        // Kiểm tra order_status đã được giải cứu thành COMPLETED
        assert.strictEqual(
            mockStuck._db.orders[0].order_status,
            'COMPLETED',
            'Đơn hàng kẹt trạng thái phải được chạy bù cập nhật thành COMPLETED'
        );

        // Kiểm tra lần gọi tiếp theo khi CẢ HAI đã COMPLETED -> Thoát sớm, không gọi update thêm
        const updateCallsBefore = mockStuck._updateCalls.length;
        await completeInstallationAndHandover(
            COMPANY_ID,
            {
                installationId: 'inst-stuck-001',
                photos: ['https://storage.local/installed.jpg'],
                handoverRef: 'handover_001.pdf',
            },
            mockStuck
        );
        assert.strictEqual(
            mockStuck._updateCalls.length,
            updateCallsBefore,
            'Khi cả 2 đã COMPLETED, hệ thống phải idempotent thoát sớm mà không cập nhật thừa'
        );
        console.log('  ✔ Test 3 ĐẠT: Cơ chế Resilient Idempotency phục hồi đơn hàng bị kẹt thành công.');
    }

    // =========================================================================
    // Test 4: createWarrantyTicket từ chối và ném lỗi rõ ràng nếu order_status khác 'COMPLETED'
    // =========================================================================
    console.log('▶ TEST 4: createWarrantyTicket - Chặn tuyệt đối mở bảo hành khi đơn chưa COMPLETED');
    {
        const uncompletedStatuses = ['DRAFT', 'IN_PRODUCTION', 'INSTALLING', 'READY_FOR_INSTALL'];

        for (const status of uncompletedStatuses) {
            const mockUncompleted = createMockClient({
                orders: [
                    {
                        id: ORDER_ID,
                        company_id: COMPANY_ID,
                        customer_id: CUSTOMER_ID,
                        order_status: status,
                    },
                ],
                warranty_tickets: [],
            });

            await assert.rejects(
                async () => {
                    await createWarrantyTicket(
                        COMPANY_ID,
                        {
                            customerId: CUSTOMER_ID,
                            orderId: ORDER_ID,
                            issue: 'Nước rò rỉ qua mép ron',
                        },
                        mockUncompleted
                    );
                },
                (err: Error) => {
                    assert.strictEqual(
                        err.message,
                        'Chỉ đơn hàng đã hoàn tất nghiệm thu và bàn giao (COMPLETED) mới đủ điều kiện mở phiếu bảo hành.',
                        `Lỗi không đúng khi order_status = ${status}`
                    );
                    return true;
                },
                `Phải chặn mở bảo hành khi đơn hàng ở trạng thái ${status}`
            );
        }

        // Kiểm tra đơn hàng COMPLETED mở thành công
        const mockCompleted = createMockClient({
            orders: [
                {
                    id: ORDER_ID,
                    company_id: COMPANY_ID,
                    customer_id: CUSTOMER_ID,
                    order_status: 'COMPLETED',
                },
            ],
            warranty_tickets: [],
            installations: [],
        });

        const ticket = await createWarrantyTicket(
            COMPANY_ID,
            {
                customerId: CUSTOMER_ID,
                orderId: ORDER_ID,
                issue: 'Kiểm tra bảo dưỡng định kỳ 6 tháng',
            },
            mockCompleted
        );

        assert.strictEqual(ticket.status, 'OPEN', 'Phiếu mới tạo phải ở trạng thái OPEN');
        assert.strictEqual(ticket.orderId, ORDER_ID);
        console.log('  ✔ Test 4 ĐẠT: Chặn tuyệt đối mở bảo hành cho đơn chưa nghiệm thu (DRAFT, IN_PRODUCTION, INSTALLING).');
    }

    // =========================================================================
    // Test 5: recordQualityCheck ánh xạ đúng trạng thái: QC PASSED -> READY_FOR_DISPATCH và ghi nhận inspectorId
    // =========================================================================
    console.log('▶ TEST 5: recordQualityCheck - Ánh xạ trạng thái QC và Audit Trail với inspectorId');
    {
        const INSPECTOR_ID = 'user-tech-999';
        const PROD_ORDER_ID = 'po-901';

        const mockClient = createMockClient({
            production_orders: [
                {
                    id: PROD_ORDER_ID,
                    company_id: COMPANY_ID,
                    order_id: ORDER_ID,
                    status: 'QC_IN_PROGRESS',
                    qc_status: 'PENDING',
                },
            ],
            orders: [{ id: ORDER_ID, company_id: COMPANY_ID, order_status: 'IN_PRODUCTION' }],
            audit_logs: [],
        });

        // 5a: Thiếu inspectorId -> Bị từ chối ngay lập tức
        await assert.rejects(
            async () => {
                await recordQualityCheck(
                    COMPANY_ID,
                    {
                        productionOrderId: PROD_ORDER_ID,
                        qcStatus: 'PASSED',
                        inspectorId: '', // Rỗng
                    },
                    undefined,
                    undefined,
                    undefined,
                    mockClient
                );
            },
            (err: Error) => {
                assert.ok(err.message.includes('inspectorId'));
                return true;
            },
            'Phải từ chối QC khi thiếu định danh kiểm định viên'
        );

        // 5b: QC PASSED -> Chuyển production order sang READY_FOR_DISPATCH, order sang READY_FOR_INSTALL và ghi audit_logs
        await recordQualityCheck(
            COMPANY_ID,
            {
                productionOrderId: PROD_ORDER_ID,
                qcStatus: 'PASSED',
                inspectorId: INSPECTOR_ID,
                notes: 'Kiểm tra kích thước đạt dung sai +/- 1mm',
            },
            undefined,
            undefined,
            undefined,
            mockClient
        );

        const updatedProd = mockClient._db.production_orders[0];
        assert.strictEqual(updatedProd.status, 'READY_FOR_DISPATCH', 'QC PASSED phải đổi status thành READY_FOR_DISPATCH');
        assert.strictEqual(updatedProd.qc_status, 'PASSED', 'qc_status phải đổi thành PASSED');

        const updatedOrder = mockClient._db.orders[0];
        assert.strictEqual(updatedOrder.order_status, 'READY_FOR_INSTALL', 'Đơn hàng phải chuyển sang READY_FOR_INSTALL');

        // Kiểm tra bản ghi kiểm toán audit_logs
        const auditLog = mockClient._db.audit_logs[0];
        assert.ok(auditLog, 'Bắt buộc phải có bản ghi kiểm toán trong audit_logs');
        assert.strictEqual(auditLog.action, 'RECORD_QUALITY_CHECK');
        assert.strictEqual(auditLog.resource_type, 'production_orders');
        assert.strictEqual(auditLog.resource_id, PROD_ORDER_ID);
        assert.strictEqual(auditLog.user_id, INSPECTOR_ID);
        assert.strictEqual(auditLog.result, 'SUCCESS');
        assert.strictEqual(auditLog.metadata.old_status, 'QC_IN_PROGRESS');
        assert.strictEqual(auditLog.metadata.new_status, 'READY_FOR_DISPATCH');
        assert.strictEqual(auditLog.metadata.qc_status, 'PASSED');
        assert.strictEqual(auditLog.metadata.notes, 'Kiểm tra kích thước đạt dung sai +/- 1mm');

        // 5c: Cập nhật tiến độ cũng phải ghi audit_logs
        await updateProductionProgress(
            COMPANY_ID,
            {
                productionOrderId: PROD_ORDER_ID,
                status: 'IN_PRODUCTION',
                note: 'Tiến hành gia công hàn khung cửa',
                actorId: INSPECTOR_ID,
            },
            undefined,
            undefined,
            undefined,
            mockClient
        );

        const progressAudit = mockClient._db.audit_logs[1];
        assert.ok(progressAudit, 'Cập nhật tiến độ phải có bản ghi audit_logs');
        assert.strictEqual(progressAudit.action, 'UPDATE_PRODUCTION_PROGRESS');
        assert.strictEqual(progressAudit.user_id, INSPECTOR_ID);
        assert.strictEqual(progressAudit.result, 'SUCCESS');
        assert.strictEqual(progressAudit.metadata.new_status, 'IN_PRODUCTION');

        console.log('  ✔ Test 5 ĐẠT: QC PASSED -> READY_FOR_DISPATCH, cập nhật đơn hàng và ghi nhận audit_logs đầy đủ.');
    }

    // =========================================================================
    // Test 6: reopenWarrantyTicket lưu vết lý do mở lại và chuyển trạng thái sang REOPENED
    // =========================================================================
    console.log('▶ TEST 6: reopenWarrantyTicket - Lưu vết lý do mở lại & chuyển sang REOPENED');
    {
        const TICKET_ID = 'wt-301';
        const initialNotes = 'Đã thay ron cao su lần đầu lúc 10h sáng.';

        const mockClient = createMockClient({
            warranty_tickets: [
                {
                    id: TICKET_ID,
                    company_id: COMPANY_ID,
                    customer_id: CUSTOMER_ID,
                    order_id: ORDER_ID,
                    status: 'RESOLVED',
                    resolved_at: '2026-09-15T10:00:00.000Z',
                    notes: initialNotes,
                },
            ],
        });

        const reopenReason = 'Trận mưa chiều làm ngấm nước góc mép trái.';
        await reopenWarrantyTicket(
            COMPANY_ID,
            {
                ticketId: TICKET_ID,
                reason: reopenReason,
            },
            mockClient
        );

        const reopenedTicket = mockClient._db.warranty_tickets[0];
        assert.strictEqual(reopenedTicket.status, 'REOPENED', 'Phiếu phải chuyển sang REOPENED');
        assert.strictEqual(reopenedTicket.resolved_at, null, 'resolved_at phải được đặt lại null');
        assert.ok(
            reopenedTicket.notes.includes(initialNotes),
            'Ghi chú ban đầu phải được giữ nguyên vẹn'
        );
        assert.ok(
            reopenedTicket.notes.includes(`REOPEN: ${reopenReason}`),
            'Lý do mở lại phải được lưu vết rõ ràng kèm timestamp'
        );
        console.log('  ✔ Test 6 ĐẠT: reopenWarrantyTicket bảo toàn lịch sử và chuyển trạng thái chính xác.');
    }

    console.log('\n================================================================');
    console.log('TẤT CẢ 6/6 CA KIỂM THỬ THỰC CHẤT ĐÃ VƯỢT QUA VỚI ĐỘ CHÍNH XÁC TUYỆT ĐỐI!');
    console.log('================================================================');
}

runTests().catch((err) => {
    console.error('Kiểm thử thất bại:', err);
    process.exit(1);
});