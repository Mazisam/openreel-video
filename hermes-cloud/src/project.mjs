import { HeadlessHost } from '@openreel/agent/headless-host';
import { randomUUID } from 'node:crypto';
import { checkAction } from './schema.mjs';
export function newProject(settings) {
  return {id:randomUUID(),name:settings.name,createdAt:Date.now(),modifiedAt:Date.now(),
    settings:{width:settings.width??1280,height:settings.height??720,frameRate:settings.frameRate??24,sampleRate:48000,channels:2},
    mediaLibrary:{items:[]},timeline:{duration:0,tracks:[],subtitles:[],markers:[]}};
}
export async function editProject(project, calls) {
  const host = new HeadlessHost(structuredClone(project));
  const tx = host.beginTransaction('Hermes cloud edit');
  const results = [];
  try {
    for (const call of calls) {
      checkAction(call);
      const params = structuredClone(call.params);
      const p = host.getProject();
      if (params.trackId && call.type!=='track/add' && !p.timeline.tracks.some(t=>t.id===params.trackId)) throw new Error('TRACK_NOT_FOUND');
      if (params.clipId && call.type!=='clip/add' && !p.timeline.tracks.some(t=>t.clips.some(c=>c.id===params.clipId))) throw new Error('CLIP_NOT_FOUND');
      if (call.type==='track/add' && params.trackId && p.timeline.tracks.some(t=>t.id===params.trackId)) throw new Error('DUPLICATE_TRACK_ID');
      if (call.type==='clip/add') {
        if (!p.mediaLibrary.items.some(m=>m.id===params.mediaId)) throw new Error('MEDIA_NOT_FOUND');
        if (params.clipId && p.timeline.tracks.some(t=>t.clips.some(c=>c.id===params.clipId))) throw new Error('DUPLICATE_CLIP_ID');
        params.inPoint ??= 0;
        params.outPoint ??= params.inPoint + params.duration;
        if (Math.abs(params.outPoint - params.inPoint - params.duration)>.01) throw new Error('SOURCE_RANGE_MISMATCH');
        if(params.transform) params.transform={anchor:{x:.5,y:.5},rotation:0,opacity:1,fitMode:'contain',...params.transform,
          position:{x:0,y:0,...params.transform.position},scale:{x:1,y:1,...params.transform.scale}};
      }
      if (call.type==='subtitle/add' && params.endTime<=params.startTime) throw new Error('INVALID_SUBTITLE_RANGE');
      const before = new Set([...p.timeline.tracks.map(t=>t.id),...p.timeline.tracks.flatMap(t=>t.clips.map(c=>c.id)),...p.timeline.subtitles.map(s=>s.id)]);
      const action = {id:randomUUID(),type:call.type,params,timestamp:Date.now()};
      const result = await host.applyAction(action);
      if (!result.success) throw new Error('OPENREEL_ACTION: ' + (result.error?.message || result.error?.code));
      // Upstream subtitle/add uses Date.now() as ID. Keep IDs unique in fast batches.
      if (call.type==='subtitle/add') host.getProject().timeline.subtitles.at(-1).id = randomUUID();
      const next = host.getProject();
      results.push({type:call.type,created_ids:[...next.timeline.tracks.map(t=>t.id),...next.timeline.tracks.flatMap(t=>t.clips.map(c=>c.id)),...next.timeline.subtitles.map(s=>s.id)].filter(id=>!before.has(id))});
    }
    const edited = host.getProject();
    if (edited.timeline.tracks.length>32 || edited.timeline.tracks.flatMap(t=>t.clips).length>100 || edited.timeline.subtitles.length>200) throw new Error('PROJECT_COMPLEXITY_LIMIT');
    edited.modifiedAt = Date.now();
    host.commitTransaction(tx,'Hermes cloud edit');
    return {project:edited,results};
  } catch (error) { await host.rollbackTransaction(tx); throw error; }
}
