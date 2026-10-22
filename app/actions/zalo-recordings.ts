'use server';

import { randomBytes } from 'node:crypto';
import { createAdminClient } from '../../lib/supabase/admin';
import { recordingActor, authorizedRecording } from '../../features/zalo-recordings/access';
import { RecordingError, sha256, UUID } from '../../features/zalo-recordings/metadata';
import { RECORDING_BUCKET } from '../../features/zalo-recordings/upload';
import { retryZaloTranscriptionJob } from '../../features/zalo-transcription/service';
import { retryZaloCallSummary as retrySummaryService } from '../../features/zalo-summary/service';

export async function listZaloCalls(page = 1, customerId?: string) {
  const actor=await recordingActor();
  if(!Number.isInteger(page) || page<1 || page>10000 || (customerId && !UUID.test(customerId))) throw new RecordingError('INVALID_FILTER');
  let query=createAdminClient().from('zalo_personal_calls')
    .select('id,customer_id,remote_display_name,direction,started_at,duration_seconds,recording_status,transcript_status,summary_status,matching_status,identity_ambiguous,customers(name,customer_code)',{count:'exact'})
    .eq('company_id',actor.companyId).eq('recording_status','READY').order('started_at',{ascending:false}).range((page-1)*20,page*20-1);
  if(actor.role==='SALE') query=query.eq('staff_user_id',actor.userId);
  if(customerId) query=query.eq('customer_id',customerId);
  const {data,error,count}=await query;
  if(error) throw new RecordingError('Không thể tải cuộc gọi Zalo. Kiểm tra migration và kết nối.',503);
  return {items:data || [],total:count || 0,page};
}
export async function getZaloTranscription(callId: string) {
  const { actor, call } = await authorizedRecording(callId);
  const admin = createAdminClient();
  const { data: transcription, error: txError } = await admin
    .from('zalo_call_transcriptions')
    .select('id,company_id,call_id,customer_id,status,provider,language,raw_channel_layout,channels_silent,started_at,completed_at,error_code,full_transcript,created_at')
    .eq('company_id', actor.companyId)
    .eq('call_id', call.id)
    .maybeSingle();

  if (txError) throw new RecordingError('Không thể tải trạng thái bóc băng.', 503);
  if (!transcription) {
    return {
      status: (call as { transcript_status?: string }).transcript_status || 'NOT_STARTED',
      utterances: [],
      full_transcript: null,
    };
  }

  let utterances: Array<{
    id: string;
    sequence: number;
    speaker_role: 'STAFF' | 'CUSTOMER';
    channel: 'LEFT' | 'RIGHT';
    start_ms: number;
    end_ms: number;
    text: string;
    confidence: number | null;
  }> = [];

  if (transcription.status === 'COMPLETED') {
    const { data: utts, error: uttsError } = await admin
      .from('zalo_call_transcript_utterances')
      .select('id,sequence,speaker_role,channel,start_ms,end_ms,text,confidence')
      .eq('transcription_id', transcription.id)
      .eq('company_id', actor.companyId)
      .order('sequence', { ascending: true });

    if (uttsError) throw new RecordingError('Không thể tải nội dung bóc băng.', 503);
    utterances = (utts || []) as typeof utterances;

    await admin.from('audit_logs').insert({
      company_id: actor.companyId,
      user_id: actor.userId,
      action: 'ZALO_TRANSCRIPTION_VIEW',
      resource_type: 'ZALO_CALL',
      resource_id: call.id,
      customer_id: call.customer_id,
      result: 'SUCCESS',
      metadata: { transcription_id: transcription.id },
    });
  }

  return {
    ...transcription,
    utterances,
  };
}
export async function retryZaloTranscription(callId: string) {
  const { actor, call } = await authorizedRecording(callId);
  const admin = createAdminClient();
  try {
    const result = await retryZaloTranscriptionJob(actor.companyId, actor.userId, call.id, admin);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể thử lại bóc băng.';
    throw new RecordingError(msg, 500);
  }
}
export async function getZaloCallSummary(callId: string) {
  const { actor, call } = await authorizedRecording(callId);
  const admin = createAdminClient();
  const { data: summary, error: sumError } = await admin
    .from('zalo_call_ai_summaries')
    .select('id,company_id,call_id,transcription_id,status,provider,model,prompt_version,summary,customer_needs,objections,next_actions,key_points,lead_temperature,follow_up_required,follow_up_suggested_time,follow_up_reason,confidence,created_at,completed_at,error_code')
    .eq('company_id', actor.companyId)
    .eq('call_id', call.id)
    .maybeSingle();

  if (sumError) throw new RecordingError('Không thể tải tóm tắt AI.', 503);
  if (!summary) {
    return {
      status: (call as { summary_status?: string }).summary_status || 'NOT_STARTED',
      summary: null,
      customer_needs: [],
      objections: [],
      next_actions: [],
      key_points: [],
      lead_temperature: null,
      follow_up_required: false,
      follow_up_suggested_time: null,
      follow_up_reason: null,
      confidence: null,
    };
  }

  if (summary.status === 'COMPLETED') {
    await admin.from('audit_logs').insert({
      company_id: actor.companyId,
      user_id: actor.userId,
      action: 'ZALO_CALL_SUMMARY_VIEW',
      resource_type: 'ZALO_CALL',
      resource_id: call.id,
      customer_id: call.customer_id,
      result: 'SUCCESS',
      metadata: { summary_id: summary.id },
    });
  }

  return {
    ...summary,
    // Failsafe: never leak internal error codes/messages to client
    error_code: summary.status === 'FAILED' ? 'SUMMARY_FAILED' : null,
  };
}
export async function retryZaloCallSummaryAction(callId: string) {
  const { actor, call } = await authorizedRecording(callId);
  const admin = createAdminClient();
  const { data: summary, error: lookupErr } = await admin
    .from('zalo_call_ai_summaries')
    .select('id')
    .eq('company_id', actor.companyId)
    .eq('call_id', call.id)
    .maybeSingle();

  if (lookupErr || !summary) {
    throw new RecordingError('Không tìm thấy tóm tắt để thử lại.', 404);
  }

  try {
    const success = await retrySummaryService(actor.companyId, actor.userId, summary.id, admin);
    return { ok: success };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Không thể thử lại tóm tắt AI.';
    throw new RecordingError(msg, 500);
  }
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
  const actor = await recordingActor(true), admin = createAdminClient();
  const [{ data, error }, { data: staff, error: staffError }] = await Promise.all([
    admin.from('zalo_recording_devices')
      .select('id,device_name,staff_user_id,active,last_seen_at,created_at,agent_version,agent_status,zalo_running,permissions_ok,permissions_detail,loopback_ready,last_error_code,last_error_at')
      .eq('company_id', actor.companyId)
      .order('created_at', { ascending: false }),
    admin.from('company_members')
      .select('user_id,role,user_profiles(full_name)')
      .eq('company_id', actor.companyId)
      .eq('status', 'ACTIVE')
      .in('role', ['SALE', 'BOSS_ADMIN'])
  ]);
  if (error || staffError) throw new RecordingError('Không thể tải thiết bị Zalo.', 503);

  const now = Date.now();
  const twoMinutesMs = 2 * 60 * 1000;

  const devices = (data || []).map((device) => {
    const lastSeenTime = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
    const isRecent = now - lastSeenTime <= twoMinutesMs;
    let effective_status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' = 'OFFLINE';

    if (!device.active) {
      effective_status = 'OFFLINE';
    } else if (!isRecent) {
      effective_status = 'OFFLINE';
    } else if (!device.permissions_ok || !device.loopback_ready || device.agent_status === 'DEGRADED') {
      effective_status = 'DEGRADED';
    } else {
      effective_status = 'ONLINE';
    }

    return {
      ...device,
      effective_status,
    };
  });

  return { devices, staff: staff || [] };
}

export async function getZaloDeviceReadiness() {
  const actor = await recordingActor();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('zalo_get_devices_readiness', {
    p_company: actor.companyId,
    p_actor: actor.userId,
  });
  if (error || !data) throw new RecordingError('Không thể kiểm tra trạng thái thiết bị Zalo.', 503);

  const devices = (data.devices || []) as Array<{
    id: string;
    device_name: string;
    staff_user_id: string | null;
    is_current_staff: boolean;
    active: boolean;
    agent_version: string | null;
    raw_status: string | null;
    computed_status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
    zalo_running: boolean;
    permissions_ok: boolean;
    permissions_detail: Record<string, boolean>;
    loopback_ready: boolean;
    last_error_code: string | null;
    last_error_at: string | null;
    last_seen_at: string | null;
    created_at: string;
  }>;

  if (devices.length === 0) {
    return {
      isReady: false,
      status: 'NO_DEVICE' as const,
      reason: 'Chưa đăng ký thiết bị Mac Zalo cho tổ chức.',
      devices: [],
      readyDevice: null,
      zaloRunning: false,
    };
  }

  // Multi-device selection:
  // 1. Look for device assigned to current staff that is ONLINE
  const assignedOnline = devices.find((d) => d.is_current_staff && d.computed_status === 'ONLINE');
  // 2. Or any ONLINE device
  const anyOnline = devices.find((d) => d.computed_status === 'ONLINE');
  // 3. Or assigned DEGRADED device
  const assignedDegraded = devices.find((d) => d.is_current_staff && d.computed_status === 'DEGRADED');
  // 4. Or any DEGRADED device
  const anyDegraded = devices.find((d) => d.computed_status === 'DEGRADED');

  const selectedDevice = assignedOnline || anyOnline || assignedDegraded || anyDegraded || devices[0];
  const status = selectedDevice.computed_status;
  const isReady = status === 'ONLINE';

  let reason = '';
  if (!isReady) {
    if (status === 'OFFLINE') {
      reason = 'Zalo Agent đang offline trên máy Mac.';
    } else if (status === 'DEGRADED') {
      const perms = selectedDevice.permissions_detail || {};
      if (perms.accessibility === false) {
        reason = 'Thiếu quyền Accessibility trên máy Mac.';
      } else if (perms.microphone === false || perms.screen_recording === false) {
        reason = 'Thiếu quyền ghi âm màn hình / microphone.';
      } else if (!selectedDevice.loopback_ready) {
        reason = 'Loopback agent (127.0.0.1:48123) chưa sẵn sàng.';
      } else {
        reason = selectedDevice.last_error_code || 'Agent đang chạy nhưng chưa sẵn sàng.';
      }
    }
  }

  return {
    isReady,
    status,
    reason,
    devices,
    readyDevice: selectedDevice,
    zaloRunning: Boolean(selectedDevice.zalo_running),
  };
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
  const raw = data as Record<string, unknown>;
  return {
    request_id: String(raw.request_id),
    customer_id: String(raw.customer_id),
    customer_name: String(raw.customer_name ?? ''),
    expected_display_name: String(raw.expected_display_name ?? ''),
    expires_at: String(raw.expires_at),
  };
}

export async function getZaloOutboundCallStatus(requestId: string) {
  const actor = await recordingActor();
  if (!UUID.test(requestId)) throw new RecordingError('INVALID_REQUEST');
  const admin = createAdminClient();
  let query = admin
    .from('zalo_outbound_call_requests')
    .select('id, customer_id, staff_user_id, status, failure_reason, expected_display_name, created_at, claimed_at, completed_at')
    .eq('company_id', actor.companyId)
    .eq('id', requestId);

  if (actor.role === 'SALE') {
    query = query.eq('staff_user_id', actor.userId);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new RecordingError('NOT_FOUND', 404);
  return {
    id: data.id as string,
    customer_id: data.customer_id as string,
    status: data.status as string,
    failure_reason: data.failure_reason as string | null,
    expected_display_name: data.expected_display_name as string | null,
    created_at: data.created_at as string,
    claimed_at: data.claimed_at as string | null,
    completed_at: data.completed_at as string | null,
  };
}

