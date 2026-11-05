import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { quote, sql } from './local-fixture';

/** Real app authorization + native PG/RLS; REST transport and Storage signer
 * are synthetic adapters, not live Supabase provider acceptance. */
export async function syntheticStorageAdapter(initialDatabase: string) {
  const state={database:initialDatabase,now:Math.floor(Date.now()/1000),signs:0};
  const signingKey=randomBytes(32);
  const originalFetch=globalThis.fetch;
  const mac=(bucket:string,name:string,expires:number)=>createHmac('sha256',signingKey).update(JSON.stringify([bucket,name,expires])).digest('hex');
  const server=createServer((request,response)=>{
    response.setHeader('Connection','close');
    const url=new URL(request.url||'/',origin);
    const parts=decodeURIComponent(url.pathname).replace('/storage/v1/object/sign/','').split('/');
    const bucket=parts.shift()!,name=parts.join('/'),expires=Number(url.searchParams.get('expires')),signature=url.searchParams.get('signature')||'';
    const expected=mac(bucket,name,expires);
    if(request.method!=='GET'||!url.pathname.startsWith('/storage/v1/object/sign/')||!Number.isSafeInteger(expires)||state.now>=expires||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) {
      response.writeHead(403);response.end('SIGNED_LINK_INVALID_OR_EXPIRED');return;
    }
    const result=sql(state.database,`SELECT content FROM storage.objects WHERE bucket_id=${quote(bucket)} AND name=${quote(name)};`);
    if(!result){response.writeHead(404);response.end('NOT_FOUND');return;}
    response.writeHead(200);response.end(result);
  });
  let origin='';
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('FIXTURE_SERVER_FAILED');
  origin=`http://127.0.0.1:${address.port}`;
  globalThis.fetch=async (input,init)=>{
    const request=input instanceof Request?input:new Request(String(input),init);
    const url=new URL(request.url);
    if(url.origin!==origin)throw new Error('EXTERNAL_NETWORK_FORBIDDEN_IN_FIXTURE');
    if(request.method==='GET'&&url.pathname.startsWith('/storage/v1/object/sign/'))return originalFetch(request);
    if(url.pathname.startsWith('/rest/v1/')) {
      const table=url.pathname.slice('/rest/v1/'.length);
      if(!['user_profiles','company_members','surveys','appointments','installations','contracts','calls'].includes(table))throw new Error('UNEXPECTED_FIXTURE_TABLE');
      const projection=url.searchParams.get('select')||'*';
      if(!/^[a-z_, *]+$/.test(projection))throw new Error('UNSAFE_FIXTURE_PROJECTION');
      const filters:string[]=[];
      for(const [key,value] of url.searchParams) {
        if(key==='select')continue;
        if(!/^[a-z_]+$/.test(key)||!value.startsWith('eq.'))throw new Error('UNSAFE_FIXTURE_FILTER');
        filters.push(`${key}=${quote(value.slice(3))}`);
      }
      const actor=request.headers.get('x-fixture-actor');
      const role=actor?'authenticated':'service_role';
      if(actor&&!/^[a-f0-9-]{36}$/.test(actor))throw new Error('UNSAFE_FIXTURE_ACTOR');
      try {
        const query=`SET ROLE ${role}; ${actor?`SET request.jwt.claim.sub=${quote(actor)};`:''}
          SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT ${projection} FROM public.${table}${filters.length?' WHERE '+filters.join(' AND '):''}) t;`;
        const rows=JSON.parse(sql(state.database,query));
        if(request.headers.get('accept')?.includes('application/vnd.pgrst.object+json')) {
          return rows.length===1?Response.json(rows[0]):Response.json({code:'PGRST116',message:'No fixture row'},{status:406});
        }
        return Response.json(rows);
      } catch {return Response.json({code:'FIXTURE_QUERY_DENIED',message:'Fixture query denied'},{status:403});}
    }
    if(request.method==='POST'&&url.pathname.startsWith('/storage/v1/object/sign/')) {
      if(request.headers.get('authorization')!=='Bearer synthetic-service-only')return Response.json({error:'DENIED'},{status:403});
      const parts=decodeURIComponent(url.pathname).slice('/storage/v1/object/sign/'.length).split('/');
      const bucket=parts.shift()!,name=parts.join('/');
      const count=sql(state.database,`SELECT count(*) FROM storage.objects WHERE bucket_id=${quote(bucket)} AND name=${quote(name)};`);
      if(count!=='1')return Response.json({error:'NOT_FOUND'},{status:404});
      const body=await request.json() as {expiresIn:number};
      if(!Number.isInteger(body.expiresIn)||body.expiresIn<1)return Response.json({error:'INVALID_TTL'},{status:400});
      state.signs++;
      const expires=state.now+body.expiresIn;
      return Response.json({signedURL:`/object/sign/${bucket}/${name}?expires=${expires}&signature=${mac(bucket,name,expires)}`});
    }
    throw new Error('UNEXPECTED_FIXTURE_REQUEST');
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL=origin;
  process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-service-only';
  function actorClient(id:string|null,aal:'aal1'|'aal2'='aal2'):SupabaseClient {
    const base=createClient(origin,'synthetic-authenticated',{global:{headers:id?{'x-fixture-actor':id}:{}},auth:{persistSession:false,autoRefreshToken:false}});
    return {from:base.from.bind(base),auth:{getUser:async()=>({data:{user:id?{id,email:'synthetic@example.test'}:null},error:null}),mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:aal,nextLevel:'aal2'},error:null}),listFactors:async()=>({data:{totp:[{status:'verified'}]},error:null})}}} as unknown as SupabaseClient;
  }
  return {state,actorClient,origin,async close(){globalThis.fetch=originalFetch;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
