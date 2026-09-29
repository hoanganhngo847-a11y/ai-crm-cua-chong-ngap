import 'server-only';
import { AuthError } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import { operationsRpc, OperationsError, type OperationsClient, type OperationsActor } from '../operations/server';
import { isValidCanonicalInstallationStorageRef } from './evidence';
import type { AttachInstallationEvidenceInput, CompleteInstallationInput, InstallationDTO, InstallationStatus, ScheduleInstallationInput, SettableInstallationStatus } from './types';
export { isValidCanonicalInstallationStorageRef } from './evidence';

export const VALID_INSTALLATION_TRANSITIONS: Record<InstallationStatus, SettableInstallationStatus[]> = {
 SCHEDULED:['IN_TRANSIT','INSTALLING','FAILED'], IN_TRANSIT:['INSTALLING','FAILED'],
 INSTALLING:['TESTING','HANDOVER_PENDING','FAILED'], TESTING:['HANDOVER_PENDING','INSTALLING','FAILED'],
 HANDOVER_PENDING:['TESTING','INSTALLING','FAILED'], FAILED:['SCHEDULED','IN_TRANSIT','INSTALLING'], COMPLETED:[],
};
export async function verifyStorageObjectExists(admin: OperationsClient, bucket: string, path: string): Promise<boolean> {
 try {
  const { data, error } = await admin.storage.from(bucket).info(path);
  return !error && !!data;
 } catch { return false; }
}
export async function verifyTechnicianInstallationAssignment(companyId: string,userId: string,installationId: string,overrideAdminClient?: OperationsClient): Promise<void> {
 const admin = overrideAdminClient || createAdminClient();
 const {data:i,error} = await admin.from('installations').select('appointment_id').eq('company_id',companyId).eq('id',installationId).maybeSingle();
 if(error || !i) throw new OperationsError('RESOURCE_NOT_FOUND');
 const {data:a,error:ae} = await admin.from('appointments').select('assignee_id,status').eq('company_id',companyId).eq('id',i.appointment_id).maybeSingle();
 if(ae || !a || a.assignee_id !== userId || !['ASSIGNED','ACCEPTED','IN_PROGRESS'].includes(a.status)) throw new AuthError('Bạn không được phân công thực hiện công việc này',403);
}
export async function scheduleInstallation(companyId: string,input: ScheduleInstallationInput,overrideAdminClient?: OperationsClient,actorId?: string): Promise<InstallationDTO> {
 const i = await operationsRpc(overrideAdminClient || createAdminClient(),'schedule_installation_atomic',{p_company_id:companyId,p_order_id:input.orderId,p_customer_id:input.customerId,p_appointment_id:input.appointmentId,p_crew:input.crew,p_actor_id:actorId});
 return {id:i.id,companyId:i.company_id,customerId:i.customer_id,orderId:i.order_id,appointmentId:i.appointment_id,crew:i.crew,status:i.status,photos:i.photos,handoverRef:i.handover_ref,completedAt:i.completed_at,createdAt:i.created_at,updatedAt:i.updated_at};
}
export async function updateInstallationStatus(companyId: string,installationId: string,status: SettableInstallationStatus,overrideAdminClient?: OperationsClient,actor?: OperationsActor): Promise<void> {
 await operationsRpc(overrideAdminClient || createAdminClient(),'mutate_installation_atomic',{p_company_id:companyId,p_installation_id:installationId,p_actor_id:actor?.userId,p_status:status});
}
/** Internal server helper. Only the upload action supplies newly generated typed paths. */
export async function attachInstallationEvidence(companyId: string,input: AttachInstallationEvidenceInput,overrideAdminClient?: OperationsClient,actor?: OperationsActor): Promise<void> {
 const admin=overrideAdminClient || createAdminClient();
 const type=input.type.toLowerCase();
 if (!['photo','handover'].includes(type) || !isValidCanonicalInstallationStorageRef(companyId,input.installationId,input.fileKey,type)) throw new OperationsError('INVALID_STORAGE_REF');
 if (!await verifyStorageObjectExists(admin,'installation-docs',input.fileKey)) throw new OperationsError('STORAGE_OBJECT_NOT_FOUND');
 await operationsRpc(admin,'mutate_installation_atomic',{p_company_id:companyId,p_installation_id:input.installationId,p_actor_id:actor?.userId,p_ref:input.fileKey,p_type:type});
}
export async function completeInstallationAndHandover(companyId: string,input: CompleteInstallationInput,overrideAdminClient?: OperationsClient,actor?: OperationsActor): Promise<void> {
 const admin=overrideAdminClient || createAdminClient();
 const {data:i,error} = await admin.from('installations').select('status,photos,handover_ref').eq('company_id',companyId).eq('id',input.installationId).maybeSingle();
 if(error || !i) throw new OperationsError('RESOURCE_NOT_FOUND');
 // Completed retries still go to the RPC for authorization and consistent idempotency.
 if(i.status !== 'COMPLETED') {
  if(!Array.isArray(i.photos) || !i.photos.length || !i.handover_ref) throw new OperationsError('MISSING_EVIDENCE');
  for(const [ref,type] of [...i.photos.map((ref: string) => [ref,'photo']),[i.handover_ref,'handover']]) {
   if(!isValidCanonicalInstallationStorageRef(companyId,input.installationId,ref,type)) throw new OperationsError('INVALID_STORAGE_REF');
   if(!await verifyStorageObjectExists(admin,'installation-docs',ref)) throw new OperationsError('STORAGE_OBJECT_NOT_FOUND');
  }
 }
 await operationsRpc(admin,'complete_installation_atomic',{p_company_id:companyId,p_installation_id:input.installationId,p_actor_id:actor?.userId,p_verified_photos:i.photos,p_verified_handover:i.handover_ref});
}
