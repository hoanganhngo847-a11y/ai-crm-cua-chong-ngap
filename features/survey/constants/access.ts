export const ACTIVE_SURVEY_ASSIGNMENT_STATUSES = [
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
] as const;

export function isActiveSurveyAssignment(status: string): boolean {
  return (ACTIVE_SURVEY_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

export interface SurveyAccessActor {
  userId: string;
  companyId: string | null;
  profileStatus: string;
  membershipStatus: string | null;
  role: string | null;
}

export interface SurveyAccessResource {
  company_id: string;
  assignee_id: string | null;
  status: string;
  type: string;
}

export function canAccessSurvey(
  actor: SurveyAccessActor | null,
  appointment: SurveyAccessResource,
  mutation = false,
): boolean {
  if (!actor?.userId || actor.profileStatus !== 'ACTIVE' ||
      actor.membershipStatus !== 'ACTIVE' || actor.companyId !== appointment.company_id ||
      appointment.type !== 'SURVEY') return false;
  if (mutation && !isActiveSurveyAssignment(appointment.status)) return false;
  if (actor.role === 'BOSS_ADMIN') return true;
  return actor.role === 'TECHNICIAN' && appointment.assignee_id === actor.userId &&
    isActiveSurveyAssignment(appointment.status);
}
