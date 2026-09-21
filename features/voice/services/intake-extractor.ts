import 'server-only';
import OpenAI from 'openai';
import { createAdminClient } from '../../../lib/supabase/admin';

interface ExtractedIntake {
  customer_name: string | null;
  door_type: string | null;
  width_mm: number | null;
  height_mm: number | null;
  flood_depth_mm: number | null;
  opening_count: number | null;
  survey_address: string | null;
  survey_requested: boolean;
  preferred_survey_at: string | null;
  notes: string | null;
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}

/** Extract and persist only the whitelisted survey intake fields for an inbound AI call. */
export async function extractAndStoreCallIntake(
  companyId: string,
  callId: string,
  transcript: string
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('INTAKE_EXTRACTION_NOT_CONFIGURED');

  const admin = createAdminClient();
  const { data: call } = await admin.from('calls')
    .select('id, customer_id, direction, agent_type')
    .eq('company_id', companyId).eq('id', callId).maybeSingle();
  if (!call || call.direction !== 'INBOUND' || call.agent_type !== 'AI') return;

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model: process.env.OPENAI_INTAKE_MODEL || 'gpt-5-mini',
    store: false,
    instructions: 'Trích xuất thông tin khách yêu cầu cửa chống ngập từ transcript. Chỉ dùng dữ kiện được nói rõ; không suy đoán. Nếu thiếu, trả null. survey_requested chỉ true khi khách đồng ý/yêu cầu khảo sát.',
    input: transcript.slice(0, 30_000),
    text: {
      format: {
        type: 'json_schema',
        name: 'voice_call_intake',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            customer_name: nullableString,
            door_type: nullableString,
            width_mm: nullableInteger,
            height_mm: nullableInteger,
            flood_depth_mm: nullableInteger,
            opening_count: nullableInteger,
            survey_address: nullableString,
            survey_requested: { type: 'boolean' },
            preferred_survey_at: nullableString,
            notes: nullableString,
          },
          required: [
            'customer_name', 'door_type', 'width_mm', 'height_mm', 'flood_depth_mm',
            'opening_count', 'survey_address', 'survey_requested', 'preferred_survey_at', 'notes',
          ],
        },
      },
    },
  });

  let intake: ExtractedIntake;
  try {
    intake = JSON.parse(response.output_text) as ExtractedIntake;
  } catch {
    throw new Error('INTAKE_EXTRACTION_INVALID');
  }

  const preferredAt = intake.preferred_survey_at && !Number.isNaN(Date.parse(intake.preferred_survey_at))
    ? new Date(intake.preferred_survey_at).toISOString()
    : null;
  const row = {
    company_id: companyId,
    call_id: callId,
    customer_id: call.customer_id,
    customer_name: cleanText(intake.customer_name, 160),
    door_type: cleanText(intake.door_type, 120),
    width_mm: boundedInteger(intake.width_mm, 100, 20_000),
    height_mm: boundedInteger(intake.height_mm, 100, 10_000),
    flood_depth_mm: boundedInteger(intake.flood_depth_mm, 0, 10_000),
    opening_count: boundedInteger(intake.opening_count, 1, 100),
    survey_address: cleanText(intake.survey_address, 500),
    survey_requested: intake.survey_requested === true,
    preferred_survey_at: preferredAt,
    notes: cleanText(intake.notes, 2_000),
    status: intake.survey_requested === true ? 'SURVEY_REQUESTED' : 'INTAKE_COMPLETED',
  };
  const { error } = await admin.from('voice_call_intakes').upsert(row, {
    onConflict: 'company_id,call_id',
  });
  if (error) throw new Error('INTAKE_WRITE_FAILED');

  if (row.customer_name) {
    await admin.from('customers').update({ name: row.customer_name })
      .eq('id', call.customer_id).eq('company_id', companyId).eq('name', 'Khách gọi Hotline');
  }
}
