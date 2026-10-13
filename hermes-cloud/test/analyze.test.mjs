import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const ff=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{timeout:60000});
const baseDir=new URL('../',import.meta.url).pathname;

test('analysis, caption style, loudness normalisation and QA on synthetic media',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'openreel-analyze-'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const token=randomBytes(32).toString('hex'),url='http://127.0.0.1:'+port;
  const env={...process.env,PORT:String(port),DATA_DIR:root,OPENREEL_SERVICE_TOKEN:token,OUTPUT_SIGNING_KEY:randomBytes(32).toString('hex'),PUBLIC_BASE_URL:url,RENDER_LOCATION:'cloud'};
  delete env.ASR_ENGINE;
  let logs='';const server=spawn('node',['dist/server.mjs'],{cwd:baseDir,env,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',s=>logs+=s);server.stderr.on('data',s=>logs+=s);
  t.after(async()=>{server.kill('SIGTERM');await delay(400);if(server.exitCode===null)server.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});});
  for(let i=0;i<100;i++){try{if((await fetch(url+'/health')).ok)break;}catch{}if(server.exitCode!==null)throw new Error(logs);await delay(50);}
  const api=async(method,path,data)=>{const r=await fetch(url+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
  const wait=async id=>{for(let i=0;i<600;i++){const j=(await api('GET','/api/jobs/'+id)).data;if(!['queued','running'].includes(j.status))return j;await delay(100);}throw new Error('job timeout');};

  // 6 s landscape clip: dark-blue scene then yellow scene (large luma step); tone, 1.5 s of true silence, tone; deliberately quiet.
  const source=join(root,'source.mp4');
  ff(['-f','lavfi','-i','color=0x2050a0:s=400x300:r=24:d=2.5','-f','lavfi','-i','color=0xf0e060:s=400x300:r=24:d=3.5',
      '-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=6',
      '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0,noise=alls=12:allf=t[v];[2:a]volume=0.3,volume=enable=\'between(t,2,3.5)\':volume=0[a]',
      '-map','[v]','-map','[a]','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',source]);
  const project=(await api('POST','/api/projects',{name:'Analyze',width:360,height:640,frameRate:30})).data.project.id;
  const up=await fetch(url+'/api/media/upload?project_id='+project+'&name=source.mp4',{method:'POST',headers:{Authorization:'Bearer '+token,'Idempotency-Key':'analyze-upload-01','Content-Type':'application/octet-stream'},body:await fs.readFile(source)});
  const uploaded=await wait((await up.json()).id);assert.equal(uploaded.status,'completed',JSON.stringify(uploaded));
  const mediaID=uploaded.result.media_id;

  const analyzeBody={kind:'analyze',project_id:project,idempotency_key:'analyze-run-0001',input:{media_id:mediaID,frames:{max:10,width:240}}};
  const submitted=await api('POST','/api/jobs',analyzeBody);assert.equal(submitted.status,202,JSON.stringify(submitted.data));
  assert.equal((await api('POST','/api/jobs',analyzeBody)).data.id,submitted.data.id);
  const analysed=await wait(submitted.data.id);assert.equal(analysed.status,'completed',JSON.stringify(analysed));
  let analysis;
  await t.test('analysis.json carries real measurements and never invents a transcript',async()=>{
    assert.ok(analysed.result.artifacts.includes('analysis.json'));
    const list=await api('GET','/api/jobs/'+analysed.id+'/artifacts');assert.equal(list.status,200);
    analysis=await (await fetch(url+'/api/jobs/'+analysed.id+'/artifacts/analysis.json',{headers:{Authorization:'Bearer '+token}})).json();
    assert.equal(analysis.schema_version,1);
    assert.ok(Math.abs(analysis.source.duration-6)<.2);assert.equal(analysis.source.display_width,400);assert.equal(analysis.source.has_audio,true);
    assert.ok(analysis.scenes.some(s=>Math.abs(s-2.5)<.3),'scene cut near 2.5 s: '+analysis.scenes);
    assert.ok(analysis.audio.silences.some(s=>s.start>1.8&&s.start<2.3&&s.duration>1),JSON.stringify(analysis.audio.silences));
    assert.equal(analysis.audio.status,'ok');assert.ok(analysis.audio.integrated_lufs<-30,'source is quiet: '+analysis.audio.integrated_lufs);
    assert.equal(analysis.transcript.status,'unavailable');assert.equal(analysis.transcript.segments,undefined);
    assert.ok(analysis.frames.length>=4&&analysis.frames.length<=10);
    const jpg=await fetch(url+'/api/jobs/'+analysed.id+'/artifacts/'+analysis.frames[0].file,{headers:{Authorization:'Bearer '+token}});
    assert.equal(jpg.headers.get('content-type'),'image/jpeg');assert.equal((await jpg.arrayBuffer()).byteLength,analysis.frames[0].bytes);
  });
  await t.test('artifacts need credentials and reject traversal and unknown names',async()=>{
    assert.equal((await fetch(url+'/api/jobs/'+analysed.id+'/artifacts/analysis.json')).status,401);
    assert.equal((await api('GET','/api/jobs/'+analysed.id+'/artifacts/..%2Fsecret.json')).status,404);
    assert.equal((await api('GET','/api/jobs/'+analysed.id+'/artifacts/missing.json')).status,404);
  });
  await t.test('analysis rejects non-video media and unknown media ids',async()=>{
    const bad=await api('POST','/api/jobs',{...analyzeBody,idempotency_key:'analyze-run-0002',input:{media_id:'11111111-1111-4111-8111-111111111111'}});
    assert.equal(bad.status,400);assert.match(bad.data.error,/MEDIA_NOT_FOUND/);
    const noInput=await api('POST','/api/jobs',{...analyzeBody,idempotency_key:'analyze-run-0003',input:{media_id:mediaID,asr:{engine:'shell'}}});
    assert.equal(noInput.status,400);
  });

  // Edit: keep 0.5-5.5 s, cover-crop to portrait, Persian + English captions.
  const edit=await wait((await api('POST','/api/jobs',{kind:'edit',project_id:project,idempotency_key:'analyze-edit-01',expected_revision:1,input:{actions:[
    {type:'track/add',params:{trackType:'video',trackId:'v'}},
    {type:'clip/add',params:{trackId:'v',mediaId:mediaID,clipId:'main',startTime:0,duration:5,inPoint:.5,transform:{fitMode:'cover'}}},
    {type:'audio/setFade',params:{clipId:'main',fadeIn:.05,fadeOut:.1}},
    {type:'subtitle/add',params:{text:'سلام، من یک معلم زبان هستم',startTime:.2,endTime:2}},
    {type:'subtitle/add',params:{text:'Learn English with Maziyar',startTime:2.2,endTime:4.5}},
  ]}})).data.id);assert.equal(edit.status,'completed',JSON.stringify(edit));
  const renderBody={kind:'render',project_id:project,idempotency_key:'analyze-render-1',expected_revision:edit.result.revision,input:{crf:23,
    caption_style:{font:'DejaVu Sans',size_pct:4.5,margin_v_pct:22,position:'bottom',color:'#FFFFFF',outline_color:'#101010',bold:true},
    loudnorm:{target_lufs:-14,true_peak_dbtp:-1}}};
  const rendered=await wait((await api('POST','/api/jobs',renderBody)).data.id);assert.equal(rendered.status,'completed',JSON.stringify(rendered));
  const out=join(root,'checked.mp4');await fs.writeFile(out,Buffer.from(await (await fetch(rendered.output_url)).arrayBuffer()));
  if(process.env.SAVE_FRAMES_DIR){await fs.mkdir(process.env.SAVE_FRAMES_DIR,{recursive:true});
    for(const [name,time] of [['fa',1],['en',3.5]]) ff(['-ss',String(time),'-i',out,'-frames:v','1',join(process.env.SAVE_FRAMES_DIR,'caption-'+name+'.png')]);}
  await t.test('render reports measured loudness before and after the second pass',()=>{
    const ln=rendered.result.postprocess.loudnorm;assert.equal(ln.applied,true);
    assert.ok(ln.before.integrated_lufs<-30,'before '+ln.before.integrated_lufs);
    assert.ok(Math.abs(ln.after.integrated_lufs+14)<=1.5,'after '+JSON.stringify(ln.after));
    assert.ok(ln.after.true_peak_dbtp<=-1,'true peak '+ln.after.true_peak_dbtp);
  });
  await t.test('cover framing fills the portrait frame and captions are drawn inside the lower safe area',()=>{
    const raw=(time,crop)=>execFileSync('ffmpeg',['-v','error','-ss',String(time),'-i',out,'-vf','crop='+crop,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
    for(const crop of ['2:2:2:2','2:2:356:634']){const px=raw(1,crop);assert.ok(px[2]>130&&px[0]<80,'cover must fill the whole frame with the blue scene, got '+px.slice(0,3)+' at '+crop);}
    const whiteIn=(time,crop)=>{const b=raw(time,crop);let n=0;for(let i=0;i<b.length;i+=3)if(b[i]>200&&b[i+1]>200&&b[i+2]>200)n++;return n;};
    assert.ok(whiteIn(1,'360:120:0:380')>150,'Persian caption must be visible at the lower-third');
    assert.equal(whiteIn(1,'360:100:0:540'),0,'nothing in the reel UI zone (bottom 15%)');
    assert.ok(whiteIn(3.5,'360:120:0:380')>150,'English caption must be visible');
  });

  const qaBody={kind:'qa',project_id:project,idempotency_key:'analyze-qa-0001',input:{render_job_id:rendered.id,expect:{width:360,height:640,duration:5},frames_at:[0.5,2.5,4.5]}};
  const qa=await wait((await api('POST','/api/jobs',qaBody)).data.id);assert.equal(qa.status,'completed',JSON.stringify(qa));
  await t.test('QA report gives evidence per check and a verdict',async()=>{
    const report=await (await fetch(url+'/api/jobs/'+qa.id+'/artifacts/qa.json',{headers:{Authorization:'Bearer '+token}})).json();
    const by=Object.fromEntries(report.checks.map(c=>[c.id,c]));
    for(const id of ['decode','container','dimensions','duration','av_sync','audio_level'])assert.equal(by[id].status,'pass',id+' '+JSON.stringify(by[id]));
    assert.ok(by.silence.evidence.intervals.length>=1,'the 1.5 s gap must be reported as evidence');
    assert.equal(report.frames.length,3);assert.ok(['qa_passed','needs_review','qa_failed'].includes(report.verdict));
    assert.equal(report.verdict,'needs_review','unplanned silence is a warning, not an automatic rejection');
  });
  await t.test('QA flags a wrong expectation as qa_failed',async()=>{
    const bad=await wait((await api('POST','/api/jobs',{...qaBody,idempotency_key:'analyze-qa-0002',input:{...qaBody.input,expect:{width:720,height:1280,duration:9}}})).data.id);
    const report=await (await fetch(url+'/api/jobs/'+bad.id+'/artifacts/qa.json',{headers:{Authorization:'Bearer '+token}})).json();
    assert.equal(report.verdict,'qa_failed');assert.equal(bad.result.verdict,'qa_failed');
  });
  await t.test('deleting a job removes its artifacts',async()=>{
    assert.equal((await api('DELETE','/api/jobs/'+analysed.id)).status,200);
    const left=(await fs.readdir(join(root,'outputs'))).filter(n=>n.startsWith(analysed.id));assert.deepEqual(left,[]);
  });
  await t.test('capabilities describe the analysis engine honestly',async()=>{
    const caps=(await api('GET','/api/capabilities')).data;assert.equal(caps.version,'0.2.0');assert.equal(caps.analysis.asr.available,false);
  });
});

test('transcript plumbing: engine output is normalised with word ids and low-confidence flags',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'openreel-asr-'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const token=randomBytes(32).toString('hex'),url='http://127.0.0.1:'+port;
  const env={...process.env,PORT:String(port),DATA_DIR:root,OPENREEL_SERVICE_TOKEN:token,OUTPUT_SIGNING_KEY:randomBytes(32).toString('hex'),PUBLIC_BASE_URL:url,RENDER_LOCATION:'cloud',
    ASR_ENGINE:'module:fake_asr',PYTHONPATH:join(baseDir,'test/fixtures')};
  const server=spawn('node',['dist/server.mjs'],{cwd:baseDir,env,stdio:'ignore'});
  t.after(async()=>{server.kill('SIGTERM');await delay(400);if(server.exitCode===null)server.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});});
  for(let i=0;i<100;i++){try{if((await fetch(url+'/health')).ok)break;}catch{}await delay(50);}
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const api=async(m,p,d)=>{const r=await fetch(url+p,{method:m,headers,body:d===undefined?undefined:JSON.stringify(d)});return r.json();};
  const wait=async id=>{for(let i=0;i<300;i++){const j=await api('GET','/api/jobs/'+id);if(!['queued','running'].includes(j.status))return j;await delay(100);}throw new Error('timeout');};
  const clip=join(root,'c.mp4');
  ff(['-f','lavfi','-i','color=0x808080:s=160x90:r=24:d=2','-f','lavfi','-i','sine=frequency=300:duration=2','-vf','noise=alls=10:allf=t','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',clip]);
  const project=(await api('POST','/api/projects',{name:'ASR',width:360,height:640})).project.id;
  const up=await (await fetch(url+'/api/media/upload?project_id='+project+'&name=c.mp4',{method:'POST',headers:{Authorization:'Bearer '+token,'Idempotency-Key':'asr-upload-0001'},body:await fs.readFile(clip)})).json();
  const media=(await wait(up.id)).result.media_id;
  const job=await wait((await api('POST','/api/jobs',{kind:'analyze',project_id:project,idempotency_key:'asr-analyze-0001',input:{media_id:media,asr:{language:'fa'}}})).id);
  assert.equal(job.status,'completed',JSON.stringify(job));
  const analysis=await (await fetch(url+'/api/jobs/'+job.id+'/artifacts/analysis.json',{headers})).json();
  assert.equal(analysis.transcript.status,'ok');assert.equal(analysis.transcript.engine,'module:fake_asr');assert.equal(analysis.transcript.source,'asr');
  const [seg]=analysis.transcript.segments;assert.equal(seg.id,'s1');assert.deepEqual(seg.words.map(w=>w.id),['w1','w2']);
  assert.equal(seg.words[0].text,'سلام');assert.equal(seg.words[0].low_confidence,false);assert.equal(seg.words[1].low_confidence,true);
  assert.ok(analysis.transcript.warnings.length>0);
});
