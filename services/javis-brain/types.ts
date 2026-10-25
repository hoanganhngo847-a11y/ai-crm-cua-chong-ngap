import 'server-only';
import type { ProviderDiagnostic } from '../../features/ai-brain/provider-failure';
import type { DossierContext, DossierSnapshot } from '../../features/customer-360/contracts';
import type {
  BrainChannel,
  BrainConversationState,
  BrainLatencyProfile,
  BrainModality,
  BrainProposal,
  BrainTurnGrounding,
  BrainTurnRequest,
} from '../../features/ai-brain/contracts';

export type {
  BrainChannel,
  BrainConversationState,
  BrainLatencyProfile,
  BrainModality,
  BrainProposal,
  BrainTurnGrounding,
  BrainTurnRequest,
};

export interface JavisBrainConfig {
  readonly port: number;
  readonly host: string;
  readonly authToken: string;
  readonly runtimeBaseUrl?: string;
  readonly runtimeInternalToken?: string;
  readonly geminiApiKey?: string;
  readonly model: string;
  readonly maxConcurrency: number;
  readonly standardDeadlineMs: number;
  readonly realtimeDeadlineMs: number;
  readonly outerTimeoutMs: number;
}

export interface ModelBackend {
  generateDossier?(context: DossierContext, options: { signal: AbortSignal }): Promise<DossierSnapshot>;
  generate(
    inputText: string,
    options: {
      readonly signal: AbortSignal;
      readonly latencyProfile: BrainLatencyProfile;
      readonly grounding?: BrainTurnGrounding;
    }
  ): Promise<BrainProposal>;
}

export interface SafeAuditLog {
  readonly upstream?: Readonly<ProviderDiagnostic>;
  readonly turnId: string | null;
  readonly traceId: string | null;
  readonly latencyMs: number;
  readonly decision: 'RESPOND' | 'HANDOVER' | 'NO_REPLY' | 'ERROR' | null;
  readonly status: number;
  readonly provider: string;
  readonly model: string;
}

export interface HealthResponse {
  readonly ok: true;
  readonly service: 'javis-brain';
  readonly version: 'v1';
}

export interface TurnResponse {
  readonly ok: true;
  readonly version: 'v1';
  readonly proposal: BrainProposal;
}
