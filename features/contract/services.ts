import { createClient } from '@/lib/supabase/server';

/**
 * Tự động sinh hợp đồng dựa trên đơn hàng đã cọc.
 * LUẬT NGHIỆP VỤ BẮT BUỘC: Hợp đồng sinh ra phải bám sát 100% dữ liệu từ đơn hàng và bảng giá.
 * Tuyệt đối không cho phép AI tự động giảm giá, tự tạo cam kết, hay thay đổi điều khoản.
 */
export async function generateContractForOrder(orderId: string, customerId: string) {
  const supabase = createClient();

  // 1. Kiểm tra xem hợp đồng đã tồn tại cho đơn này chưa để tránh tạo trùng
  const { data: existingContract } = await supabase
    .from('contracts')
    .select('id')
    .eq('order_id', orderId)
    .single();

  if (existingContract) {
    return existingContract;
  }
  
  // (Trong thực tế, ở bước này ta sẽ fetch order + price_calculations để lấy dữ liệu snapshot giá
  //  và ráp vào template hợp đồng chuẩn của công ty mà không được phép sửa đổi tuỳ tiện)

  // 2. Tạo bản ghi Hợp đồng (Contract) liên kết chặt chẽ với Order
  const { data: newContract, error } = await supabase
    .from('contracts')
    .insert({
      order_id: orderId,
      customer_id: customerId,
      status: 'DRAFT', // Trạng thái ban đầu là DRAFT (Chưa ký)
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
  const supabase = createClient();
  
  // Lấy danh sách hợp đồng kèm theo thông tin công nợ từ bảng orders
  const { data, error } = await supabase
    .from('contracts')
    .select(`
      id,
      status,
      signed_file_ref,
      created_at,
      orders (
        total_amount,
        deposit_amount,
        remaining_amount
      ),
      customers (
        id,
        name
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Lỗi khi lấy danh sách hợp đồng và công nợ:', error);
    return [];
  }
  return data;
}
