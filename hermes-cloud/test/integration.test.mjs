import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const ff=(args)=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{timeout:20000});
const baseDir=new URL('../',import.meta.url).pathname;

test('HTTP + official MCP client + upload + actual MP4 + idempotency + cancellation',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'openreel-e2e-'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const token=randomBytes(32).toString('hex');
  const url='http://127.0.0.1:'+port;
  const env={...process.env,PORT:String(port),DATA_DIR:root,OPENREEL_SERVICE_TOKEN:token,OUTPUT_SIGNING_KEY:randomBytes(32).toString('hex'),PUBLIC_BASE_URL:url,RENDER_LOCATION:'cloud'};
  let logs='';let processServer;
  function start(){processServer=spawn('node',['dist/server.mjs'],{cwd:baseDir,env,stdio:['ignore','pipe','pipe']});processServer.stdout.on('data',s=>logs+=s);processServer.stderr.on('data',s=>logs+=s);}
  start();
  t.after(async()=>{processServer.kill('SIGTERM');await delay(500);if(processServer.exitCode===null) processServer.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});});
  async function ready(){for(let i=0;i<100;i++){try{if((await fetch(url+'/health')).ok)return;}catch{}if(processServer.exitCode!==null)throw new Error(logs);await delay(50);}throw new Error('server not ready '+logs);}
  await ready();
  const api=async(method,path,data)=>{
    const r=await fetch(url+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:r.status,data:await r.json()};
  };
  async function wait(id){for(let i=0;i<400;i++){const j=(await api('GET','/api/jobs/'+id)).data;if(!['queued','running'].includes(j.status))return j;await delay(50);}throw new Error('job timeout');}
  await t.test('API rejects missing credentials',async()=>assert.equal((await fetch(url+'/api/projects')).status,401));
  const client=new Client({name:'hermes-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  t.after(()=>client.close());
  await t.test('official MCP handshake and tools call work',async()=>{
    assert.equal((await client.listTools()).tools.length,6);
    const result=await client.callTool({name:'openreel_capabilities',arguments:{}});assert.equal(JSON.parse(result.content[0].text).llm_calls,0);
  });
  const record=(await api('POST','/api/projects',{name:'SAAM E2E',width:320,height:180,frameRate:24})).data;
  const id=record.project.id;
  const video=join(root,'source.mp4'),image=join(root,'blue.png');
  ff(['-f','lavfi','-i','color=red:s=160x90:r=24:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
  ff(['-f','lavfi','-i','color=blue:s=160x90','-frames:v','1','-threads','1',image]);
  const upload=async(file,key)=>{
    const r=await fetch(url+'/api/media/upload?project_id='+id+'&name='+encodeURIComponent(file.split('/').at(-1)),{method:'POST',headers:{Authorization:'Bearer '+token,'Idempotency-Key':key,'Content-Type':'application/octet-stream'},body:await fs.readFile(file)});
    const j=await r.json();assert.equal(r.status,202,JSON.stringify(j));return wait(j.id);
  };
  const media1=await upload(video,'upload-video-001'),media2=await upload(image,'upload-image-001');
  assert.equal(media1.status,'completed',JSON.stringify(media1));assert.equal(media2.status,'completed',JSON.stringify(media2));
  await t.test('upload repeats are idempotent',async()=>assert.equal((await upload(image,'upload-image-001')).id,media2.id));
  const editBody={kind:'edit',project_id:id,idempotency_key:'edit-project-001',expected_revision:2,input:{actions:[
    {type:'track/add',params:{trackType:'video',trackId:'base',name:'Footage'}},
    {type:'track/add',params:{trackType:'image',trackId:'overlay',position:0,name:'Logo'}},
    {type:'clip/add',params:{trackId:'base',mediaId:media1.result.media_id,clipId:'red',startTime:0,duration:2,inPoint:.5}},
    {type:'clip/add',params:{trackId:'overlay',mediaId:media2.result.media_id,clipId:'blue',startTime:1,duration:.6,transform:{scale:{x:.25,y:.25}}}},
    {type:'audio/setVolume',params:{clipId:'red',volume:.25}},
    {type:'audio/setFade',params:{clipId:'red',fadeIn:.1,fadeOut:.1}},
    {type:'subtitle/add',params:{text:'SAAM',startTime:0,endTime:.7}},
    {type:'subtitle/add',params:{text:'سامیـار',startTime:.7,endTime:.95}},
  ]}};
  const edit=await wait((await api('POST','/api/jobs',editBody)).data.id);
  assert.equal(edit.status,'completed',JSON.stringify(edit));
  await t.test('stale edits are rejected before submission',async()=>assert.equal((await api('POST','/api/jobs',{...editBody,idempotency_key:'edit-conflict-002'})).status,409));
  const renderBody={kind:'render',project_id:id,idempotency_key:'render-project-001',expected_revision:3,input:{crf:22}};
  const submit=await api('POST','/api/jobs',renderBody);assert.equal(submit.status,202,JSON.stringify(submit.data));
  const duplicate=await api('POST','/api/jobs',renderBody);assert.equal(duplicate.data.id,submit.data.id);
  const rendered=await wait(submit.data.id);
  assert.equal(rendered.status,'completed',JSON.stringify(rendered));
  const output=join(root,'checked.mp4');const download=await fetch(rendered.output_url);assert.equal(download.status,200);await fs.writeFile(output,Buffer.from(await download.arrayBuffer()));
  await t.test('MP4 contains timed video overlay, captions and audio',async()=>{
    assert.equal(rendered.result.metadata.codec,'h264');assert.equal(rendered.result.metadata.width,320);assert.equal(rendered.result.metadata.hasAudio,true);assert.ok(Math.abs(rendered.result.metadata.duration-2)<.15);
    const pixel=time=>execFileSync('ffmpeg',['-v','error','-ss',String(time),'-i',output,'-vf','crop=2:2:160:90','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{timeout:10000});
    const before=pixel(.4),overlay=pixel(1.25),after=pixel(1.8);
    assert.ok(before[0]>180&&before[2]<80,`red start ${before}`);assert.ok(overlay[2]>180&&overlay[0]<80,`blue overlay ${overlay}`);assert.ok(after[0]>180&&after[2]<80,`red end ${after}`);
    const audio=execFileSync('ffmpeg',['-v','error','-i',output,'-vn','-t','1','-f','s16le','-ac','1','pipe:1']);assert.ok(audio.some(byte=>byte!==0));
    const imageFrame=execFileSync('ffmpeg',['-v','error','-ss','0.3','-i',output,'-vf','crop=320:60:0:120','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
    let white=0;for(let i=0;i<imageFrame.length;i+=3) if(imageFrame[i]>180&&imageFrame[i+1]>180&&imageFrame[i+2]>180)white++;assert.ok(white>10,'subtitles must be visibly rendered');
  });
  await t.test('signed outputs deny modified signature',async()=>{
    const bad=new URL(rendered.output_url);bad.searchParams.set('sig','0'.repeat(64));assert.equal((await fetch(bad)).status,403);
  });
  await t.test('same key with different payload is rejected',async()=>assert.equal((await api('POST','/api/jobs',{...renderBody,input:{crf:28}})).status,409));
  await client.close();
  await t.test('job results and deduplication survive service restart',async()=>{
    processServer.kill('SIGTERM');await new Promise(r=>processServer.once('exit',r));start();await ready();
    const again=(await api('POST','/api/jobs',renderBody)).data;assert.equal(again.id,rendered.id);assert.equal(again.status,'completed');
  });
  const longRecord=(await api('POST','/api/projects',{name:'Cancel',width:1280,height:720})).data;
  const lid=longRecord.project.id;
  // Registered media belongs to this project too; copy only this local test fixture's metadata.
  const longFile=join(root,'projects',lid+'.json');const local=JSON.parse(await fs.readFile(longFile));
  local.project.mediaLibrary.items=[{...record.project.mediaLibrary.items[0],id:media2.result.media_id,type:'image',name:'Blue',metadata:media2.result.metadata}];
  await fs.writeFile(longFile,JSON.stringify(local));
  const le=await api('POST','/api/jobs',{kind:'edit',project_id:lid,idempotency_key:'cancel-edit-001',expected_revision:0,input:{actions:[{type:'track/add',params:{trackType:'image',trackId:'long'}},{type:'clip/add',params:{trackId:'long',mediaId:media2.result.media_id,startTime:0,duration:60}}]}});
  assert.equal((await wait(le.data.id)).status,'completed');
  const lr=(await api('POST','/api/jobs',{kind:'render',project_id:lid,idempotency_key:'cancel-render-001',expected_revision:1,input:{}})).data;
  await delay(50);await api('POST','/api/jobs/'+lr.id+'/cancel');
  await t.test('cancellation kills actual renderer and removes partial output',async()=>{
    const cancelled=await wait(lr.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.output_url,undefined);
    await assert.rejects(fs.stat(join(root,'outputs',lr.id+'.mp4')));
  });
  await t.test('completed render cleanup removes output and job metadata',async()=>{
    assert.equal((await api('DELETE','/api/jobs/'+rendered.id)).status,200);
    assert.equal((await api('GET','/api/jobs/'+rendered.id)).status,404);
    await assert.rejects(fs.stat(join(root,'outputs',rendered.id+'.mp4')));
  });
});
