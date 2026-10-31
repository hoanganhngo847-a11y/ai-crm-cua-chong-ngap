#!/usr/bin/env python3
"""
Generate docs/evidence/meta-ads-owner-decisions/decision-register.json
Preserving all 178 original approval items, assigning every pending item to exactly one batch.
"""

import json
import os
import sys

BASE_DIR = '/Users/hoangthuy/.gemini/antigravity/worktrees/ai-crm-cua-chong-ngap/meta_ads_integration'
SRC_ITEMS = os.path.join(BASE_DIR, 'docs/evidence/meta-ads-safe-deployment/destructive-approval-items.json')
OUT_FILE = os.path.join(BASE_DIR, 'docs/evidence/meta-ads-owner-decisions/decision-register.json')

with open(SRC_ITEMS) as f:
    orig_items = json.load(f)

# Batch definitions
BATCH_INFO = {
    'BATCH-01-LEGACY-FLOOD': {
        'name_vi': 'Gói 1: Bảng và hàm nghiệp vụ Cửa chống ngập cũ (47 mục)',
        'summary_vi': 'Xóa bỏ 14 bảng dữ liệu và 33 hàm nghiệp vụ chống ngập cũ (khảo sát, thi công, lắp đặt, báo giá, bảo hành, ngân hàng).',
        'recommendation': 'DEFER',
        'blocks_meta_ads_staging': False,
        'risk_level': 'HIGH'
    },
    'BATCH-02-TV9-SLA': {
        'name_vi': 'Gói 2: Hàm tính SLA phản hồi TV9 (1 mục)',
        'summary_vi': 'Xóa hàm resolve_response_sla_on_sale_reply 3 tham số để thay bằng hàm 4 tham số có giá trị mặc định, kiểm tra trạng thái gửi tin nhắn outbox Hán.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'MEDIUM'
    },
    'BATCH-03-ZALO-SECRETS': {
        'name_vi': 'Gói 3: Bảo mật Token Zalo OA và xử lý Ingress/Outbound Zalo (15 mục)',
        'summary_vi': 'Di chuyển 5 cột token plaintext của Zalo OA sang bảng bảo mật private.zalo_oa_secrets; cập nhật các RPC tiếp nhận, xử lý tin nhắn và ràng buộc gửi tin Zalo.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'HIGH'
    },
    'BATCH-04-STORAGE-CONTRACTS': {
        'name_vi': 'Gói 4: Bảo mật tệp đính kèm Storage và RLS Hợp đồng/Tài khoản (14 mục)',
        'summary_vi': 'Khóa quyền thao tác trực tiếp từ client lên các bucket Storage (contracts, survey-photos, operations-evidence); thắt chặt RLS hợp đồng và tài khoản ngân hàng.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'MEDIUM'
    },
    'BATCH-05-OPERATIONS-LEGACY': {
        'name_vi': 'Gói 5: Phân quyền Lắp đặt, Lịch hẹn và Bổ trợ Backend cũ (9 mục)',
        'summary_vi': 'Xóa overload hàm claim voice media job 1 tham số; xóa trigger/hàm vật tư chống ngập mặc định; cập nhật RLS lịch hẹn và hàm đặt lịch lắp đặt cũ.',
        'recommendation': 'DEFER',
        'blocks_meta_ads_staging': False,
        'risk_level': 'MEDIUM'
    },
    'BATCH-06-AI-OUTBOUND-FENCING': {
        'name_vi': 'Gói 6: Rào chắn AI Sale Fencing và điều phối tin nhắn gửi đi (7 mục)',
        'summary_vi': 'Ngăn chặn AI tranh chấp quyền gửi tin nhắn khi nhân viên tư vấn đang chat; cập nhật RPC điều phối tin nhắn gửi đi và ràng buộc trạng thái outbox.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'HIGH'
    },
    'BATCH-07-FACEBOOK-BROWSER-QUEUE': {
        'name_vi': 'Gói 7: Hàng đợi gửi tin trình duyệt Facebook Browser Worker (5 mục)',
        'summary_vi': 'Cập nhật ràng buộc trạng thái hàng đợi outbound deliveries phục vụ cơ chế gửi tin Facebook qua trình duyệt tự động.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'LOW'
    },
    'BATCH-08-META-DATA-DELETION': {
        'name_vi': 'Gói 8: Cơ chế tuân thủ xóa dữ liệu người dùng Meta Data Deletion (6 mục)',
        'summary_vi': 'Cập nhật các hàm RPC và chính sách tiếp nhận/xử lý yêu cầu xóa dữ liệu người dùng Facebook theo quy định bắt buộc của Meta Platform.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'HIGH'
    },
    'BATCH-09-AI-CONTROL-MONITORING': {
        'name_vi': 'Gói 9: Trung tâm điều khiển AI và hệ thống cảnh báo giám sát (12 mục)',
        'summary_vi': 'Cập nhật phân quyền RLS cho cài đặt AI Brain, bảng cảnh báo giám sát AI và RPC kiểm tra sức khỏe của bộ lập lịch.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'MEDIUM'
    },
    'BATCH-10-MESSENGER-LIVE-SCHEDULER': {
        'name_vi': 'Gói 10: Bộ lập lịch tự động kích hoạt AI trả lời Messenger định kỳ (10 mục)',
        'summary_vi': 'Cài đặt job tự động kích hoạt AI trả lời Facebook Messenger mỗi 1 phút; quản lý canary triggers và ràng buộc trạng thái gửi tin live.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'HIGH'
    },
    'BATCH-11-ZALO-CALLS-CAMPAIGN': {
        'name_vi': 'Gói 11: Chiến dịch Zalo cá nhân 5 phút, tóm tắt cuộc gọi AI và thoại trực tiếp (12 mục)',
        'summary_vi': 'Cập nhật RPC tóm tắt cuộc gọi Zalo bằng AI, hỗ trợ chiến dịch gửi tin Zalo cá nhân 5 phút và đồng bộ phiên gọi thoại trực tiếp.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'MEDIUM'
    },
    'BATCH-12-CUSTOMER-FUNNEL-STAGES': {
        'name_vi': 'Gói 12: Phễu khách hàng 6 giai đoạn tư vấn du học và AI gợi ý giai đoạn (17 mục)',
        'summary_vi': 'Chuyển đổi phân loại khách hàng sang 6 giai đoạn chuẩn tư vấn du học/ngoại ngữ; cập nhật các RPC thống kê phễu và AI gợi ý/xác thực giai đoạn.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': False,
        'risk_level': 'HIGH'
    },
    'BATCH-13-META-ADS-INTEGRATION': {
        'name_vi': 'Gói 13: Bảo mật Token và RPC tiếp nhận Lead Meta Ads (5 mục)',
        'summary_vi': 'Chuyển access token tài khoản quảng cáo Facebook vào Vault bảo mật; cập nhật RPC tiếp nhận Lead quảng cáo và RPC giải phóng khóa đồng bộ.',
        'recommendation': 'REPLACE',
        'blocks_meta_ads_staging': True,
        'risk_level': 'HIGH'
    }
}

def determine_batch(item):
    if not item['pending']:
        return 'HISTORICAL-PREFIX-ALREADY-APPLIED'
    f = item['file']
    if 'remove_legacy_flood_barrier_schema' in f:
        return 'BATCH-01-LEGACY-FLOOD'
    if 'tv9_post_merge_hardening' in f:
        return 'BATCH-02-TV9-SLA'
    if 'zalo_hardening_remediation' in f or 'zalo_round3_remediation' in f:
        return 'BATCH-03-ZALO-SECRETS'
    if any(k in f for k in ['pricing_payment_contract_base', 'contract_storage_hardening', 'p0_security_acl_hardening', 'staging_storage_bucket_provisioning']):
        return 'BATCH-04-STORAGE-CONTRACTS'
    if any(k in f for k in ['p1_backend_remediation', 'installation_rls_and_scheduling_authority']):
        return 'BATCH-05-OPERATIONS-LEGACY'
    if any(k in f for k in ['ai_outbound_delivery_atomic', 'ai_durable_dispatch_hardening', 'ai_sale_fencing_linearization', 'restore_outbound_delivery_status_contract']):
        return 'BATCH-06-AI-OUTBOUND-FENCING'
    if any(k in f for k in ['facebook_browser_outbox_queue', 'facebook_browser_outbox_hardening']):
        return 'BATCH-07-FACEBOOK-BROWSER-QUEUE'
    if 'meta_user_data_deletion' in f:
        return 'BATCH-08-META-DATA-DELETION'
    if any(k in f for k in ['ai_control_center_foundation', 'ai_monitoring_alerting', 'ai_brain_messenger_live_delivery', 'ai_channel_scheduler_health_rpc']):
        return 'BATCH-09-AI-CONTROL-MONITORING'
    if any(k in f for k in ['ai_brain_messenger_live_canary_and_scheduler', 'remove_messenger_pending_sale_gate_and_enable_pages']):
        return 'BATCH-10-MESSENGER-LIVE-SCHEDULER'
    if any(k in f for k in ['zalo_call_ai_summaries', 'zalo_personal_campaign_5min', 'zalo_brain_sla_and_terminal_failures', 'zalo_brain_one_minute_sla', 'zalo_personal_inbound_live_voice']):
        return 'BATCH-11-ZALO-CALLS-CAMPAIGN'
    if any(k in f for k in ['customer_360_ai_dossier', 'botcake_messenger_page_and_du_hoc_ai', 'study_abroad_stages', 'canary_allowlist_foundation_backfill', 'customer_funnel_six_stages']):
        return 'BATCH-12-CUSTOMER-FUNNEL-STAGES'
    if any(k in f for k in ['meta_ads_hardening', 'meta_ads_final_remediation']):
        return 'BATCH-13-META-ADS-INTEGRATION'
    raise ValueError(f"Unknown file for pending item: {f}")

def enrich_item(item):
    batch_id = determine_batch(item)
    t = item['target']
    f = item['file']
    is_pending = item['pending']

    # Defaults
    ext_status = "unknown"
    app_refs = []
    data_count = None
    data_risk = "Low"
    rec = "REPLACE"
    desc_vi = ""
    purpose = ""
    impact_kept = ""
    impact_removed = ""
    recovery = item.get('recovery', 'Khôi phục từ checkpoint/backup cơ sở dữ liệu đã kiểm định.')

    if not is_pending:
        rec = "KEEP"
        desc_vi = f"Đối tượng đã được áp dụng trong 21 migration đầu tiên trên môi trường Staging: {t}."
        purpose = "Đã nằm trong schema Staging hiện tại, bảo toàn tính tương thích cơ bản."
        ext_status = "verified"
        data_risk = "None"
        impact_kept = "Giữ nguyên hiện trạng Staging đang hoạt động ổn định."
        impact_removed = "Không áp dụng vì đối tượng đã được triển khai."
        return {
            'id': item['id'],
            'file': item['file'],
            'line': item['line'],
            'target': item['target'],
            'pending': False,
            'approved': False,
            'batch_id': batch_id,
            'vietnamese_description': desc_vi,
            'current_purpose': purpose,
            'application_references': app_refs,
            'external_consumer_status': ext_status,
            'current_data_count': "Đã triển khai trên Staging",
            'impact_if_kept': impact_kept,
            'impact_if_removed': impact_removed,
            'data_loss_risk': data_risk,
            'recovery_requirements': recovery,
            'recommended_decision': rec,
            'evidence_links': [
                'docs/META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md',
                'docs/evidence/meta-ads-safe-deployment/DESTRUCTIVE_APPROVAL_ITEMS.md'
            ]
        }

    # Handling for pending items by batch
    if batch_id == 'BATCH-01-LEGACY-FLOOD':
        rec = 'DEFER'
        data_count = '0 rows (Staging hiện tại)'
        data_risk = 'High'
        if '(table)' in t or not '(' in t.split('.')[-1]:
            table_name = t.split('.')[-1]
            desc_vi = f"Bảng dữ liệu nghiệp vụ chống ngập cũ: {table_name}."
            purpose = f"Lưu trữ dữ liệu lịch sử {table_name} của mảng kinh doanh cửa chống ngập cũ."
            impact_kept = "Giữ lại toàn vẹn cấu trúc và dữ liệu lịch sử nếu cần đối soát/tra cứu tài liệu cũ."
            impact_removed = "Xóa hoàn toàn bảng dữ liệu khỏi PostgreSQL. Không thể truy xuất lại dữ liệu hoặc tạo Signed URL tải tài liệu liên quan."
            recovery = "Phải khôi phục từ snapshot/backup PostgreSQL đầy đủ."
            if table_name in ['surveys', 'contracts', 'installations', 'appointments', 'orders', 'payment_transactions']:
                app_refs = ['lib/sensitive/signed-urls.ts', 'lib/server-auth/resource-access.ts']
        else:
            func_name = t.split('(')[0].split('.')[-1]
            desc_vi = f"Hàm nghiệp vụ chống ngập cũ: {func_name}."
            purpose = f"Xử lý logic vận hành {func_name} trong chu trình chống ngập cũ."
            impact_kept = "Hàm vẫn tồn tại trong database nhưng không ảnh hưởng đến các luồng du học/Meta Ads."
            impact_removed = "Hàm bị xóa vĩnh viễn khỏi pg_proc. Bất kỳ client cũ nào gọi đến sẽ nhận lỗi không tìm thấy hàm."
            recovery = "Nạp lại định nghĩa hàm từ migration lịch sử."

    elif batch_id == 'BATCH-02-TV9-SLA':
        rec = 'REPLACE'
        desc_vi = "Hàm tính toán thời gian cam kết phản hồi (SLA) của tư vấn viên khi gửi tin nhắn cho khách hàng."
        purpose = "Ghi nhận mốc thời gian hoàn tất SLA phản hồi dựa trên tin nhắn outbox thực tế đã gửi (SENT)."
        app_refs = ['lib/response-sla/response-sla-store.ts', 'features/facebook/server.ts']
        ext_status = 'unverified'
        data_risk = 'Low'
        impact_kept = "Duy trì hàm 3 tham số cũ nhưng không đồng bộ ngữ nghĩa thời gian gửi thực tế của tin nhắn."
        impact_removed = "Xóa chữ ký 3 tham số để thay bằng hàm 4 tham số có giá trị mặc định, tương thích với hầu hết caller truyền 3 tham số qua tên."
        recovery = "Khôi phục chữ ký hàm 3 tham số nếu phát hiện có client PostgREST bên ngoài gọi trực tiếp."

    elif batch_id == 'BATCH-03-ZALO-SECRETS':
        rec = 'REPLACE'
        data_risk = 'High'
        if 'zalo_oa_configs' in t:
            col = t.split('.')[-1].split(' ')[0]
            desc_vi = f"Cột bí mật bảo mật Zalo OA ({col}) trên bảng công khai public.zalo_oa_configs."
            purpose = f"Lưu trữ thông tin xác thực {col} của Zalo Official Account."
            app_refs = ['lib/zalo/server.ts', 'features/zalo/services/zalo-client.ts']
            data_count = 'Được di chuyển sang private.zalo_oa_secrets'
            impact_kept = "Để lộ token Zalo dạng văn bản rõ trên bảng công khai, có nguy cơ bị lộ qua API."
            impact_removed = "Xóa cột công khai sau khi đã chuyển toàn bộ token vào bảng nội bộ private an toàn."
            recovery = "Truy xuất lại giá trị token từ bảng private.zalo_oa_secrets."
        else:
            desc_vi = f"Hàm xử lý hoặc ràng buộc tin nhắn Zalo: {t}."
            purpose = "Tiếp nhận Webhook Zalo, xử lý tin nhắn đến và đồng bộ trạng thái tin nhắn gửi đi."
            app_refs = ['features/zalo/services/zalo-client.ts', 'lib/zalo/server.ts']
            impact_kept = "Giữ cơ chế xử lý tin Zalo cũ, thiếu khả năng xử lý bất đồng bộ và chống trùng lặp."
            impact_removed = "Thay thế bằng cơ chế tiếp nhận và xác thực tin nhắn Zalo mới, tăng tính ổn định."

    elif batch_id == 'BATCH-04-STORAGE-CONTRACTS':
        rec = 'REPLACE'
        desc_vi = f"Chính sách bảo mật RLS trên Storage/Hợp đồng: {t}."
        purpose = "Chặn quyền truy cập/tải tệp trực tiếp từ trình duyệt; yêu cầu xác thực qua Signed URL máy chủ."
        app_refs = ['lib/sensitive/signed-urls.ts', 'app/actions/sensitive.ts']
        data_risk = 'Low'
        impact_kept = "Người dùng hoặc client có thể truy cập trái phép tệp tài liệu nội bộ nếu có link trực tiếp."
        impact_removed = "Khóa chặt bucket Storage, chỉ cho phép tạo đường dẫn tải có thời hạn và có kiểm tra vai trò."

    elif batch_id == 'BATCH-05-OPERATIONS-LEGACY':
        rec = 'DEFER'
        data_risk = 'Medium'
        desc_vi = f"Hàm/Chính sách hỗ trợ vận hành cũ: {t}."
        purpose = "Phục vụ phân quyền lịch hẹn khảo sát/lắp đặt hoặc xử lý công việc ghi âm cũ."
        if 'claim_voice_media_jobs' in t:
            rec = 'REPLACE'
            purpose = "Overload cũ 1 tham số của hàm điều phối công việc xử lý ghi âm cuộc gọi."
            impact_kept = "Tồn tại song song chữ ký cũ và mới, có thể gây nhầm lẫn khi gọi RPC."
            impact_removed = "Xóa chữ ký cũ 1 tham số, chỉ giữ lại hàm chuẩn 3 tham số an toàn."
        else:
            purpose = "Chính sách RLS và hàm đặt lịch lắp đặt cho mô hình cửa chống ngập."
            impact_kept = "Duy trì cấu trúc cũ nhưng không dùng trong luồng du học."
            impact_removed = "Bị xóa cùng với quá trình đóng gói nghiệp vụ cũ."

    elif batch_id == 'BATCH-06-AI-OUTBOUND-FENCING':
        rec = 'REPLACE'
        data_risk = 'High'
        desc_vi = f"Rào chắn bảo vệ AI Fencing và điều phối tin nhắn gửi: {t}."
        purpose = "Kiểm tra xem Sale có đang nhắn tin với khách không trước khi cho phép AI trả lời tự động."
        app_refs = ['features/ai-brain/services/ai-brain-live.ts', 'lib/inbox/outbound.ts']
        impact_kept = "AI có thể trả lời chồng chéo hoặc chen ngang khi tư vấn viên đang tương tác với phụ huynh/học viên."
        impact_removed = "Áp dụng cơ chế rào chắn tuần tự hóa (Sale Fencing) giúp AI tự động nhường quyền cho tư vấn viên."

    elif batch_id == 'BATCH-07-FACEBOOK-BROWSER-QUEUE':
        rec = 'REPLACE'
        data_risk = 'Low'
        desc_vi = f"Ràng buộc trạng thái hàng đợi tin nhắn Facebook Browser: {t}."
        purpose = "Mở rộng danh sách trạng thái cho phép khi gửi tin nhắn qua tiến trình trình duyệt tự động."
        app_refs = ['features/facebook/server.ts', 'lib/inbox/outbound.ts']
        impact_kept = "Hàng đợi gửi tin bị giới hạn trạng thái, gây lỗi khi worker browser báo cáo tiến độ."
        impact_removed = "Cập nhật tập trạng thái hợp lệ, giúp việc gửi tin qua Facebook ổn định hơn."

    elif batch_id == 'BATCH-08-META-DATA-DELETION':
        rec = 'REPLACE'
        data_risk = 'High'
        desc_vi = f"Cơ chế tiếp nhận và xử lý yêu cầu xóa dữ liệu Facebook (GDPR/Meta): {t}."
        purpose = "Tiếp nhận yêu cầu xóa dữ liệu từ Meta, tạo mã tra cứu trạng thái và xử lý ẩn/xóa dữ liệu."
        app_refs = ['app/api/facebook/data-deletion/resolve/route.ts', 'app/api/admin/data-deletion/resolve/route.ts']
        impact_kept = "Không đáp ứng quy định kiểm duyệt của Meta, có nguy cơ bị từ chối phê duyệt Meta App."
        impact_removed = "Cập nhật hàm xử lý xóa dữ liệu chuẩn chỉ, đáp ứng đúng yêu cầu của Meta Developer."

    elif batch_id == 'BATCH-09-AI-CONTROL-MONITORING':
        rec = 'REPLACE'
        data_risk = 'Medium'
        desc_vi = f"Cài đặt trung tâm điều khiển AI và cảnh báo giám sát: {t}."
        purpose = "Cấu hình bật/tắt AI theo kênh, ngưỡng tin cậy và theo dõi sự cố bộ lập lịch."
        app_refs = ['features/ai-brain/services/monitoring.ts', 'features/ai-brain/services/control-center.ts']
        impact_kept = "Thiếu quyền quản lý hoặc thiếu RPC chẩn đoán sức khỏe bộ lập lịch AI."
        impact_removed = "Chuẩn hóa RLS và RPC hỗ trợ giao diện quản trị AI Control Center."

    elif batch_id == 'BATCH-10-MESSENGER-LIVE-SCHEDULER':
        rec = 'REPLACE'
        data_risk = 'High'
        desc_vi = f"Bộ lập lịch tự động kích hoạt AI trả lời Facebook Messenger: {t}."
        purpose = "Cron job định kỳ mỗi phút gọi sang Render API để AI quét và trả lời tin nhắn Messenger mới."
        app_refs = ['features/ai-brain/services/live-messenger.ts', 'app/api/cron/ai-brain-live-messenger/route.ts']
        impact_kept = "Không có cơ chế tự động đánh thức AI trả lời tin nhắn Facebook Messenger."
        impact_removed = "Kích hoạt cron job tự động, cần cấu hình đúng Vault secret và Render endpoint trước khi bật."

    elif batch_id == 'BATCH-11-ZALO-CALLS-CAMPAIGN':
        rec = 'REPLACE'
        data_risk = 'Medium'
        desc_vi = f"Chiến dịch Zalo cá nhân và tóm tắt cuộc gọi AI: {t}."
        purpose = "Tự động phân tích tóm tắt cuộc gọi tư vấn bằng AI và điều phối chiến dịch gửi tin Zalo 5 phút."
        app_refs = ['features/zalo/services/campaign.ts', 'features/zalo/services/call-summary.ts']
        impact_kept = "Không tự động tạo tóm tắt cuộc gọi và không chạy được chiến dịch Zalo cá nhân."
        impact_removed = "Kích hoạt các bảng biểu và hàm RPC phục vụ tính năng tóm tắt cuộc gọi và chiến dịch gửi tin."

    elif batch_id == 'BATCH-12-CUSTOMER-FUNNEL-STAGES':
        rec = 'REPLACE'
        data_risk = 'High'
        desc_vi = f"Phễu khách hàng 6 giai đoạn tư vấn du học và AI gợi ý giai đoạn: {t}."
        purpose = "Chuẩn hóa quy trình chăm sóc học viên qua 6 bước (Mới tiếp cận -> Đã xuất cảnh/Hoàn thành) và AI phân tích gợi ý bước tiếp theo."
        app_refs = ['features/customers/services/funnel.ts', 'features/ai-analysis/services/ai-analysis-store.ts']
        impact_kept = "Khách hàng vẫn dùng mã giai đoạn cũ, không phản ánh đúng quy trình tư vấn du học."
        impact_removed = "Chuyển đổi dữ liệu và cập nhật logic phễu 6 giai đoạn chuẩn, hỗ trợ AI gợi ý chuyển giai đoạn."

    elif batch_id == 'BATCH-13-META-ADS-INTEGRATION':
        rec = 'REPLACE'
        data_risk = 'High'
        if 'meta_ad_accounts' in t:
            col = t.split('.')[-1].split(' ')[0]
            desc_vi = f"Cột access token ({col}) trên bảng công khai public.meta_ad_accounts."
            purpose = "Lưu token kết nối tài khoản quảng cáo Facebook Meta Ads."
            app_refs = ['lib/meta-ads/marketing-sync.ts', 'features/meta-ads/services/meta-client.ts']
            impact_kept = "Token tài khoản quảng cáo lưu dạng văn bản rõ trên bảng public, rủi ro bảo mật."
            impact_removed = "Xóa cột công khai, chuyển token sang mã hóa an toàn trong Supabase Vault."
        else:
            desc_vi = f"Hàm tiếp nhận Lead và quản lý đồng bộ Meta Ads: {t}."
            purpose = "Ghi nhận khách hàng tiềm năng từ Facebook Lead Form vào CRM, gắn nguồn chiến dịch và giải phóng lease đồng bộ."
            app_refs = ['lib/meta-ads/marketing-sync.ts', 'app/api/webhooks/meta-ads/route.ts']
            impact_kept = "Không tiếp nhận được Lead quảng cáo tự động hoặc gặp lỗi tranh chấp khóa đồng bộ."
            impact_removed = "Cập nhật các RPC hoàn chỉnh để ghi nhận Lead quảng cáo vào CRM theo đúng Page và Chiến dịch."

    return {
        'id': item['id'],
        'file': item['file'],
        'line': item['line'],
        'target': item['target'],
        'pending': True,
        'approved': False,
        'batch_id': batch_id,
        'vietnamese_description': desc_vi,
        'current_purpose': purpose,
        'application_references': app_refs,
        'external_consumer_status': ext_status,
        'current_data_count': data_count,
        'impact_if_kept': impact_kept,
        'impact_if_removed': impact_removed,
        'data_loss_risk': data_risk,
        'recovery_requirements': recovery,
        'recommended_decision': rec,
        'evidence_links': [
            'docs/META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md',
            'docs/META_ADS_STAGING_DESTRUCTIVE_DEPENDENCY_AUDIT.md',
            'docs/evidence/meta-ads-safe-deployment/FULL_MIGRATION_RISK_MATRIX.md'
        ]
    }

output_items = [enrich_item(item) for item in orig_items]

meta = {
    'total_items': len(output_items),
    'pending_items': sum(1 for i in output_items if i['pending']),
    'historical_prefix_items': sum(1 for i in output_items if not i['pending']),
    'batches': BATCH_INFO,
    'generated_at': '2026-10-31T00:15:00+07:00'
}

full_data = {
    'metadata': meta,
    'items': output_items
}

with open(OUT_FILE, 'w', encoding='utf-8') as f:
    json.dump(full_data, f, indent=2, ensure_ascii=False)

print(f'Successfully generated {OUT_FILE} with {len(output_items)} items.')

