import {
  CANONICAL_CUSTOMER_STAGES,
  CUSTOMER_STAGE_LABELS,
  tryToCanonicalStage,
  type CanonicalCustomerStage,
} from '../types/customer.types';
import { OBJECTION_SIGNALS, STAGE_SIGNALS } from './lexicon';
import {
  containsNormalizedPhrase,
  detectSignalContext,
  extractSentenceContaining,
  findNormalizedPhrase,
  normalizeVietnamese,
} from './normalize';
import {
  STAGE_CLASSIFIER_VERSION,
  type StageClassification,
  type StageClassifierEvidence,
  type StageClassifierInput,
  type StageClassifierSource,
  type StageClassifierSpeaker,
} from './types';

const SOURCE_PRIOR_STAGE: Record<string, CanonicalCustomerStage> = {
  ZALO: 'interested',
  ZALO_OA: 'interested',
  WEBSITE: 'interested',
  FACEBOOK: 'awareness',
  HOTLINE: 'awareness',
  ADVERTISING: 'awareness',
  MANUAL: 'awareness',
};

const NEXT_ACTION_BY_STAGE: Record<CanonicalCustomerStage, string> = {
  awareness: 'Gửi tin nhắn chào, xác nhận nhu cầu và kênh liên hệ phù hợp.',
  interested: 'Tư vấn sản phẩm, hỏi kích thước/địa chỉ và đề xuất khảo sát thực tế.',
  deep_research: 'Gửi tài liệu kỹ thuật, so sánh phương án và đề xuất lịch khảo sát.',
  low_potential: 'Giữ liên hệ nhẹ nhàng, hẹn lại khi khách có nhu cầu; không thúc ép.',
  high_potential: 'Xác nhận phương án, báo giá chính thức và đề xuất bước ký hợp đồng.',
  contract_signed: 'Kiểm tra bản hợp đồng đã ký và chuyển bộ phận triển khai.',
};

const SPEAKER_WEIGHT: Record<StageClassifierSpeaker, number> = {
  CUSTOMER: 1,
  STAFF: 0.35,
  UNKNOWN: 0.5,
};

/**
 * Các mẫu "đã ký" trần trụi rất dễ nhầm với "ký gửi", "ký nhận".
 * Chỉ coi là bằng chứng hợp đồng khi trong nguồn có ngữ cảnh hợp đồng/đơn hàng.
 */
const BARE_CONTRACT_PATTERNS = new Set([
  'da ky',
  'ky roi',
  'da ky roi',
  'ky xong',
  'dong y ky',
  'da xac nhan ky',
]);

const CONTRACT_CONTEXT_PATTERNS = [
  'hop dong',
  'don hang',
  'bien ban',
  'nghiem thu',
  'ban giao',
  'dat coc',
];

function emptyScores(): Record<CanonicalCustomerStage, number> {
  return CANONICAL_CUSTOMER_STAGES.reduce(
    (acc, stage) => {
      acc[stage] = 0;
      return acc;
    },
    {} as Record<CanonicalCustomerStage, number>
  );
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeIsoDate(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function sortSources(sources: StageClassifierSource[]): StageClassifierSource[] {
  return [...sources].sort((a, b) => safeIsoDate(a.occurredAt) - safeIsoDate(b.occurredAt));
}

function recencyWeight(index: number, total: number): number {
  if (total <= 1) return 1;
  const ratio = (index + 1) / total;
  return 0.75 + 0.25 * ratio;
}

function makeEvidence(
  source: StageClassifierSource,
  quote: string,
  signal: string,
  stage: CanonicalCustomerStage,
  weight: number
): StageClassifierEvidence {
  return {
    quote: quote.length > 500 ? `${quote.slice(0, 497)}...` : quote,
    source: source.channel || source.sourceType,
    occurredAt: source.occurredAt || null,
    speaker: source.speaker,
    signal,
    stage,
    weight: round(weight, 2),
  };
}

/**
 * Phân loại giai đoạn bằng luật xác định, chạy hoàn toàn trên dữ liệu đã sanitize.
 *
 * Đây là baseline độc lập với LLM:
 * - Quy tắc nguồn chỉ là gợi ý ban đầu.
 * - Bằng chứng hội thoại mạnh hơn sẽ lấn át quy tắc nguồn.
 * - "muốn ký"/"chờ ký"/"gửi hợp đồng" không bao giờ được coi là đã ký.
 * - Mọi kết quả đều yêu cầu con người xác minh trước khi đổi stage chính thức.
 */
export function classifyCustomerStage(input: StageClassifierInput): StageClassification {
  const sources = sortSources(input.sources || []);
  const scores = emptyScores();
  const evidenceItems: StageClassifierEvidence[] = [];
  const objections: string[] = [];
  const seenEvidence = new Set<string>();
  const seenObjections = new Set<string>();

  const currentStage = tryToCanonicalStage(input.customer?.stage);
  const sourceKey = String(input.customer?.source || '').trim().toUpperCase();
  const priorStage = SOURCE_PRIOR_STAGE[sourceKey] || 'awareness';

  let strongestSignalWeight = 0;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    const normalized = normalizeVietnamese(source.content || '');
    if (!normalized) continue;

    const recency = recencyWeight(sourceIndex, sources.length);
    const speakerWeight = SPEAKER_WEIGHT[source.speaker] ?? 0.5;

    for (const signal of STAGE_SIGNALS) {
      const matchedPattern = signal.patterns.find((pattern) =>
        containsNormalizedPhrase(normalized, pattern)
      );
      if (!matchedPattern) continue;

      const signalIndex = findNormalizedPhrase(normalized, matchedPattern);
      const context = detectSignalContext(normalized, Math.max(0, signalIndex));

      let effectiveStage: CanonicalCustomerStage | null = signal.stage;
      let effectiveWeight = signal.weight;

      if (signal.kind === 'CONTRACT') {
        const bareSignature =
          BARE_CONTRACT_PATTERNS.has(matchedPattern) &&
          !CONTRACT_CONTEXT_PATTERNS.some((pattern) =>
            containsNormalizedPhrase(normalized, pattern)
          );

        if (context.otherProviderChosen) {
          effectiveStage = 'low_potential';
          effectiveWeight = 0.9;
        } else if (context.otherProvider) {
          effectiveStage = 'deep_research';
          effectiveWeight = signal.weight * 0.5;
        } else if (bareSignature) {
          // "đã ký gửi", "ký nhận hàng"... chưa đủ căn cứ xác nhận hợp đồng đã ký.
          effectiveStage = 'high_potential';
          effectiveWeight = 0.6;
        } else if (context.negated) {
          // "chưa ký", "không ký" không phải bằng chứng đã ký.
          effectiveStage = null;
        } else if (context.future || context.hypothetical) {
          // "sẽ ký", "dự định ký", "muốn ký" chỉ là tiềm năng.
          effectiveStage = 'high_potential';
          effectiveWeight = Math.max(0.5, signal.weight * 0.65);
        }
      } else if (signal.kind === 'COMMITMENT') {
        if (context.otherProviderChosen) {
          effectiveStage = 'low_potential';
          effectiveWeight = 0.85;
        } else if (context.otherProvider) {
          effectiveStage = 'deep_research';
          effectiveWeight = signal.weight * 0.6;
        } else if (context.negated) {
          effectiveStage = null;
        } else if (context.hypothetical) {
          effectiveWeight = signal.weight * 0.6;
        }
      } else if (signal.kind === 'RESEARCH') {
        if (context.negated) {
          effectiveStage = null;
        } else if (context.hypothetical) {
          effectiveWeight = signal.weight * 0.6;
        }
      } else if (signal.kind === 'INTENT') {
        if (context.otherProviderChosen) {
          effectiveStage = 'low_potential';
          effectiveWeight = signal.weight * 0.8;
        } else if (context.otherProvider) {
          effectiveStage = 'deep_research';
          effectiveWeight = signal.weight * 0.5;
        } else if (context.negated) {
          effectiveStage = null;
        } else if (context.hypothetical) {
          effectiveWeight = signal.weight * 0.6;
        }
      } else if (signal.kind === 'NEGATIVE') {
        // Trong câu "không phải không có nhu cầu", tín hiệu tiêu cực bị phủ định.
        if (context.negated) {
          effectiveStage = null;
        }
      }

      if (!effectiveStage) continue;

      const finalWeight = round(effectiveWeight * speakerWeight * recency, 3);
      if (finalWeight <= 0) continue;

      scores[effectiveStage] = round(scores[effectiveStage] + finalWeight, 3);
      if (finalWeight > strongestSignalWeight) strongestSignalWeight = finalWeight;

      const quote =
        extractSentenceContaining(source.content, matchedPattern) || source.content.trim();
      const evidenceKey = `${source.id}:${signal.id}:${quote.slice(0, 80)}`;
      if (quote && !seenEvidence.has(evidenceKey) && evidenceItems.length < 20) {
        seenEvidence.add(evidenceKey);
        evidenceItems.push(
          makeEvidence(
            source,
            quote,
            signal.kind === 'NEGATIVE' ? `negative:${signal.id}` : signal.id,
            effectiveStage,
            finalWeight
          )
        );
      }
    }

    // Objections are extracted separately and do not change the stage score.
    for (const objection of OBJECTION_SIGNALS) {
      const matchedPattern = objection.patterns.find((pattern) =>
        containsNormalizedPhrase(normalized, pattern)
      );
      if (!matchedPattern) continue;
      const quote = extractSentenceContaining(source.content, matchedPattern);
      if (!quote || seenObjections.has(quote)) continue;
      seenObjections.add(quote);
      if (objections.length < 10) objections.push(quote);
    }
  }

  // Quy tắc nguồn: chỉ là prior, không phải bằng chứng hành vi.
  const priorWeight = strongestSignalWeight >= 0.45 ? 0.15 : 0.35;
  scores[priorStage] = round(scores[priorStage] + priorWeight, 3);
  const sourceRuleApplied = strongestSignalWeight < 0.45;

  // Nếu hoàn toàn không có tín hiệu, dùng prior làm kết quả tối thiểu.
  let topStage: CanonicalCustomerStage = priorStage;
  let topScore = -1;
  let secondScore = 0;
  for (const stage of CANONICAL_CUSTOMER_STAGES) {
    const score = scores[stage] || 0;
    if (score > topScore) {
      secondScore = topScore < 0 ? 0 : topScore;
      topScore = score;
      topStage = stage;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  // Contract signed chỉ hợp lệ khi có ít nhất một tín hiệu hợp đồng thực sự.
  if (topStage === 'contract_signed') {
    const hasContractEvidence = evidenceItems.some(
      (item) => item.stage === 'contract_signed' && item.signal.startsWith('contract_')
    );
    if (!hasContractEvidence) {
      topStage = 'high_potential';
      topScore = scores.high_potential;
      secondScore = scores.contract_signed;
    }
  }

  if (topScore <= 0) {
    topStage = priorStage;
    topScore = priorWeight;
  }

  if (sourceRuleApplied && evidenceItems.length === 0 && sources.length > 0) {
    const firstSource = sources[sources.length - 1];
    evidenceItems.push(
      makeEvidence(
        firstSource,
        firstSource.content.trim(),
        'source_prior',
        priorStage,
        priorWeight
      )
    );
  }

  const totalScore = CANONICAL_CUSTOMER_STAGES.reduce((sum, stage) => sum + (scores[stage] || 0), 0);
  const topShare = totalScore > 0 ? topScore / totalScore : 0;
  const margin = Math.max(0, topScore - secondScore);
  const evidenceCount = evidenceItems.length;

  let confidence =
    0.3 +
    0.35 * topShare +
    0.2 * Math.min(1, margin / 0.6) +
    0.1 * Math.min(1, evidenceCount / 3);
  if (sourceRuleApplied) confidence = Math.min(confidence, 0.4);
  if (topStage === 'contract_signed') confidence = Math.min(confidence, 0.85);
  confidence = round(clamp(confidence, 0.2, 0.92));

  const conflict =
    (scores.low_potential || 0) >= 0.3 &&
    ((scores.high_potential || 0) >= 0.3 || (scores.contract_signed || 0) >= 0.3);

  const reasonParts: string[] = [];
  if (sourceRuleApplied) {
    reasonParts.push(
      `Chưa có tín hiệu hội thoại đủ mạnh; nguồn ${sourceKey || 'không xác định'} gợi ý giai đoạn ${CUSTOMER_STAGE_LABELS[priorStage] || priorStage}.`
    );
  } else {
    const topEvidence = evidenceItems
      .filter((item) => item.stage === topStage && item.signal !== 'source_prior')
      .slice(0, 2);
    if (topEvidence.length > 0) {
      reasonParts.push(
        `Tín hiệu chính: ${topEvidence
          .map((item) => `"${item.quote}" (${item.source}${item.occurredAt ? `, ${item.occurredAt}` : ''})`)
          .join('; ')}.`
      );
    } else {
      reasonParts.push(`Các tín hiệu hội thoại nghiêng về giai đoạn ${CUSTOMER_STAGE_LABELS[topStage] || topStage}.`);
    }
  }

  if (conflict) {
    reasonParts.push('Có tín hiệu mâu thuẫn giữa nhu cầu và việc từ chối/so sánh; cần nhân viên xác minh.');
  }
  if (currentStage && currentStage !== topStage) {
    reasonParts.push(
      `Đề xuất chuyển từ ${CUSTOMER_STAGE_LABELS[currentStage] || currentStage} sang ${CUSTOMER_STAGE_LABELS[topStage] || topStage}.`
    );
  } else if (currentStage === topStage) {
    reasonParts.push(`Giữ nguyên giai đoạn ${CUSTOMER_STAGE_LABELS[topStage] || topStage}.`);
  }

  const evidence = evidenceItems
    .slice(0, 5)
    .map((item) => item.quote)
    .join(' | ')
    .slice(0, 5000);

  return {
    suggestedStage: topStage,
    currentStage,
    confidence,
    reason: reasonParts.join(' ').slice(0, 1000),
    evidence:
      evidence ||
      `Chưa có trích dẫn trực tiếp; đề xuất dựa trên quy tắc nguồn ${sourceKey || 'không xác định'}.`,
    evidenceItems,
    objections,
    nextAction: NEXT_ACTION_BY_STAGE[topStage],
    requiresVerification: true,
    sourceRuleApplied,
    classifierVersion: STAGE_CLASSIFIER_VERSION,
    scores,
  };
}

export { STAGE_CLASSIFIER_VERSION };
export type {
  StageClassification,
  StageClassifierEvidence,
  StageClassifierInput,
  StageClassifierSource,
  StageClassifierSpeaker,
} from './types';
