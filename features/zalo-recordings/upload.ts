import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { MAX_RECORDING_BYTES, RecordingError, sha256, UUID, validateM4a, validateMetadata } from './metadata';

export const RECORDING_BUCKET = 'zalo-call-recordings';
export async function uploadRecording(request: Request, admin: SupabaseClient) {
  const device = request.headers.get('x-zalo-device-id') || '';
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
  if (!UUID.test(device) || !token) throw new RecordingError('DEVICE_UNAUTHORIZED',401);
  const hash=sha256(token);
  const {data:registered,error:deviceError}=await admin.from('zalo_recording_devices').select('device_key_hash,active').eq('id',device).maybeSingle();
  if (deviceError) throw new RecordingError('DEVICE_AUTH_UNAVAILABLE',503);
  if (!registered?.active || typeof registered.device_key_hash!=='string' || registered.device_key_hash.length!==64 || !timingSafeEqual(Buffer.from(hash),Buffer.from(registered.device_key_hash))) throw new RecordingError('DEVICE_UNAUTHORIZED',401);
  const contentType=request.headers.get('content-type') || '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new RecordingError('MULTIPART_REQUIRED',415);
  const max=MAX_RECORDING_BYTES+64*1024;
  if (Number(request.headers.get('content-length'))>max) throw new RecordingError('RECORDING_TOO_LARGE',413);
  if (!request.body) throw new RecordingError('EMPTY_BODY');
  const reader=request.body.getReader(), chunks:Uint8Array[]=[];let length=0;
  try {
    while(true) { const {value,done}=await reader.read();if(done) break;length+=value.byteLength;
      if(length>max) { await reader.cancel();throw new RecordingError('RECORDING_TOO_LARGE',413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let form:FormData;
  try { form=await new Request('http://localhost/',{method:'POST',headers:{'content-type':contentType},body:Buffer.concat(chunks)}).formData(); }
  catch { throw new RecordingError('INVALID_MULTIPART'); }
  if (Array.from(form.keys()).length!==2 || form.getAll('metadata').length!==1 || form.getAll('recording').length!==1) throw new RecordingError('INVALID_MULTIPART_FIELDS');
  const raw=form.get('metadata'), file=form.get('recording');
  if(typeof raw!=='string' || raw.length>16*1024 || !(file instanceof File) || !['audio/mp4','audio/x-m4a'].includes(file.type) || !file.name.endsWith('.m4a')) throw new RecordingError('INVALID_RECORDING',415);
  if(file.size<32 || file.size>MAX_RECORDING_BYTES) throw new RecordingError('RECORDING_TOO_LARGE',413);
  let parsed:unknown;try {parsed=JSON.parse(raw);} catch {throw new RecordingError('INVALID_METADATA');}
  const metadata=validateMetadata(parsed,device.toLowerCase());
  const bytes=Buffer.from(await file.arrayBuffer());validateM4a(bytes,metadata.duration_seconds);
  const checksum=sha256(bytes), fingerprint=sha256(JSON.stringify(metadata));
  const {data:reserved,error:reserveError}=await admin.rpc('zalo_reserve_recording',{p_device:device,p_key_hash:hash,p_metadata:metadata,p_checksum:checksum,p_bytes:bytes.length,p_fingerprint:fingerprint});
  if(reserveError) {
    if(reserveError.code==='42501') throw new RecordingError('DEVICE_UNAUTHORIZED',401);
    if(reserveError.message?.includes('IDEMPOTENCY_CONFLICT')) throw new RecordingError('IDEMPOTENCY_CONFLICT',409);
    if(reserveError.message?.includes('ZALO_REQUEST_EXPIRED')) throw new RecordingError('REQUEST_EXPIRED',410);
    if(reserveError.message?.includes('ZALO_REQUEST_REUSED')) throw new RecordingError('REQUEST_REUSED',409);
    if(reserveError.message?.includes('ZALO_REQUEST_NOT_FOUND')) throw new RecordingError('REQUEST_NOT_FOUND',404);
    if(reserveError.message?.includes('ZALO_REQUEST_DEVICE_MISMATCH') || reserveError.message?.includes('ZALO_REQUEST_STAFF_MISMATCH')) throw new RecordingError('REQUEST_MISMATCH',403);
    if(reserveError.message?.includes('ZALO_REQUEST_DIRECTION_MISMATCH') || reserveError.message?.includes('ZALO_REQUEST_UNCLAIMED') || reserveError.message?.includes('ZALO_REQUEST_FAILED') || reserveError.message?.includes('ZALO_REQUEST_INVALID_STATE') || reserveError.message?.includes('ZALO_REQUEST_INVALID') || reserveError.message?.includes('ZALO_REQUEST_TIMING_INVALID')) throw new RecordingError('INVALID_REQUEST_ASSOCIATION',400);
    throw new RecordingError('RESERVATION_UNAVAILABLE',503);
  }
  if(!reserved) throw new RecordingError('RESERVATION_UNAVAILABLE',503);
  if(reserved.duplicate) return {ok:true,duplicate:true,call_id:reserved.call_id,recording_id:reserved.recording_id};
  if(reserved.in_progress) throw new RecordingError('UPLOAD_IN_PROGRESS',409);
  const bucket=admin.storage.from(RECORDING_BUCKET);
  const {error:uploadError}=await bucket.upload(reserved.path,bytes,{contentType:'audio/mp4',upsert:false,metadata:{sha256:checksum}});
  if(uploadError) {
    // An interrupted worker may already have stored the immutable object. Verify the bytes before reuse.
    const {data:existing,error:readError}=await bucket.download(reserved.path);
    if(readError || !existing || existing.size!==bytes.length || sha256(Buffer.from(await existing.arrayBuffer()))!==checksum) throw new RecordingError('STORAGE_UNAVAILABLE',503);
  }
  const {data:finished,error:finishError}=await admin.rpc('zalo_finish_recording',{p_device:device,p_key_hash:hash,p_call:reserved.call_id,p_lease:reserved.lease});
  if(finishError || !finished) {
    if(finishError?.code==='42501') throw new RecordingError('DEVICE_UNAUTHORIZED',401);
    if(finishError?.message?.includes('ZALO_REQUEST_')) throw new RecordingError('INVALID_REQUEST_ASSOCIATION',400);
    throw new RecordingError('FINALIZATION_UNAVAILABLE',503);
  }
  return {ok:true,duplicate:!!finished.duplicate,call_id:finished.call_id,recording_id:finished.recording_id};
}
