import { createClient } from '@/lib/supabase/server';

/**
 * Tự động sinh hợp đồng dựa trên đơn hàng đã cọc.
 * LUẬT NGHIỆP VỤ BẮT BUỘC: Hợp đồng sinh ra phải bám sát 100% dữ liệu từ đơn hàng và bảng giá.
 * Tuyệt đối không cho phép AI tự động giảm giá, tự tạo cam kết, hay thay đổi điều khoản.
 */
export async function generateContractForOrder(orderId: string, customerId: string) {
  const supabase = await createClient();

  // 1. Kiểm tra xem hợp đồng đã tồn tại cho đơn này chưa để tránh tạo trùng
  const { data: existingContract } = await supabase
    .from('contracts')
    .select('id')
    .eq('order_id', orderId)
    .single();

  if (existingContract) {
    return existingContract;
  }
  
  // Lấy thông tin công ty và giá trị đơn hàng
  const { data: orderData } = await supabase
    .from('orders')
    .select('company_id, final_amount')
    .eq('id', orderId)
    .single();

  if (!orderData) {
    throw new Error('Không tìm thấy thông tin đơn hàng để tạo hợp đồng');
  }

  // 2. Tạo bản ghi Hợp đồng (Contract) liên kết chặt chẽ với Order
  const { data: newContract, error } = await supabase
    .from('contracts')
    .insert({
      company_id: orderData.company_id,
      order_id: orderId,
      status: 'GENERATED', // Trạng thái ban đầu chuẩn theo Foundation là GENERATED
      revision_no: 1,
      template_version: 'v1',
      generated_file_ref: '/docs/placeholder.pdf',
      contract_value: orderData.final_amount,
      signed_file_ref: null
    })
    .select()
    .single();

  if (error) {
    console.error('Lỗi khi hệ thống tự động sinh hợp đồng:', error);
    throw error;
  }

  return newContract;
}

export async function getContractsWithOrderDetails() {
  const supabase = await createClient();
  
  // Lấy danh sách hợp đồng kèm theo thông tin công nợ từ bảng finance_summaries
  const { data, error } = await supabase
    .from('contracts')
    .select(`
      id,
      status,
      signed_file_ref,
      created_at,
      orders (
        id,
        final_amount,
        customers (
          id,
          name
        ),
        finance_summaries (
          receivable_amount
        )
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Lỗi khi lấy danh sách hợp đồng và công nợ:', error);
    return [];
  }
  return data;
}
