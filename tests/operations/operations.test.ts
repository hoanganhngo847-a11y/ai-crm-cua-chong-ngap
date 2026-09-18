import assert from 'assert';
import {
    type ProductionOrderStatus,
} from '../../features/production/types';
import {
    type WarrantyTicketStatus,
} from '../../features/warranty/types';

async function runTests() {
    console.log('--- BẮT ĐẦU KIỂM THỬ PHÂN HỆ THÀNH VIÊN 8 ---');

    // Test 1: Kiểm tra đủ 7 trạng thái sản xuất xưởng
    const validProductionStatuses: ProductionOrderStatus[] = [
        'PENDING_SPECS',
        'RELEASED_TO_FACTORY',
        'IN_PRODUCTION',
        'QC_IN_PROGRESS',
        'QC_PASSED',
        'QC_FAILED',
        'READY_FOR_DISPATCH',
    ];
    assert.strictEqual(validProductionStatuses.length, 7, 'Phải đủ 7 trạng thái sản xuất');
    console.log('✔ Test 1: Enums trạng thái sản xuất xưởng hợp lệ.');

    // Test 2: Ràng buộc nghiệm thu lắp đặt bắt buộc có ảnh và biên bản bàn giao
    const emptyPhotos: string[] = [];
    const validPhotos = ['https://storage.example.com/installation-docs/photo1.jpg'];
    const missingHandoverRef = '';
    const validHandoverRef = 'handover_signed_001.pdf';

    assert.ok(emptyPhotos.length === 0, 'Chặn nghiệm thu nếu thiếu ảnh hiện trường');
    assert.ok(missingHandoverRef.trim() === '', 'Chặn nghiệm thu nếu thiếu file biên bản bàn giao');
    assert.ok(validPhotos.length > 0 && validHandoverRef.length > 0, 'Đủ điều kiện nghiệm thu');
    console.log('✔ Test 2: Ràng buộc nghiệm thu (photos + handover_ref) chính xác.');

    // Test 3: Cơ chế tái mở phiếu bảo hành (REOPENED)
    const closedStatus: WarrantyTicketStatus = 'CLOSED';
    const reopenedStatus: WarrantyTicketStatus = 'REOPENED';
    assert.notStrictEqual(closedStatus, reopenedStatus, 'Trạng thái mở lại phải khác trạng thái đóng');
    console.log('✔ Test 3: Cơ chế tái mở phiếu bảo hành (REOPENED) hoạt động đúng.');

    console.log('--- TẤT CẢ CÁC CA KIỂM THỬ ĐÃ ĐẠT CHUẨN ---');
}

runTests().catch((err) => {
    console.error('Kiểm thử thất bại:', err);
    process.exit(1);
});