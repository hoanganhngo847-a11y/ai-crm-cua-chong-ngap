import { createHash } from 'node:crypto';

export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class RecordingError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function sha256(value: Uint8Array | string) { return createHash('sha256').update(value).digest('hex'); }
export function normalizeDisplayName(value: string) { return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(); }
export function suggestionName(value: string) { return normalizeDisplayName(value).normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd'); }
const GENERIC = new Set(['zalo call', 'zalo', 'zalocall', 'calling', 'incoming call', 'cuộc gọi đến', 'đang gọi', 'đang kết nối', 'kết nối', 'connecting', 'cuộc gọi', 'call', 'unknown']);

export interface RecordingMetadata {
  schema_version: 1; source: 'ZALO_PERSONAL'; local_call_id: string; device_id: string;
  agent_version: string; direction: 'INBOUND' | 'OUTBOUND' | 'UNKNOWN';
  remote_display_name: string | null; remote_identity_type: 'DISPLAY_NAME_ONLY'; identity_confidence: 'MEDIUM' | 'UNKNOWN';
  phone_if_visible: null; started_at: string; answered_at: string | null; ended_at: string;
  duration_seconds: number; recording_file: string;
  audio_validation: { remote_non_silent: boolean; local_non_silent: boolean };
  crm_call_request_id?: string | null;
}
export function validateMetadata(input: unknown, deviceId: string, now = Date.now()): RecordingMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RecordingError('INVALID_METADATA');
  const m = input as Record<string, unknown>;
  const requiredKeys = ['schema_version','source','local_call_id','device_id','agent_version','direction','remote_display_name','remote_identity_type','identity_confidence','phone_if_visible','started_at','answered_at','ended_at','duration_seconds','recording_file','audio_validation'];
  const allowedKeys = [...requiredKeys, 'crm_call_request_id'];
  if (Object.keys(m).some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !(key in m))) throw new RecordingError('INVALID_METADATA_FIELDS');
  if (m.crm_call_request_id !== undefined && m.crm_call_request_id !== null && (typeof m.crm_call_request_id !== 'string' || !UUID.test(m.crm_call_request_id))) throw new RecordingError('INVALID_METADATA_IDENTITY');
  if (m.schema_version !== 1 || m.source !== 'ZALO_PERSONAL' || m.device_id !== deviceId || typeof m.local_call_id !== 'string' || !UUID.test(m.local_call_id)) throw new RecordingError('INVALID_METADATA_IDENTITY');
  if (!['INBOUND','OUTBOUND','UNKNOWN'].includes(String(m.direction)) || m.remote_identity_type !== 'DISPLAY_NAME_ONLY' || m.phone_if_visible !== null) throw new RecordingError('INVALID_METADATA_IDENTITY');
  if (m.remote_display_name !== null && (typeof m.remote_display_name !== 'string' || !m.remote_display_name.trim() || m.remote_display_name.length > 200 || /\p{Cc}/u.test(m.remote_display_name) || GENERIC.has(normalizeDisplayName(m.remote_display_name)))) throw new RecordingError('INVALID_DISPLAY_NAME');
  if (m.identity_confidence !== (m.remote_display_name === null ? 'UNKNOWN' : 'MEDIUM')) throw new RecordingError('INVALID_CONFIDENCE');
  if (typeof m.agent_version !== 'string' || !/^[a-zA-Z0-9.+_-]{1,40}$/.test(m.agent_version)) throw new RecordingError('INVALID_AGENT_VERSION');
  if (typeof m.recording_file !== 'string' || !/^[a-zA-Z0-9_-]{1,180}\.m4a$/.test(m.recording_file)) throw new RecordingError('INVALID_FILENAME');
  const time = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  const start = time(m.started_at), end = time(m.ended_at), answered = m.answered_at === null ? null : time(m.answered_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < Date.UTC(2020,0,1) || end > now + 5 * 60_000 || end < start || (answered !== null && (!Number.isFinite(answered) || answered < start || answered > end))) throw new RecordingError('INVALID_TIMESTAMPS');
  if (typeof m.duration_seconds !== 'number' || !Number.isFinite(m.duration_seconds) || m.duration_seconds <= 0 || m.duration_seconds > 7200 || Math.abs((end-start)/1000-m.duration_seconds) > 2) throw new RecordingError('INVALID_DURATION');
  const v = m.audio_validation as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 2 || typeof v.remote_non_silent !== 'boolean' || typeof v.local_non_silent !== 'boolean') throw new RecordingError('INVALID_AUDIO_VALIDATION');
  return {...Object.fromEntries(allowedKeys.filter(key => key in m).map(key => [key, m[key]])),
    audio_validation:{remote_non_silent:v.remote_non_silent,local_non_silent:v.local_non_silent}} as unknown as RecordingMetadata;
}

// Bounded ISO-BMFF validation: inspect the actual M4A container/audio track and duration.
// Signal flags remain device observations; they are not proof of intelligibility.
export function validateM4a(data: Buffer, expectedDuration: number) {
  interface Box { type: string; start: number; end: number; payload: number }
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      if (start+8>end || result.length>10000) throw new RecordingError('INVALID_M4A');
      let size=data.readUInt32BE(start), header=8;
      if (size===1) { if(start+16>end) throw new RecordingError('INVALID_M4A'); size=Number(data.readBigUInt64BE(start+8)); header=16; }
      if (size===0) size=end-start;
      if (!Number.isSafeInteger(size) || size<header || start+size>end) throw new RecordingError('INVALID_M4A');
      result.push({type:data.toString('ascii',start+4,start+8),start,end:start+size,payload:start+header}); start+=size;
    }
    return result;
  }
  const root=boxes(0,data.length), ftyp=root.find(b=>b.type==='ftyp'), moov=root.find(b=>b.type==='moov');
  if (!ftyp || ftyp.end-ftyp.payload<8 || !moov || !root.some(b=>b.type==='mdat' && b.end-b.payload>16)) throw new RecordingError('INVALID_M4A');
  const brands=data.toString('ascii',ftyp.payload,ftyp.end);
  if (!['M4A ','isom','mp42','mp41'].some(b=>brands.includes(b))) throw new RecordingError('INVALID_M4A');
  const tracks=boxes(moov.payload,moov.end).filter(b=>b.type==='trak');
  if (tracks.length!==1) throw new RecordingError('INVALID_M4A_TRACKS');
  const mdia=boxes(tracks[0].payload,tracks[0].end).find(b=>b.type==='mdia');
  if (!mdia) throw new RecordingError('INVALID_M4A');
  const media=boxes(mdia.payload,mdia.end), hdlr=media.find(b=>b.type==='hdlr'), mdhd=media.find(b=>b.type==='mdhd'), minf=media.find(b=>b.type==='minf');
  if (!hdlr || hdlr.payload+12>hdlr.end || data.toString('ascii',hdlr.payload+8,hdlr.payload+12)!=='soun' || !mdhd || !minf) throw new RecordingError('INVALID_M4A');
  const version=data[mdhd.payload], timeOffset=version===1?20:12;
  if (version>1 || mdhd.payload+timeOffset+(version===1?12:8)>mdhd.end) throw new RecordingError('INVALID_M4A');
  const timescale=data.readUInt32BE(mdhd.payload+timeOffset);
  const ticks=version===1?Number(data.readBigUInt64BE(mdhd.payload+timeOffset+4)):data.readUInt32BE(mdhd.payload+timeOffset+4);
  const seconds=ticks/timescale;
  if (!Number.isFinite(seconds) || seconds<=0 || seconds>7202 || Math.abs(seconds-expectedDuration)>2) throw new RecordingError('M4A_DURATION_MISMATCH');
  const stbl=boxes(minf.payload,minf.end).find(b=>b.type==='stbl');
  const stsd=stbl && boxes(stbl.payload,stbl.end).find(b=>b.type==='stsd');
  if (!stsd || stsd.payload+8>stsd.end || data.readUInt32BE(stsd.payload+4)!==1) throw new RecordingError('INVALID_M4A');
  const entries=boxes(stsd.payload+8,stsd.end), audio=entries[0];
  if (entries.length!==1 || audio.type!=='mp4a' || audio.start+36>audio.end || data.readUInt16BE(audio.start+24)!==2) throw new RecordingError('INVALID_M4A_STEREO_AAC');
  return seconds;
}
