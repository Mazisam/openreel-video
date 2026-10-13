import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.mjs';
import { editProject } from './project.mjs';
import { download, MAX_MEDIA_BYTES } from './media.mjs';
const renderer=fileURLToPath(new URL('./render.py',import.meta.url));
const analyzer=fileURLToPath(new URL('./analyze.py',import.meta.url));
function canonical(v) {return v&&typeof v==='object' ? Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
export function requestHash(value) {return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
export function signedPath(id,key,seconds=3600) {
  const exp=Math.floor(Date.now()/1000)+Math.min(3600,Math.max(60,seconds));
  const sig=createHmac('sha256',key).update(id+':'+exp).digest('hex');
  return '/outputs/'+id+'.mp4?exp='+exp+'&sig='+sig;
}
export function verifyLink(id,exp,sig,key) {
  if(!/^[0-9]{10}$/.test(exp||'') || Number(exp)<Math.floor(Date.now()/1000) || Number(exp)>Math.floor(Date.now()/1000)+3600 || !/^[0-9a-f]{64}$/.test(sig||'')) return false;
  return timingSafeEqual(Buffer.from(sig,'hex'),createHmac('sha256',key).update(id+':'+exp).digest());
}
export async function runPython(args,signal,onProgress=()=>{},script=renderer) {
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',[script,...args],{detached:true,stdio:['ignore','pipe','pipe']});
    let out='',error='',partial='',killTimer;
    const terminate=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{} killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},3000);killTimer.unref();};
    if(signal?.aborted) terminate(); else signal?.addEventListener('abort',terminate,{once:true});
    child.stdout.on('data',chunk=>{
      out=(out+chunk).slice(-100000); partial+=chunk;
      while(partial.includes('\n')) {const end=partial.indexOf('\n');const line=partial.slice(0,end);partial=partial.slice(end+1);try{const event=JSON.parse(line);if(Number.isFinite(event.progress)) onProgress(event.progress);}catch{}}
      if(partial.length>100000) partial='';
    });
    child.stderr.on('data',chunk=>error=(error+chunk).slice(-4000));
    child.on('error',reject);
    child.on('close',code=>{clearTimeout(killTimer);signal?.removeEventListener('abort',terminate);
      if(signal?.aborted) reject(new Error('JOB_ABORTED'));
      else if(code!==0) {const e=new Error('RENDER_OR_PROBE_FAILED');e.detail=error;reject(e);}
      else {try{resolve(JSON.parse(out.trim().split('\n').at(-1)));}catch{reject(new Error('WORKER_REPLY_INVALID'));}}
    });
  });
}
export const ARTIFACT_NAME=/^[a-z0-9]{1,16}(\.[a-z0-9]{1,16})?\.(json|jpg)$/;
export async function artifactNames(store,id) {
  const prefix=id+'.';
  return (await fs.readdir(join(store.root,'outputs'))).filter(n=>n.startsWith(prefix)&&n.length>prefix.length&&ARTIFACT_NAME.test(n.slice(prefix.length))).map(n=>n.slice(prefix.length)).sort();
}
export class Queue {
  constructor(store,config) {this.store=store;this.config=config;this.jobs=new Map();this.active=null;this.stopping=false;this.admission=Promise.resolve();}
  trimFinished(job) {
    if(!['queued','running'].includes(job.status)) {
      delete job.snapshot;
      if(job.kind==='upload') job.input={uploaded_id:job.input?.uploaded_id};
      else delete job.input;
    }
    return job;
  }
  async init() {
    for(const job of await this.store.list('jobs')) {
      if(job.status==='running') {
        job.status='interrupted';job.error='SERVER_RESTARTED: inspect the project revision before resubmitting';job.finished_at=new Date().toISOString();
        const asset=job.working_media_id||job.input?.uploaded_id;
        if(asset) {
          try {const record=await this.store.read('projects',job.project_id);
            if(!record.project.mediaLibrary.items.some(m=>m.id===asset)) await fs.unlink(this.store.path('media',asset,'.bin')).catch(()=>{});
          } catch {} // Preserve the file if project state is unavailable/corrupt.
        }
        if(job.kind==='render') await fs.unlink(this.store.path('outputs',job.id,'.mp4')).catch(()=>{});
        if(['analyze','qa'].includes(job.kind)) await this.dropArtifacts(job.id);
        await this.store.write('jobs',job.id,job);
      }
      this.jobs.set(job.id,this.trimFinished(job));
    }
    this.kick();
  }
  async enqueue(body) {
    const previous=this.admission;let release;
    this.admission=new Promise(r=>release=r);await previous;
    try {
      validate('job',body);validate(body.kind,body.input);
      if(this.stopping) throw new Error('SERVICE_STOPPING');
      const hash=requestHash(body);
      for(const job of this.jobs.values()) if(job.idempotency_key===body.idempotency_key) {
        if(job.request_hash!==hash) throw new Error('IDEMPOTENCY_CONFLICT');
        return this.view(job);
      }
      if([...this.jobs.values()].filter(j=>['running','queued'].includes(j.status)).length>=32) throw new Error('QUEUE_FULL');
      if(this.jobs.size>=5000) throw new Error('JOB_HISTORY_LIMIT');
      await this.store.diskBudget(2*1024**2);
      const record=await this.store.read('projects',body.project_id);
      if(['edit','render'].includes(body.kind) && body.expected_revision!==record.revision) throw new Error('REVISION_CONFLICT');
      if(body.kind==='analyze') {
        const media=record.project.mediaLibrary.items.find(m=>m.id===body.input.media_id);
        if(!media) throw new Error('MEDIA_NOT_FOUND');
        if(media.type!=='video') throw new Error('SOURCE_NOT_VIDEO');
      }
      if(body.kind==='qa') {
        const source=this.jobs.get(body.input.render_job_id);
        if(!source||source.kind!=='render'||source.project_id!==body.project_id) throw new Error('RENDER_JOB_NOT_FOUND');
        if(source.status!=='completed') throw new Error('RENDER_NOT_COMPLETED');
      }
      const id=randomUUID();
      const job={id,...body,request_hash:hash,status:'queued',progress:0,created_at:new Date().toISOString()};
      if(body.kind==='render') job.snapshot=structuredClone(record);
      await this.store.write('jobs',id,job);this.jobs.set(id,job);this.kick();return this.view(job);
    } finally {release();}
  }
  async enqueueUpload(projectID,id,name,key,digest,size) {
    const previous=this.admission;let release;
    this.admission=new Promise(r=>release=r);await previous;
    try {
      if(this.stopping) throw new Error('SERVICE_STOPPING');
      if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(key||'')) throw new Error('INVALID_IDEMPOTENCY_KEY');
      const hash=requestHash({kind:'upload',project_id:projectID,name,digest,size});
      for(const old of this.jobs.values()) if(old.idempotency_key===key) {
        if(old.request_hash!==hash) throw new Error('IDEMPOTENCY_CONFLICT');
        await fs.unlink(this.store.path('media',id,'.bin'));
        return this.view(old);
      }
      if(this.jobs.size>=5000 || [...this.jobs.values()].filter(j=>['running','queued'].includes(j.status)).length>=32) throw new Error('QUEUE_FULL');
      await this.store.read('projects',projectID);
      const job={id:randomUUID(),project_id:projectID,kind:'upload',input:{uploaded_id:id,name},idempotency_key:key,request_hash:hash,status:'queued',progress:0,created_at:new Date().toISOString()};
      await this.store.write('jobs',job.id,job);this.jobs.set(job.id,job);this.kick();return this.view(job);
    } finally {release();}
  }
  view(job) {
    const result={id:job.id,kind:job.kind,project_id:job.project_id,status:job.status,progress:job.progress,status_url:this.config.publicURL+'/api/jobs/'+job.id,created_at:job.created_at,started_at:job.started_at,finished_at:job.finished_at,error:job.error,result:job.result};
    if(job.status==='completed'&&job.kind==='render') {result.output_url=this.config.publicURL+signedPath(job.id,this.config.signingKey);result.link_expires_in_seconds=3600;}
    return result;
  }
  get(id) {const job=this.jobs.get(id);if(!job)throw new Error('NOT_FOUND');return this.view(job);}
  async cancel(id) {
    const job=this.jobs.get(id);if(!job)throw new Error('NOT_FOUND');
    if(job.status==='queued') {job.status='cancelled';job.finished_at=new Date().toISOString();await this.store.write('jobs',id,job);
      if(job.kind==='upload')await fs.unlink(this.store.path('media',job.input.uploaded_id,'.bin')).catch(()=>{});
      this.trimFinished(job);
    }
    if(this.active?.id===id) {job.cancel_requested=true;this.active.controller.abort();}
    return this.view(job);
  }
  kick() {if(!this.active&&!this.stopping) setImmediate(()=>this.drain().catch(e=>console.error('QUEUE_ERROR',e.message)));}
  async drain() {
    if(this.active||this.stopping)return;
    const job=[...this.jobs.values()].find(j=>j.status==='queued');if(!job)return;
    const controller=new AbortController();this.active={id:job.id,controller};
    const timer=setTimeout(()=>controller.abort(),this.config.maxJobMs);timer.unref();
    job.status='running';job.started_at=new Date().toISOString();
    try {
      await this.store.write('jobs',job.id,job);
      if(job.kind==='import') job.result=await this.importMedia(job,controller.signal);
      if(job.kind==='upload') {
        const path=this.store.path('media',job.input.uploaded_id,'.bin');
        const meta=await runPython(['--probe',path],controller.signal);
        job.result=await this.registerMedia(job.project_id,job.input.uploaded_id,meta,job.input.name);
      }
      if(job.kind==='edit') {
        const record=await this.store.read('projects',job.project_id);
        if(record.revision!==job.expected_revision) throw new Error('REVISION_CONFLICT');
        const edited=await editProject(record.project,job.input.actions);
        record.project=edited.project;record.revision++;
        await this.store.write('projects',job.project_id,record);
        job.result={revision:record.revision,actions:edited.results};
      }
      if(job.kind==='render') job.result=await this.render(job,controller.signal);
      if(job.kind==='analyze') job.result=await this.analyze(job,controller.signal);
      if(job.kind==='qa') job.result=await this.qa(job,controller.signal);
      if(controller.signal.aborted) throw new Error('JOB_ABORTED');
      job.status='completed';job.progress=100;
    } catch(e) {
      job.status=this.stopping?'interrupted':job.cancel_requested?'cancelled':'failed';
      job.error=controller.signal.aborted?(this.stopping?'SERVER_STOPPING':job.cancel_requested?'JOB_CANCELLED':'JOB_TIMEOUT'):
        /^[A-Z_]+(:|$)/.test(e.message)?e.message.slice(0,250):'JOB_FAILED';
      const known=e.detail?.trim().match(/^(UNSUPPORTED_[A-Za-z_]+|SOURCE_[A-Z_]+|INVALID_[A-Z_]+|MAX_[A-Z0-9_]+|MEDIA_[A-Z_]+|ANALYSIS_[A-Z_]+|PROBE_[A-Z_]+|LOUDNESS_[A-Z_]+)\b/);
      if(known&&!controller.signal.aborted) job.error=known[1];
      if(e.detail) await fs.writeFile(this.store.path('temp',job.id,'.diagnostic.txt'),e.detail,{mode:0o600}).catch(()=>{});
      if(job.kind==='render') await fs.unlink(this.store.path('outputs',job.id,'.mp4')).catch(()=>{});
      if(['analyze','qa'].includes(job.kind)) await this.dropArtifacts(job.id);
      if(job.kind==='upload') await fs.unlink(this.store.path('media',job.input.uploaded_id,'.bin')).catch(()=>{});
    } finally {
      clearTimeout(timer);job.finished_at=new Date().toISOString();
      await this.store.write('jobs',job.id,job);
      this.trimFinished(job);
      this.active=null;this.kick();
    }
  }
  async importMedia(job,signal) {
    await this.store.diskBudget(MAX_MEDIA_BYTES);
    const id=randomUUID(),path=this.store.path('media',id,'.bin');
    job.working_media_id=id;await this.store.write('jobs',job.id,job);
    try {
      const controller=new AbortController();const deadline=setTimeout(()=>controller.abort(),60000);deadline.unref();
      try {await download(job.input.url,path,this.config.allowlist,AbortSignal.any([signal,controller.signal]));}finally{clearTimeout(deadline);}
      const meta=await runPython(['--probe',path],signal);
      return await this.registerMedia(job.project_id,id,meta,job.input.name||'Media');
    } catch(e) {await fs.unlink(path).catch(()=>{});throw e;}
  }
  async registerMedia(projectID,id,meta,name) {
    const record=await this.store.read('projects',projectID);
    if(record.project.mediaLibrary.items.length>=100) throw new Error('MEDIA_COUNT_LIMIT');
    const media={id,name,type:meta.type,fileHandle:null,blob:null,metadata:{...meta,frameRate:0},thumbnailUrl:null,waveformData:null};
    record.project.mediaLibrary.items.push(media);record.project.modifiedAt=Date.now();record.revision++;
    await this.store.write('projects',projectID,record);
    return {media_id:id,metadata:meta,revision:record.revision};
  }
  async render(job,signal) {
    await this.store.diskBudget(512*1024**2);
    const record=job.snapshot,assets={};
    for(const media of record.project.mediaLibrary.items) assets[media.id]={path:this.store.path('media',media.id,'.bin'),metadata:media.metadata};
    const manifest=this.store.path('temp',job.id,'.manifest.json'),output=this.store.path('outputs',job.id,'.mp4');
    await fs.writeFile(manifest,JSON.stringify({project:record.project,assets,output,crf:job.input.crf??22,caption_style:job.input.caption_style,loudnorm:job.input.loudnorm}),{mode:0o600});
    try {
      const rendered=await runPython([manifest],signal,progress=>job.progress=progress);
      return {project_revision:record.revision,metadata:rendered.metadata,bytes:(await fs.stat(output)).size,renderer:'ffmpeg-openreel-subset',postprocess:rendered.postprocess||{}};
    } finally {await fs.unlink(manifest).catch(()=>{});await fs.unlink(output.replace(/\.mp4$/,'.ass')).catch(()=>{});await fs.unlink(output.replace(/\.mp4$/,'.norm.mp4')).catch(()=>{});}
  }
  async dropArtifacts(id) {for(const name of await artifactNames(this.store,id).catch(()=>[])) await fs.unlink(join(this.store.root,'outputs',id+'.'+name)).catch(()=>{});}
  async runAnalysis(job,signal,flag,manifest) {
    const file=this.store.path('temp',job.id,'.manifest.json');
    await fs.writeFile(file,JSON.stringify(manifest),{mode:0o600});
    try {return await runPython([flag,file],signal,p=>job.progress=Math.min(99,p),analyzer);}
    finally {await fs.unlink(file).catch(()=>{});}
  }
  async analyze(job,signal) {
    await this.store.diskBudget(64*1024**2);
    const record=await this.store.read('projects',job.project_id);
    const media=record.project.mediaLibrary.items.find(m=>m.id===job.input.media_id);
    if(!media) throw new Error('MEDIA_NOT_FOUND');
    const path=this.store.path('media',media.id,'.bin');
    const result=await this.runAnalysis(job,signal,'--analyze',{path,out_prefix:this.store.path('outputs',job.id,''),frames:job.input.frames,asr:job.input.asr});
    return {media_id:media.id,project_revision:record.revision,summary:result.summary,artifacts:await artifactNames(this.store,job.id),engine:'hermes-cloud-analyze-0.2.0'};
  }
  async qa(job,signal) {
    await this.store.diskBudget(64*1024**2);
    const source=this.jobs.get(job.input.render_job_id);
    if(!source||source.kind!=='render'||source.status!=='completed') throw new Error('RENDER_NOT_COMPLETED');
    const result=await this.runAnalysis(job,signal,'--qa',{path:this.store.path('outputs',source.id,'.mp4'),out_prefix:this.store.path('outputs',job.id,''),
      expect:job.input.expect,plan:job.input.plan,frames_at:job.input.frames_at});
    return {render_job_id:source.id,summary:result.summary,verdict:result.summary.verdict,artifacts:await artifactNames(this.store,job.id),engine:'hermes-cloud-qa-0.2.0'};
  }
  async stop() {this.stopping=true;this.active?.controller.abort();}
  async remove(id) {
    const job=this.jobs.get(id);if(!job)throw new Error('NOT_FOUND');
    if(['running','queued'].includes(job.status)) throw new Error('JOB_IS_ACTIVE');
    for(const [dir,ext] of [['jobs','.json'],['outputs','.mp4'],['temp','.diagnostic.txt']]) await fs.unlink(this.store.path(dir,id,ext)).catch(()=>{});
    await this.dropArtifacts(id);
    this.jobs.delete(id);
    return {deleted:id};
  }
  async deleteProject(id) {
    const previous=this.admission;let release;
    this.admission=new Promise(r=>release=r);await previous;
    try {
    const record=await this.store.read('projects',id);
    const jobs=[...this.jobs.values()].filter(j=>j.project_id===id);
    if(jobs.some(j=>['running','queued'].includes(j.status))) throw new Error('JOB_IS_ACTIVE');
    for(const job of jobs) await this.remove(job.id);
    for(const item of record.project.mediaLibrary.items) await fs.unlink(this.store.path('media',item.id,'.bin')).catch(()=>{});
    await fs.unlink(this.store.path('projects',id));
    return {deleted_project:id};
    } finally {release();}
  }
}
