'use server';

import { randomBytes } from 'node:crypto';
import { createAdminClient } from '../../lib/supabase/admin';
import { recordingActor, authorizedRecording } from '../../features/zalo-recordings/access';
import { RecordingError, sha256, UUID } from '../../features/zalo-recordings/metadata';
import { RECORDING_BUCKET } from '../../features/zalo-recordings/upload';

export async function listZaloCalls(page = 1, customerId?: string) {
  const actor=await recordingActor();
  if(!Number.isInteger(page) || page<1 || page>10000 || (customerId && !UUID.test(customerId))) throw new RecordingError('INVALID_FILTER');
  let query=createAdminClient().from('zalo_personal_calls')
    .select('id,customer_id,remote_display_name,direction,started_at,duration_seconds,recording_status,matching_status,identity_ambiguous,customers(name,customer_code)',{count:'exact'})
    .eq('company_id',actor.companyId).eq('recording_status','READY').order('started_at',{ascending:false}).range((page-1)*20,page*20-1);
  if(actor.role==='SALE') query=query.eq('staff_user_id',actor.userId);
  if(customerId) query=query.eq('customer_id',customerId);
  const {data,error,count}=await query;
  if(error) throw new RecordingError('Không thể tải cuộc gọi Zalo. Kiểm tra migration và kết nối.',503);
  return {items:data || [],total:count || 0,page};
}
export async function searchZaloCustomers(callId: string, search: string | null = null) {
  const {actor}=await authorizedRecording(callId);
  if(search!==null && (typeof search!=='string' || search.length>200)) throw new RecordingError('INVALID_SEARCH');
  const {data,error}=await createAdminClient().rpc('zalo_search_customers',{p_company:actor.companyId,p_actor:actor.userId,p_call:callId,p_search:search});
  if(error) throw new RecordingError('Không thể tìm khách hàng.',503);
  return data as {id:string;name:string;customer_code:string}[];
}
export async function linkZaloCustomer(callId: string, customerId: string | null, remember: boolean, newName: string | null = null) {
  const {actor}=await authorizedRecording(callId);
  if(typeof remember!=='boolean' || (customerId!==null && !UUID.test(customerId)) || (newName!==null && (typeof newName!=='string' || !newName.trim() || newName.length>200)) || (customerId===null)===(newName===null)) throw new RecordingError('INVALID_CUSTOMER');
  const {data,error}=await createAdminClient().rpc('zalo_link_customer',{p_company:actor.companyId,p_actor:actor.userId,p_call:callId,p_customer:customerId,p_new_name:newName,p_remember:remember});
  if(error) throw new RecordingError('Không thể xác nhận khách hàng. Vui lòng tải lại và thử lại.',503);
  return data as {customer_id:string;ambiguous?:boolean};
}
export async function playZaloRecording(callId: string) {
  const {actor,call}=await authorizedRecording(callId);
  if(call.recording_status!=='READY') throw new RecordingError('RECORDING_NOT_READY',409);
  const admin=createAdminClient();
  const {error:auditError}=await admin.from('audit_logs').insert({company_id:actor.companyId,user_id:actor.userId,action:'ZALO_RECORDING_PLAY',resource_type:'ZALO_CALL',resource_id:call.id,customer_id:call.customer_id,result:'SUCCESS',metadata:{}});
  if(auditError) throw new RecordingError('AUDIT_UNAVAILABLE',503);
  const {data,error}=await admin.storage.from(RECORDING_BUCKET).createSignedUrl(call.recording_path,60);
  if(error || !data?.signedUrl) throw new RecordingError('RECORDING_UNAVAILABLE',503);
  return data.signedUrl;
}
export async function listZaloDevices() {
  const actor=await recordingActor(true),admin=createAdminClient();
  const [{data,error},{data:staff,error:staffError}]=await Promise.all([
    admin.from('zalo_recording_devices').select('id,device_name,staff_user_id,active,last_seen_at,created_at').eq('company_id',actor.companyId).order('created_at',{ascending:false}),
    admin.from('company_members').select('user_id,role,user_profiles(full_name)').eq('company_id',actor.companyId).eq('status','ACTIVE').in('role',['SALE','BOSS_ADMIN'])
  ]);
  if(error || staffError) throw new RecordingError('Không thể tải thiết bị Zalo.',503);
  return {devices:data || [],staff:staff || []};
}
export async function registerZaloDevice(deviceId: string, name: string, staffId: string | null) {
  const actor=await recordingActor(true);
  if(!UUID.test(deviceId) || typeof name!=='string' || !name.trim() || name.length>100 || (staffId!==null && !UUID.test(staffId))) throw new RecordingError('INVALID_DEVICE');
  const secret=randomBytes(32).toString('base64url');
  const {error}=await createAdminClient().rpc('zalo_manage_device',{p_company:actor.companyId,p_actor:actor.userId,p_device:deviceId.toLowerCase(),p_name:name.trim(),p_hash:sha256(secret),p_staff:staffId,p_revoke:false});
  if(error) throw new RecordingError('Không thể đăng ký. Device ID phải mới và nhân viên phải đang hoạt động trong tổ chức.',409);
  return {device_id:deviceId,secret};
}
export async function revokeZaloDevice(deviceId: string) {
  const actor=await recordingActor(true);
  if(!UUID.test(deviceId)) throw new RecordingError('INVALID_DEVICE');
  const {error}=await createAdminClient().rpc('zalo_manage_device',{p_company:actor.companyId,p_actor:actor.userId,p_device:deviceId,p_name:'',p_hash:'',p_staff:null,p_revoke:true});
  if(error) throw new RecordingError('Không thể thu hồi thiết bị.',503);
}

export async function createZaloOutboundCall(customerId: string, deviceId?: string) {
  const actor = await recordingActor();
  if (!UUID.test(customerId) || (deviceId && !UUID.test(deviceId))) throw new RecordingError('INVALID_REQUEST');
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('zalo_create_outbound_call_request', {
    p_company: actor.companyId,
    p_actor: actor.userId,
    p_customer: customerId,
    p_device: deviceId || null,
  });
  if (error || !data) throw new RecordingError('Không thể tạo yêu cầu cuộc gọi Zalo.', 503);
  return data as {
    request_id: string;
    customer_id: string;
    customer_name: string;
    phone: string | null;
    expected_display_name: string;
    expires_at: string;
  };
}

export async function getZaloOutboundCallStatus(requestId: string) {
  const actor = await recordingActor();
  if (!UUID.test(requestId)) throw new RecordingError('INVALID_REQUEST');
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('zalo_outbound_call_requests')
    .select('id, status, failure_reason, expected_display_name, phone_normalized, created_at, claimed_at, completed_at')
    .eq('company_id', actor.companyId)
    .eq('id', requestId)
    .maybeSingle();
  if (error || !data) throw new RecordingError('NOT_FOUND', 404);
  return data;
}

