import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordingMetadata } from '../../features/zalo-recordings/metadata';

export function audioFixture(): Buffer {
  const dir=mkdtempSync(join(tmpdir(),'zalo-recording-test-'));
  try {
    const target=join(dir,'test.m4a');
    execFileSync(process.env.FFMPEG_PATH || (process.platform==='darwin'?'/opt/homebrew/bin/ffmpeg':'ffmpeg'),['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-af','pan=stereo|c0=c0|c1=c0','-c:a','aac','-ar','48000',target]);
    return readFileSync(target);
  } finally {rmSync(dir,{recursive:true,force:true});}
}
export function metadataFixture(device: string, name: string | null = 'Lương Thắng'): RecordingMetadata {
  return {schema_version:1,source:'ZALO_PERSONAL',local_call_id:randomUUID(),device_id:device,agent_version:'2.0.0',direction:'INBOUND',remote_display_name:name,
    remote_identity_type:'DISPLAY_NAME_ONLY',identity_confidence:name?'MEDIUM':'UNKNOWN',phone_if_visible:null,started_at:'2026-10-20T01:00:00Z',answered_at:null,
    ended_at:'2026-10-20T01:00:02Z',duration_seconds:2,recording_file:'test.m4a',audio_validation:{remote_non_silent:true,local_non_silent:true}};
}
export function uploadRequest(metadata: RecordingMetadata, audio: Buffer, secret: string) {
  const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.set('recording',new File([new Uint8Array(audio)],'test.m4a',{type:'audio/mp4'}));
  return new Request('http://localhost/api/voice/zalo-personal/recordings',{method:'POST',headers:{'x-zalo-device-id':metadata.device_id,authorization:`Bearer ${secret}`},body:form});
}
