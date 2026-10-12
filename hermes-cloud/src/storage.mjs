import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function safeId(value) {
  if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('INVALID_ID');
  return value;
}
export class Store {
  constructor(root) { this.root=root; }
  async init() { for (const dir of ['projects','jobs','media','outputs','temp']) await fs.mkdir(join(this.root,dir),{recursive:true,mode:0o700}); }
  path(kind,id,ext='.json') { return join(this.root,kind,safeId(id)+ext); }
  async read(kind,id) { try { return JSON.parse(await fs.readFile(this.path(kind,id),'utf8')); } catch (e) { if(e.code==='ENOENT') throw new Error('NOT_FOUND'); throw e; } }
  async write(kind,id,data) {
    const target=this.path(kind,id), temp=target+'.'+randomUUID()+'.tmp';
    const fd=await fs.open(temp,'wx',0o600);
    try { await fd.writeFile(JSON.stringify(data)); await fd.sync(); } finally { await fd.close(); }
    await fs.rename(temp,target);
  }
  async list(kind) {
    const files=await fs.readdir(join(this.root,kind)); const items=[];
    for(const name of files) {
      if(!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      try { items.push(await this.read(kind,name.slice(0,-5))); }
      catch { console.error('CORRUPT_STATE_FILE',kind,name); }
    }
    return items;
  }
  async diskBudget(bytes=0) {
    let total=0;
    for(const dir of ['media','outputs','projects','jobs','temp']) {
      for (const file of await fs.readdir(join(this.root,dir))) total+=(await fs.stat(join(this.root,dir,file))).size;
    }
    const limit=Number(process.env.MAX_DATA_DISK_BYTES || 8*1024**3);
    const disk=await fs.statfs(this.root);
    if (total+bytes>limit || disk.bavail*disk.bsize<bytes+256*1024**2) throw new Error('MEDIA_DISK_BUDGET');
  }
}
