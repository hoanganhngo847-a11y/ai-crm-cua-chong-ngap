import 'server-only';

export interface GroundingMessageItem {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly actorType: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface GroundingKnowledgeItem {
  readonly category: string;
  readonly title: string;
  readonly content: string;
}

export interface GroundingMemoryItem {
  readonly type: string;
  readonly key: string | null;
  readonly content: string;
  readonly confidence: number;
  readonly verified: boolean;
}

export interface GroundingBusinessFacts {
  readonly upcomingAppointmentsCount?: number;
  readonly lastCallSummary?: string | null;
}

export interface BrainTurnGrounding {
  readonly company?: {
    readonly id?: string;
    readonly name?: string;
    readonly businessHours?: string;
  };
  readonly customer?: {
    readonly id?: string;
    readonly name?: string;
    readonly customerCode?: string | null;
    readonly stage?: string | null;
  };
  readonly conversation?: {
    readonly id: string;
    readonly channel: string;
    readonly status: string;
    readonly aiMode?: string | null;
    readonly assignedTo?: string | null;
  };
  readonly recentMessages: readonly GroundingMessageItem[];
  readonly knowledge: readonly GroundingKnowledgeItem[];
  readonly memories: readonly GroundingMemoryItem[];
  readonly businessFacts?: GroundingBusinessFacts;
}
