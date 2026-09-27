import 'server-only';
import { getActorContext } from '../../../lib/auth/context';
import { createAdminClient } from '../../../lib/supabase/admin';
import { canAccessSurvey } from '../constants/access';

/** Resolve tenant from the resource before checking the active session membership. */
export async function authorizeSurveyAppointment(appointmentId: string, mutation = false) {
  const adminClient = createAdminClient();
  const { data: appointment, error } = await adminClient.from('appointments')
    .select('id, company_id, customer_id, assignee_id, status, type')
    .eq('id', appointmentId).maybeSingle();
  if (error || !appointment) throw new Error('Không tìm thấy lịch hẹn khảo sát.');
  const actor = await getActorContext(appointment.company_id);
  if (!actor || !canAccessSurvey(actor, appointment, mutation)) {
    throw new Error('Bạn không có quyền thao tác trên lịch hẹn khảo sát này.');
  }
  return { actor, appointment, adminClient };
}
