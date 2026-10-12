import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createWriteStream, promises as fs } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export const MAX_MEDIA_BYTES=Number(process.env.MAX_MEDIA_BYTES || 256*1024**2);
export function publicIPv4(address) {
  const parts=address.split('.').map(Number);
  if(parts.length!==4 || parts.some(n=>!Number.isInteger(n)||n<0||n>255)) return false;
  const [a,b,c]=parts;
  return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
}
export function hostAllowed(host, allowlist) {
  return allowlist.some(rule=>rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host!==rule.slice(2) : host===rule);
}
export async function pinnedURL(raw, allowlist, resolver=lookup) {
  const url=new URL(raw);
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || !hostAllowed(url.hostname,allowlist)) throw new Error('MEDIA_URL_NOT_ALLOWED');
  const records=await resolver(url.hostname,{family:4,all:true});
  if(!records.length || records.some(r=>!publicIPv4(r.address))) throw new Error('MEDIA_ADDRESS_NOT_PUBLIC');
  return {url,address:records[0].address};
}
export async function download(raw,destination,allowlist,signal,redirects=0) {
  if(redirects>3) throw new Error('MEDIA_REDIRECT_LIMIT');
  const {url,address}=await pinnedURL(raw,allowlist);
  const response=await new Promise((resolve,reject)=>{
    const request=https.get(url,{signal,lookup:(_host,opts,cb)=>cb(null,opts?.all?[{address,family:4}]:address,4),headers:{'User-Agent':'OpenReel-Hermes-Cloud/0.1.0'}},resolve);
    request.on('error',()=>reject(new Error('MEDIA_DOWNLOAD_FAILED')));
  });
  if([301,302,303,307,308].includes(response.statusCode)) {
    const next=response.headers.location; response.destroy();
    if(!next) throw new Error('MEDIA_REDIRECT_INVALID');
    return download(new URL(next,url).href,destination,allowlist,signal,redirects+1);
  }
  if(response.statusCode!==200) { response.destroy(); throw new Error('MEDIA_HTTP_'+response.statusCode); }
  if(Number(response.headers['content-length']||0)>MAX_MEDIA_BYTES) {response.destroy();throw new Error('MEDIA_TOO_LARGE');}
  let bytes=0;
  const meter=new Transform({transform(chunk,_enc,callback) {bytes+=chunk.length; callback(bytes>MAX_MEDIA_BYTES?new Error('MEDIA_TOO_LARGE'):null,chunk);}});
  try {await pipeline(response,meter,createWriteStream(destination,{flags:'wx',mode:0o600}),{signal});}
  catch(e) {await fs.unlink(destination).catch(()=>{});throw e;}
  return bytes;
}
