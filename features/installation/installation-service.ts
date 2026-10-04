import 'server-only';
import { AuthError } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import { operationsRpc, OperationsError, type OperationsClient, type OperationsActor } from '../operations/server';
import { isValidCanonicalInstallationStorageRef } from './evidence';
import type {
  AttachInstallationEvidenceInput,
  CompleteInstallationInput,
  CreateInstallationScheduleInput,
  CreateInstallationScheduleResult,
  InstallationDTO,
  InstallationStatus,
  ScheduleInstallationInput,
  SettableInstallationStatus,
} from './types';
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

export async function createInstallationSchedule(
  companyId: string,
  input: CreateInstallationScheduleInput,
  overrideAdminClient?: OperationsClient,
  actorId?: string
): Promise<CreateInstallationScheduleResult> {
  const result = await operationsRpc(
    overrideAdminClient || createAdminClient(),
    'create_installation_schedule_atomic',
    {
      p_company_id: companyId,
      p_order_id: input.orderId,
      p_actor_id: actorId,
      p_technician_id: input.technicianId,
      p_start_time: input.startTime,
      p_address: input.address,
      p_crew: input.crew,
    }
  );

  const i = result.installation;
  const a = result.appointment;

  return {
    idempotent: Boolean(result.idempotent),
    installation: {
      id: i.id,
      companyId: i.company_id,
      customerId: i.customer_id,
      orderId: i.order_id,
      appointmentId: i.appointment_id,
      crew: i.crew,
      status: i.status,
      photos: i.photos,
      handoverRef: i.handover_ref,
      completedAt: i.completed_at,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    },
    appointment: {
      id: a.id,
      companyId: a.company_id,
      customerId: a.customer_id,
      type: a.type,
      startTime: a.start_time,
      assigneeId: a.assignee_id,
      address: a.address,
      status: a.status,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    },
  };
}

export async function acceptInstallationAppointment(
  companyId: string,
  appointmentId: string,
  overrideAdminClient?: OperationsClient,
  actor?: OperationsActor
): Promise<{ success: boolean; idempotent: boolean }> {
  const result = await operationsRpc(
    overrideAdminClient || createAdminClient(),
    'accept_installation_appointment_atomic',
    {
      p_company_id: companyId,
      p_appointment_id: appointmentId,
      p_actor_id: actor?.userId,
    }
  );
  return { success: true, idempotent: Boolean(result?.idempotent) };
}

export async function startInstallationWork(
  companyId: string,
  installationId: string,
  overrideAdminClient?: OperationsClient,
  actor?: OperationsActor
): Promise<{ success: boolean; idempotent: boolean }> {
  const result = await operationsRpc(
    overrideAdminClient || createAdminClient(),
    'start_installation_work_atomic',
    {
      p_company_id: companyId,
      p_installation_id: installationId,
      p_actor_id: actor?.userId,
    }
  );
  return { success: true, idempotent: Boolean(result?.idempotent) };
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

export interface FieldSurveyItem {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  address: string;
  startTime: string;
  status: string;
}

export interface FieldInstallationItem {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  orderId: string;
  orderCode: string;
  orderStatus: string;
  appointmentId: string;
  address: string;
  startTime: string;
  status: InstallationStatus;
  appointmentStatus: string;
  photos: string[];
  handoverRef: string | null;
  completedAt: string | null;
  crew: string[];
}

export interface FieldWorkspaceData {
  surveys: FieldSurveyItem[];
  installations: FieldInstallationItem[];
  role: string;
  userId: string;
}

export async function getTechnicianFieldWorkspaceData(
  companyId: string,
  userId: string,
  role: string,
  overrideAdminClient?: OperationsClient
): Promise<FieldWorkspaceData> {
  const admin = overrideAdminClient || createAdminClient();

  // 1. Fetch survey appointments
  let surveyQuery = admin
    .from('appointments')
    .select(`
      id,
      customer_id,
      address,
      start_time,
      status,
      customers (
        name,
        customer_code
      )
    `)
    .eq('company_id', companyId)
    .eq('type', 'SURVEY')
    .order('start_time', { ascending: false });

  if (role === 'TECHNICIAN') {
    // Canonical current assignment rule: strictly active work states only.
    // Historical work (COMPLETED, CANCELLED, REJECTED) must never appear.
    surveyQuery = surveyQuery
      .eq('assignee_id', userId)
      .in('status', ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS']);
  }

  const { data: rawSurveys, error: surveyError } = await surveyQuery;
  if (surveyError) throw new OperationsError('FETCH_FAILED');

  const surveys: FieldSurveyItem[] = (rawSurveys || []).map((s: Record<string, unknown>) => {
    const cust = s.customers as { name?: string; customer_code?: string } | null;
    return {
      id: String(s.id),
      customerId: String(s.customer_id),
      customerName: cust?.name || 'Khách hàng',
      customerCode: cust?.customer_code || '',
      address: String(s.address || ''),
      startTime: String(s.start_time || ''),
      status: String(s.status || ''),
    };
  });

  // 2. Fetch installations
  let installQuery = admin
    .from('installations')
    .select(`
      id,
      customer_id,
      order_id,
      appointment_id,
      crew,
      status,
      photos,
      handover_ref,
      completed_at,
      appointments!inner (
        id,
        assignee_id,
        address,
        start_time,
        status
      ),
      customers (
        name,
        customer_code
      )
      ,
      orders (
        order_code,
        order_status
      )
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (role === 'TECHNICIAN') {
    // Current assignments only: appointment in active states AND installation not historical
    installQuery = installQuery
      .eq('appointments.assignee_id', userId)
      .in('appointments.status', ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'])
      .not('status', 'in', '("COMPLETED","FAILED")');
  }

  const { data: rawInstalls, error: installError } = await installQuery;
  if (installError) throw new OperationsError('FETCH_FAILED');

  const installations: FieldInstallationItem[] = (rawInstalls || []).map((i: Record<string, unknown>) => {
    const cust = i.customers as { name?: string; customer_code?: string } | null;
    const ord = i.orders as { order_code?: string; order_status?: string } | null;
    const appt = i.appointments as { address?: string; start_time?: string; status?: string } | null;

    return {
      id: String(i.id),
      customerId: String(i.customer_id),
      customerName: cust?.name || 'Khách hàng',
      customerCode: cust?.customer_code || '',
      orderId: String(i.order_id),
      orderCode: ord?.order_code || '',
      orderStatus: ord?.order_status || '',
      appointmentId: String(i.appointment_id),
      address: appt?.address || '',
      startTime: appt?.start_time || '',
      status: i.status as InstallationStatus,
      appointmentStatus: String(appt?.status || ''),
      photos: Array.isArray(i.photos) ? (i.photos as string[]) : [],
      handoverRef: (i.handover_ref as string) || null,
      completedAt: (i.completed_at as string) || null,
      crew: Array.isArray(i.crew) ? (i.crew as string[]) : [],
    };
  });

  return {
    surveys,
    installations,
    role,
    userId,
  };
}
