import { createAdminClient } from '../../../../../lib/supabase/admin';
import { RecordingError } from '../../../../../features/zalo-recordings/metadata';
import { uploadRecording } from '../../../../../features/zalo-recordings/upload';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { return Response.json(await uploadRecording(request,createAdminClient()),{headers:{'Cache-Control':'no-store'}}); }
  catch(error) {
    const known=error instanceof RecordingError;
    return Response.json({ok:false,error:known?error.code:'UPLOAD_UNAVAILABLE'},{status:known?error.status:503,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  }
}
