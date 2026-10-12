import Ajv from 'ajv';
const ajv = new Ajv({allErrors:false,strict:false});
export const obj = (properties, required=[]) => ({type:'object',properties,required,additionalProperties:false});
const n = (minimum=0,maximum=600) => ({type:'number',minimum,maximum});
const str = {type:'string',minLength:1,maxLength:120};
const id = {type:'string',pattern:'^[A-Za-z0-9_-]{1,80}$'};
const xy = (a,b) => obj({x:n(a,b),y:n(a,b)});
const transform = obj({position:xy(-4096,4096),scale:xy(.1,4),opacity:n(0,1),
  fitMode:{enum:['contain','cover','stretch']}});
export const actions = {
  'project/rename': obj({name:str},['name']),
  'track/add': obj({trackType:{enum:['video','image','audio']},position:{type:'integer',minimum:0,maximum:31},trackId:id,name:str},['trackType']),
  'track/remove': obj({trackId:id},['trackId']),
  'track/rename': obj({trackId:id,name:str},['trackId','name']),
  'track/reorder': obj({trackId:id,newPosition:{type:'integer',minimum:0,maximum:31}},['trackId','newPosition']),
  'track/hide': obj({trackId:id,hidden:{type:'boolean'}},['trackId','hidden']),
  'track/mute': obj({trackId:id,muted:{type:'boolean'}},['trackId','muted']),
  'clip/add': obj({trackId:id,mediaId:id,clipId:id,startTime:n(),duration:n(.04),inPoint:n(),outPoint:n(),volume:n(0,2),transform},['trackId','mediaId','startTime','duration']),
  'clip/remove': obj({clipId:id},['clipId']),
  'clip/move': obj({clipId:id,trackId:id,startTime:n()},['clipId','startTime']),
  'clip/trim': obj({clipId:id,inPoint:n(),outPoint:n()},['clipId']),
  'clip/split': obj({clipId:id,time:n()},['clipId','time']),
  'transform/update': obj({clipId:id,transform},['clipId','transform']),
  'audio/setVolume': obj({clipId:id,volume:n(0,2)},['clipId','volume']),
  'audio/setFade': obj({clipId:id,fadeIn:n(0,30),fadeOut:n(0,30)},['clipId']),
  'subtitle/add': obj({text:{type:'string',minLength:1,maxLength:1000},startTime:n(),endTime:n(.04)},['text','startTime','endTime']),
  'subtitle/remove': obj({subtitleId:id},['subtitleId']),
};
const validators = Object.fromEntries(Object.entries(actions).map(([k,s])=>[k,ajv.compile(s)]));
export function checkAction(action) {
  if (!action || !validators[action.type] || !validators[action.type](action.params)) {
    throw new Error('INVALID_ACTION: consult openreel_catalog; unsupported fields/features are rejected');
  }
}
const uuid = {type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'};
export const schemas = {
  project:obj({name:str,width:{type:'integer',minimum:64,maximum:1920},height:{type:'integer',minimum:64,maximum:1920},frameRate:{enum:[24,25,30]}},['name']),
  job:obj({kind:{enum:['import','edit','render']},project_id:uuid,idempotency_key:{type:'string',pattern:'^[A-Za-z0-9_.:-]{8,128}$'},expected_revision:{type:'integer',minimum:0},input:{type:'object'}},['kind','project_id','idempotency_key','input']),
  import:obj({url:{type:'string',maxLength:8000},name:str},['url']),
  edit:obj({actions:{type:'array',minItems:1,maxItems:100,items:obj({type:{enum:Object.keys(actions)},params:{type:'object'}},['type','params'])}},['actions']),
  render:obj({crf:{type:'integer',minimum:18,maximum:28}},[]),
};
const compiled = Object.fromEntries(Object.entries(schemas).map(([k,s])=>[k,ajv.compile(s)]));
export function validate(kind,data) {
  if (!compiled[kind](data)) throw new Error('INVALID_' + kind.toUpperCase() + ': ' + ajv.errorsText(compiled[kind].errors));
  if (kind==='edit') data.actions.forEach(checkAction);
  return data;
}
