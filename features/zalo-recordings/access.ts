import 'server-only';
import { getActorContext } from '../../lib/auth/context';
import { verifyActorForCompany } from '../../lib/server-auth/authorize';
import { createAdminClient } from '../../lib/supabase/admin';
import { RecordingError, UUID } from './metadata';

export async function recordingActor(bossOnly = false) {
  const context = await getActorContext();
  if (!context?.companyId) throw new RecordingError('UNAUTHORIZED',401);
  return verifyActorForCompany(context.companyId,{allowedRoles:bossOnly?['BOSS_ADMIN']:['BOSS_ADMIN','SALE']});
}
export async function authorizedRecording(id: string) {
  if (!UUID.test(id)) throw new RecordingError('NOT_FOUND',404);
  const actor=await recordingActor();
  let query=createAdminClient().from('zalo_personal_calls').select('id,company_id,staff_user_id,customer_id,recording_status,recording_path').eq('id',id).eq('company_id',actor.companyId);
  if(actor.role==='SALE') query=query.eq('staff_user_id',actor.userId);
  const {data,error}=await query.maybeSingle();
  if(error || !data) throw new RecordingError('NOT_FOUND',404);
  return {actor,call:data};
}
