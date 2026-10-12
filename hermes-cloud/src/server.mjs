import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Store, safeId } from './storage.mjs';
import { Queue, verifyLink } from './queue.mjs';
import { newProject } from './project.mjs';
import { actions, validate, obj, schemas } from './schema.mjs';
import { MAX_MEDIA_BYTES } from './media.mjs';

process.umask(0o077);
const port=Number(process.env.PORT||8080);
const token=process.env.OPENREEL_SERVICE_TOKEN||'', signingKey=process.env.OUTPUT_SIGNING_KEY||'';
if(token.length<32||signingKey.length<32) throw new Error('Set independent OPENREEL_SERVICE_TOKEN and OUTPUT_SIGNING_KEY (at least 32 characters each).');
if(process.env.RENDER_LOCATION!=='cloud') throw new Error('Set RENDER_LOCATION=cloud only on Railway/cloud; do not run this renderer on the Hermes VPS.');
const config={signingKey,publicURL:(process.env.PUBLIC_BASE_URL||(process.env.RAILWAY_PUBLIC_DOMAIN?'https://'+process.env.RAILWAY_PUBLIC_DOMAIN:'http://127.0.0.1:'+port)).replace(/\/$/,''),
  allowlist:(process.env.MEDIA_HOST_ALLOWLIST||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean),maxJobMs:Number(process.env.MAX_JOB_SECONDS||900)*1000};
const publicURL=new URL(config.publicURL);
const cors=(process.env.CORS_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
const store=new Store(resolve(process.env.DATA_DIR||'./data'));await store.init();
const queue=new Queue(store,config);await queue.init();
let uploading=false;
const caps={version:'0.1.0',editing:'OpenReel HeadlessHost',rendering:'cloud FFmpeg subset',llm_calls:0,
  limits:{concurrent_renders:1,max_seconds:600,max_pixels:2073600,max_dimension:1920,max_media_bytes:MAX_MEDIA_BYTES,max_output_bytes:256*1024**2,max_queued:32,max_clips:100},
  supported:['cut','trim','reorder','static image/video overlays','contain/cover/stretch','scale/position/opacity','audio mix/volume/fades','plain Unicode subtitles','H.264/AAC MP4','portrait/landscape'],
  unsupported:['GPU effects','keyframe animation','3D','motion scenes','textClips','transitions','variable speed','arbitrary scripts'],
  security_model:'one private owner token; not a guest/tenant service'};
const tools=[
  {name:'openreel_capabilities',description:'Supported render features and cloud limits. No model calls are made by this service.',inputSchema:obj({})},
  {name:'openreel_projects',description:'Create, list, or read an OpenReel cloud project. Get its revision before editing/rendering.',inputSchema:obj({action:{enum:['create','list','get']},project_id:{type:'string'},settings:schemas.project},['action'])},
  {name:'openreel_catalog',description:'Fetch the small supported OpenReel action catalog only when needed; all edits are real HeadlessHost actions.',inputSchema:obj({})},
  {name:'openreel_submit',description:'Queue a URL import, atomic edit batch, or MP4 render and immediately get a job ID. Reuse the idempotency key only for the same request. edit/render require expected_revision. Poll openreel_job for results.',inputSchema:schemas.job},
  {name:'openreel_job',description:'Read job state/progress/result/output URL or cancel it. Poll every 5–10 seconds. No repeated render submission needed.',inputSchema:obj({id:{type:'string'},action:{enum:['status','cancel']}},['id'])},
  {name:'openreel_output',description:'Get a fresh one-hour signed MP4 URL for a completed render job.',inputSchema:obj({id:{type:'string'}},['id'])},
];
async function create(settings) {
  validate('project',settings);
  const project=newProject(settings);
  if(project.settings.width%2 || project.settings.height%2 || project.settings.width*project.settings.height>2073600) throw new Error('MAX_OUTPUT_1080P_EVEN_DIMENSIONS');
  await store.diskBudget(1024*1024);
  const record={revision:0,project};await store.write('projects',project.id,record);return record;
}
async function tool(name,args) {
  switch(name) {
    case 'openreel_capabilities':return caps;
    case 'openreel_catalog':return {actions};
    case 'openreel_projects':
      if(args.action==='create') return create(args.settings);
      if(args.action==='get') return store.read('projects',args.project_id);
      if(args.action==='list') return (await store.list('projects')).map(r=>({id:r.project.id,name:r.project.name,revision:r.revision}));
      throw new Error('INVALID_PROJECT_ACTION');
    case 'openreel_submit':return queue.enqueue(args);
    case 'openreel_job':safeId(args.id);return args.action==='cancel'?queue.cancel(args.id):queue.get(args.id);
    case 'openreel_output': {
      safeId(args.id);const job=queue.get(args.id);if(job.status!=='completed'||job.kind!=='render')throw new Error('OUTPUT_NOT_READY');return {id:args.id,output_url:job.output_url,expires_in_seconds:3600};
    }
    default:throw new Error('UNKNOWN_TOOL');
  }
}
function authorized(req) {
  const value=req.headers.authorization;
  if(typeof value!=='string'||!value.startsWith('Bearer '))return false;
  return timingSafeEqual(createHash('sha256').update(value.slice(7)).digest(),createHash('sha256').update(token).digest());
}
function reply(res,status,data) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req) {
  if(!String(req.headers['content-type']||'').includes('application/json'))throw new Error('JSON_CONTENT_TYPE_REQUIRED');
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2*1024**2)throw new Error('BODY_TOO_LARGE');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('INVALID_JSON');}
}
async function mcp(req,res) {
  const server=new Server({name:'openreel-cloud',version:'0.1.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try {const value=await tool(request.params.name,request.params.arguments||{});return {content:[{type:'text',text:JSON.stringify(value)}]};}
    catch(e){return {isError:true,content:[{type:'text',text:e.message.slice(0,300)}]};}
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,
    enableDnsRebindingProtection:true,allowedHosts:[publicURL.host,'127.0.0.1:'+port,'localhost:'+port],allowedOrigins:cors});
  res.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
  await server.connect(transport);await transport.handleRequest(req,res,req.method==='POST'?await body(req):undefined);
}
async function upload(req,url) {
  if(uploading)throw new Error('UPLOAD_BUSY');uploading=true;
  const id=randomUUID(),path=store.path('media',id,'.bin');
  try {
    const projectID=safeId(url.searchParams.get('project_id'));await store.read('projects',projectID);
    const key=req.headers['idempotency-key'];if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(key||''))throw new Error('INVALID_IDEMPOTENCY_KEY');
    const name=(url.searchParams.get('name')||'Uploaded media').slice(0,120);
    await store.diskBudget(MAX_MEDIA_BYTES);
    if(Number(req.headers['content-length']||0)>MAX_MEDIA_BYTES)throw new Error('MEDIA_TOO_LARGE');
    let size=0;const digest=createHash('sha256');
    const meter=new Transform({transform(chunk,_enc,cb){size+=chunk.length;digest.update(chunk);cb(size>MAX_MEDIA_BYTES?new Error('MEDIA_TOO_LARGE'):null,chunk);}});
    await pipeline(req,meter,createWriteStream(path,{flags:'wx',mode:0o600}));
    return await queue.enqueueUpload(projectID,id,name,key,digest.digest('hex'),size);
  } catch(e) {await fs.unlink(path).catch(()=>{});throw e;}finally{uploading=false;}
}
const app=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://internal');
    const origin=req.headers.origin;
    if(origin) {
      if(!cors.includes(origin)){reply(res,403,{error:'ORIGIN_NOT_ALLOWED'});return;}
      res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,Idempotency-Key');res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
    }
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method==='GET'&&url.pathname==='/health'){reply(res,200,{status:'ok',version:'0.1.0',renderer:'cloud'});return;}
    const output=url.pathname.match(/^\/outputs\/([0-9a-f-]{36})\.mp4$/);
    if(output&&req.method==='GET') {
      safeId(output[1]);
      if(!verifyLink(output[1],url.searchParams.get('exp'),url.searchParams.get('sig'),signingKey)){reply(res,403,{error:'LINK_INVALID_OR_EXPIRED'});return;}
      if(queue.get(output[1]).status!=='completed')throw new Error('OUTPUT_NOT_READY');
      const path=store.path('outputs',output[1],'.mp4'),stat=await fs.stat(path);
      res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':stat.size,'Content-Disposition':'attachment; filename="openreel-'+output[1]+'.mp4"','Cache-Control':'private, no-store'});
      await pipeline(createReadStream(path),res);return;
    }
    if(!authorized(req)){reply(res,401,{error:'UNAUTHORIZED'});return;}
    if(url.pathname==='/mcp'){await mcp(req,res);return;}
    if(req.method==='GET'&&url.pathname==='/api/capabilities'){reply(res,200,caps);return;}
    if(req.method==='GET'&&url.pathname==='/api/catalog'){reply(res,200,{actions});return;}
    if(req.method==='POST'&&url.pathname==='/api/projects'){reply(res,201,await create(await body(req)));return;}
    if(req.method==='GET'&&url.pathname==='/api/projects'){reply(res,200,await tool('openreel_projects',{action:'list'}));return;}
    const project=url.pathname.match(/^\/api\/projects\/([0-9a-f-]{36})$/);
    if(project&&req.method==='GET'){reply(res,200,await store.read('projects',project[1]));return;}
    if(project&&req.method==='DELETE'){reply(res,200,await queue.deleteProject(project[1]));return;}
    if(req.method==='POST'&&url.pathname==='/api/media/upload'){reply(res,202,await upload(req,url));return;}
    if(req.method==='POST'&&url.pathname==='/api/jobs'){reply(res,202,await queue.enqueue(await body(req)));return;}
    const job=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/);
    if(job){safeId(job[1]);
      if(req.method==='GET'&&!job[2]){reply(res,200,queue.get(job[1]));return;}
      if(req.method==='POST'&&job[2]){reply(res,200,await queue.cancel(job[1]));return;}
      if(req.method==='DELETE'&&!job[2]){reply(res,200,await queue.remove(job[1]));return;}
    }
    reply(res,404,{error:'NOT_FOUND'});
  } catch(e) {
    if(res.headersSent){res.destroy();return;}
    const code=e.message==='NOT_FOUND'?404:/CONFLICT|JOB_IS_ACTIVE/.test(e.message)?409:/QUEUE_FULL|UPLOAD_BUSY|BUDGET|LIMIT/.test(e.message)?429:400;
    reply(res,code,{error:e.message.slice(0,300)});
  }
});
app.requestTimeout=120000;app.headersTimeout=15000;
app.listen(port,'0.0.0.0',()=>console.log('OPENREEL_CLOUD_READY',port));
async function stop(){await queue.stop();app.close();setTimeout(()=>process.exit(0),6000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
