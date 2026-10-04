export type InstallationStatus =
    | 'SCHEDULED'
    | 'IN_TRANSIT'
    | 'INSTALLING'
    | 'TESTING'
    | 'HANDOVER_PENDING'
    | 'COMPLETED'
    | 'FAILED';

export type SettableInstallationStatus =
    | 'SCHEDULED'
    | 'IN_TRANSIT'
    | 'INSTALLING'
    | 'TESTING'
    | 'HANDOVER_PENDING'
    | 'FAILED';

export interface InstallationDTO {
    id: string;
    companyId: string;
    customerId: string;
    orderId: string;
    appointmentId: string;
    crew: string[];
    status: InstallationStatus;
    photos: string[];
    handoverRef: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ScheduleInstallationInput {
    customerId: string;
    orderId: string;
    appointmentId: string;
    crew: string[];
}

export interface CompleteInstallationInput {
    installationId: string;
}

export type InstallationEvidenceType = 'photo' | 'handover' | 'PHOTO' | 'HANDOVER';

export interface AttachInstallationEvidenceInput {
    installationId: string;
    fileKey: string;
    type: InstallationEvidenceType;
}

export interface AppointmentDTO {
    id: string;
    companyId: string;
    customerId: string;
    type: 'SURVEY' | 'INSTALLATION';
    startTime: string;
    assigneeId: string;
    address: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface CreateInstallationScheduleInput {
    orderId: string;
    technicianId: string;
    startTime: string;
    address: string;
    crew: string[];
}

export interface CreateInstallationScheduleResult {
    installation: InstallationDTO;
    appointment: AppointmentDTO;
    idempotent: boolean;
}
