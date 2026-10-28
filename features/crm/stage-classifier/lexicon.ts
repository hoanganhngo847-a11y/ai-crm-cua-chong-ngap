import type { StageSignalDefinition } from './types';

/**
 * Lexicon tiếng Việt đã bỏ dấu (xem normalize.ts).
 *
 * Nguyên tắc:
 * - Mỗi tín hiệu thuộc đúng một giai đoạn đích.
 * - Tín hiệu hợp đồng đã ký có trọng số cao nhưng luôn bị kiểm tra phủ định/
 *   tương lai/giả định trước khi tính điểm.
 * - "muốn ký", "chờ ký", "gửi hợp đồng" nằm ở high_potential, KHÔNG phải contract_signed.
 */
export const STAGE_SIGNALS: StageSignalDefinition[] = [
  // ==========================================================================
  // AWARENESS
  // ==========================================================================
  {
    id: 'awareness_initial',
    stage: 'awareness',
    weight: 0.25,
    kind: 'INTENT',
    patterns: ['lan dau', 'moi biet', 'moi tim hieu', 'chua biet', 'moi nghe'],
    description: 'Khách mới bắt đầu tìm hiểu, chưa có nhu cầu cụ thể',
  },
  {
    id: 'awareness_contact',
    stage: 'awareness',
    weight: 0.2,
    kind: 'INTENT',
    patterns: ['de lai so', 'lien he lai', 'goi lai', 'nhan tin lai', 'tu van giup'],
    description: 'Khách để lại thông tin / yêu cầu liên hệ',
  },
  {
    id: 'awareness_unreachable',
    stage: 'awareness',
    weight: 0.25,
    kind: 'INTENT',
    patterns: ['khong nghe may', 'khong tra loi', 'khong phan hoi', 'khong lien lac duoc', 'sai so'],
    description: 'Chưa liên lạc được, chưa có bằng chứng nhu cầu',
  },

  // ==========================================================================
  // INTERESTED
  // ==========================================================================
  {
    id: 'interested_price',
    stage: 'interested',
    weight: 0.55,
    kind: 'INTENT',
    patterns: [
      'gia bao nhieu',
      'bao nhieu tien',
      'xin gia',
      'gui gia',
      'bang gia',
      'bao gia',
      'gia the nao',
      'co gia',
      'chi phi',
      'gia sao',
    ],
    description: 'Khách hỏi giá / chi phí',
  },
  {
    id: 'interested_product',
    stage: 'interested',
    weight: 0.35,
    kind: 'INTENT',
    patterns: ['san pham', 'mau ma', 'co san', 'cung cap', 'tu van', 'thong tin san pham', 'co loai nao'],
    description: 'Khách hỏi thông tin sản phẩm/dịch vụ',
  },
  {
    id: 'interested_warranty',
    stage: 'interested',
    weight: 0.4,
    kind: 'INTENT',
    patterns: ['bao hanh', 'chinh sach bao hanh', 'doi tra', 'bao tri'],
    description: 'Khách hỏi bảo hành/chính sách',
  },

  // ==========================================================================
  // DEEP_RESEARCH
  // ==========================================================================
  {
    id: 'research_compare',
    stage: 'deep_research',
    weight: 0.55,
    kind: 'RESEARCH',
    patterns: ['so sanh', 'khac gi', 'khac nhau', 'uu diem', 'nhuoc diem', 'co nen', 'nen chon', 'phuong an nao'],
    description: 'Khách so sánh / đánh giá phương án',
  },
  {
    id: 'research_technical',
    stage: 'deep_research',
    weight: 0.45,
    kind: 'RESEARCH',
    patterns: [
      'thong so',
      'ky thuat',
      'chat lieu',
      'kich thuoc',
      'chieu rong',
      'chieu cao',
      'do day',
      'tai trong',
      'chong nuoc',
      'chong ngap',
      'cam bien',
      'tu dong',
      'ket noi',
      'app',
      'dien nang',
    ],
    description: 'Khách hỏi thông số kỹ thuật / vật liệu',
  },
  {
    id: 'research_docs',
    stage: 'deep_research',
    weight: 0.45,
    kind: 'RESEARCH',
    patterns: ['tai lieu', 'catalogue', 'catalog', 'chung nhan', 'kiem dinh', 'tieu chuan', 'quy trinh', 'thi cong', 'lap dat'],
    description: 'Khách yêu cầu tài liệu/chứng nhận/quy trình',
  },
  {
    id: 'research_survey',
    stage: 'deep_research',
    weight: 0.5,
    kind: 'RESEARCH',
    patterns: ['khao sat', 'do dac', 'xem nha', 'xem cua', 'den do', 'do kich thuoc'],
    description: 'Khách đồng ý khảo sát / đo đạc',
  },
  {
    id: 'research_consider',
    stage: 'deep_research',
    weight: 0.35,
    kind: 'RESEARCH',
    patterns: ['can nhac', 'nghien cuu', 'tim hieu them', 'xem them', 'hoi them', 'dang xem'],
    description: 'Khách đang cân nhắc / tìm hiểu thêm',
  },

  // ==========================================================================
  // HIGH_POTENTIAL
  // ==========================================================================
  {
    id: 'high_purchase_intent',
    stage: 'high_potential',
    weight: 0.7,
    kind: 'COMMITMENT',
    patterns: [
      'muon mua',
      'muon lap',
      'muon lam',
      'quyet dinh mua',
      'chot',
      'dat hang',
      'tien hanh',
      'dong y lam',
      'chon ben',
      'chon shop',
      'lam luon',
    ],
    description: 'Khách thể hiện ý định mua/lắp đặt rõ ràng',
  },
  {
    id: 'high_contract_next',
    stage: 'high_potential',
    weight: 0.6,
    kind: 'COMMITMENT',
    patterns: [
      'ky hop dong',
      'lam hop dong',
      'soan hop dong',
      'gui hop dong',
      'xem hop dong',
      'chuan bi ky',
      'cho ky',
      'muon ky',
      'sap ky',
      'thao hop dong',
    ],
    description: 'Khách đang ở bước chuẩn bị/đàm phán hợp đồng, chưa ký',
  },
  {
    id: 'high_schedule',
    stage: 'high_potential',
    weight: 0.4,
    kind: 'COMMITMENT',
    patterns: ['hen khao sat', 'hen do', 'hen gap', 'ngay mai', 'tuan sau', 'thang sau', 'dau thang', 'cuoi thang'],
    description: 'Khách hẹn lịch cụ thể',
  },
  {
    id: 'high_negotiation',
    stage: 'high_potential',
    weight: 0.45,
    kind: 'COMMITMENT',
    patterns: ['thuong luong', 'giam gia', 'chiet khau', 'gia cuoi', 'gia tot', 'ho tro them'],
    description: 'Khách thương lượng giá/điều kiện',
  },
  {
    id: 'high_deposit',
    stage: 'high_potential',
    weight: 0.6,
    kind: 'COMMITMENT',
    patterns: ['dat coc', 'coc truoc', 'chuyen khoan truoc', 'thanh toan truoc'],
    description: 'Khách đồng ý đặt cọc / thanh toán trước',
  },

  // ==========================================================================
  // CONTRACT_SIGNED
  // ==========================================================================
  {
    id: 'contract_signed',
    stage: 'contract_signed',
    weight: 0.95,
    kind: 'CONTRACT',
    patterns: [
      'da ky hop dong',
      'ky hop dong roi',
      'hop dong da ky',
      'da ky roi',
      'ky roi',
      'da ky',
      'da xac nhan ky',
      'dong y ky',
      'ky xong',
    ],
    description: 'Có xác nhận hợp đồng đã được ký',
  },
  {
    // Chứng từ/đơn hàng là tín hiệu mua mạnh nhưng KHÔNG chứng minh hợp đồng đã ký.
    // Chỉ "đã ký hợp đồng" hoặc công trình đã triển khai mới đủ căn cứ contract_signed.
    id: 'high_contract_document',
    stage: 'high_potential',
    weight: 0.65,
    kind: 'COMMITMENT',
    patterns: ['hop dong so', 'ban hop dong', 'hoa don', 'bien nhan', 'xac nhan don hang', 'don hang da tao'],
    description: 'Có chứng từ/đơn hàng xác nhận nhưng chưa chắc hợp đồng đã ký',
  },
  {
    id: 'contract_execution',
    stage: 'contract_signed',
    weight: 0.85,
    kind: 'CONTRACT',
    patterns: [
      'dang thi cong',
      'da thi cong',
      'hoan thanh thi cong',
      'nghiem thu',
      'ban giao',
      'da lap dat',
      'dang lap dat',
      'kich hoat bao hanh',
    ],
    description: 'Công trình đã/đang được triển khai sau hợp đồng',
  },

  // ==========================================================================
  // LOW_POTENTIAL
  // ==========================================================================
  {
    id: 'low_no_demand',
    stage: 'low_potential',
    weight: 0.8,
    kind: 'NEGATIVE',
    patterns: [
      'khong co nhu cau',
      'khong can',
      'chua co nhu cau',
      'khong co y dinh',
      'khong muon',
      'khong quan tam',
      'khong phu hop',
      'khong mua',
      'khong lam',
    ],
    description: 'Khách nói rõ không có nhu cầu',
  },
  {
    id: 'low_no_condition',
    stage: 'low_potential',
    weight: 0.65,
    kind: 'NEGATIVE',
    patterns: [
      'khong co nha',
      'khong co tien',
      'ngan sach khong',
      'khong du dieu kien',
      'qua dat',
      'khong can thiet',
      'chua co ke hoach',
    ],
    description: 'Khách thiếu điều kiện/ngân sách/kế hoạch',
  },
  {
    id: 'low_other_provider',
    stage: 'low_potential',
    weight: 0.9,
    kind: 'NEGATIVE',
    patterns: [
      'da chon ben khac',
      'da lam voi ben khac',
      'da mua cua hang khac',
      'da ky voi ben khac',
      'chon cong ty khac',
      'da co don vi khac',
    ],
    description: 'Khách đã chọn đơn vị khác',
  },
  {
    id: 'low_cancel',
    stage: 'low_potential',
    weight: 0.6,
    kind: 'NEGATIVE',
    patterns: ['huy', 'thoi', 'de sau', 'khong can nua', 'dung lien he', 'khong lam nua'],
    description: 'Khách hủy/hoãn/dừng trao đổi',
  },
];

/**
 * Tín hiệu phản đối dùng cho trường objections, không trực tiếp quyết định stage.
 */
export const OBJECTION_SIGNALS = [
  {
    id: 'objection_price',
    patterns: ['dat qua', 'gia cao', 'hoi dat', 'khong co tien', 'ngan sach', 'chua du tien'],
    description: 'Lo ngại về giá/ngân sách',
  },
  {
    id: 'objection_trust',
    patterns: ['khong yen tam', 'chua tin', 'so', 'lo', 'rui ro', 'chua chac'],
    description: 'Lo ngại về độ tin cậy/rủi ro',
  },
  {
    id: 'objection_time',
    patterns: ['chua can gap', 'de sau', 'thoi gian', 'ban qua', 'chua sap xep duoc'],
    description: 'Chưa sắp xếp được thời gian',
  },
  {
    id: 'objection_compare',
    patterns: ['ben khac', 'so sanh', 'dang xem', 'tham khao'],
    description: 'Đang so sánh với phương án khác',
  },
] as const;
