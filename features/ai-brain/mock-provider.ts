import 'server-only';

import type { BrainProvider, BrainProviderDescriptor, BrainTurnRequest } from './contracts';

export const DETERMINISTIC_MOCK_DESCRIPTOR: BrainProviderDescriptor = Object.freeze({
  id: 'deterministic-mock',
  model: 'mock-v1',
});

export const DETERMINISTIC_MOCK_DRAFT =
  'Cảm ơn quý khách. Chúng tôi đã ghi nhận yêu cầu và nhân viên tư vấn sẽ phản hồi trong ít phút.';

export class DeterministicMockBrainProvider implements BrainProvider {
  readonly descriptor: BrainProviderDescriptor = DETERMINISTIC_MOCK_DESCRIPTOR;

  async runTurn(
    _request: BrainTurnRequest,
    options: { signal: AbortSignal }
  ): Promise<unknown> {
    if (options.signal.aborted) {
      throw new Error('Aborted');
    }

    return {
      decision: 'RESPOND',
      draft: DETERMINISTIC_MOCK_DRAFT,
      confidence: 1.0,
      toolsUsed: [],
      memoryReferences: [],
      sourceReferences: [],
    };
  }
}
