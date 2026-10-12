import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject,editProject } from '../dist/project.mjs';
import { publicIPv4,hostAllowed,pinnedURL } from '../src/media.mjs';
import { Store,safeId } from '../src/storage.mjs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real OpenReel actions edit a project without browser globals',async()=>{
  assert.equal(typeof window,'undefined');
  let p=newProject({name:'Native'});
  p.mediaLibrary.items=[{id:'media',name:'Image',type:'image',metadata:{duration:0,width:160,height:90},blob:null,fileHandle:null,thumbnailUrl:null,waveformData:null}];
  const edited=await editProject(p,[{type:'track/add',params:{trackType:'image',trackId:'track'}},{type:'clip/add',params:{trackId:'track',mediaId:'media',clipId:'clip',startTime:0,duration:3}},{type:'clip/split',params:{clipId:'clip',time:1}},{type:'audio/setVolume',params:{clipId:'clip',volume:.2}}]);
  assert.equal(edited.project.timeline.tracks[0].clips.length,2);
  assert.equal(edited.project.timeline.tracks[0].clips[0].duration,1);
  assert.equal(edited.project.timeline.tracks[0].clips[0].volume,.2);
  assert.equal(p.timeline.tracks.length,0);
});
test('invalid batch leaves the original project unchanged',async()=>{
  const p=newProject({name:'Atomic'});
  await assert.rejects(editProject(p,[{type:'track/add',params:{trackType:'video'}},{type:'clip/move',params:{clipId:'missing',startTime:3}}]),/CLIP_NOT_FOUND/);
  assert.equal(p.timeline.tracks.length,0);
});
test('unsupported transforms and arbitrary commands are refused',async()=>{
  await assert.rejects(editProject(newProject({name:'Bounded'}),[{type:'shell/exec',params:{command:'ignored'}}]),/INVALID_ACTION/);
  await assert.rejects(editProject(newProject({name:'Bounded'}),[{type:'transform/update',params:{clipId:'clip',transform:{rotation:20}}}]),/INVALID_ACTION/);
});
test('SSRF denies local, private, reserved and metadata IPv4',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.0.1','0.0.0.0','100.64.0.1','198.18.0.1','::1']) assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('8.8.8.8'),true);
});
test('media host allowlist has strict wildcard boundaries',()=>{
  assert.equal(hostAllowed('cdn.example.com',['*.example.com']),true);
  assert.equal(hostAllowed('example.com.attacker.com',['*.example.com']),false);
  assert.equal(hostAllowed('example.com',['*.example.com']),false);
});
test('DNS is checked and the verified public address is pinned',async()=>{
  await assert.rejects(pinnedURL('https://cdn.example.com/a',['cdn.example.com'],async()=>[{address:'127.0.0.1'}]),/NOT_PUBLIC/);
  await assert.rejects(pinnedURL('http://cdn.example.com/a',['cdn.example.com']),/NOT_ALLOWED/);
  await assert.rejects(pinnedURL('https://user:pass@cdn.example.com/a',['cdn.example.com']),/NOT_ALLOWED/);
  const p=await pinnedURL('https://cdn.example.com/a',['cdn.example.com'],async()=>[{address:'8.8.8.8'}]);assert.equal(p.address,'8.8.8.8');
});
test('persistent storage rejects paths and replaces JSON atomically',async()=>{
  assert.throws(()=>safeId('../../etc/passwd'),/INVALID_ID/);
  const root=await fs.mkdtemp(join(tmpdir(),'openreel-store-'));const s=new Store(root);await s.init();
  const id='b40a6807-7434-4e19-9656-33654348b0d7';
  await s.write('jobs',id,{status:'queued'});await s.write('jobs',id,{status:'completed'});
  assert.equal((await s.read('jobs',id)).status,'completed');assert.equal((await s.list('jobs')).length,1);
  await fs.rm(root,{recursive:true,force:true});
});
