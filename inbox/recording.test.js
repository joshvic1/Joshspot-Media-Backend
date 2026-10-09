const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const ffmpeg=require('ffmpeg-static');
const convert=require('./recording');
function run(args,input){
 const result=spawnSync(ffmpeg,['-hide_banner',...args],{input,windowsHide:true,maxBuffer:8*1024*1024});
 assert.equal(result.status,0,result.stderr?.toString());return result;
}
for(const [format,codec,extra] of [['webm','libopus',[]],['mp4','aac',['-movflags','frag_keyframe+empty_moov']],['ogg','libopus',[]]]){
 test(`${format} browser recording becomes decodable mono OGG/Opus`,async()=>{
  const source=run(['-f','lavfi','-i','sine=frequency=440:duration=1','-af','asetpts=PTS+0.5/TB','-ac','2','-c:a',codec,...extra,'-f',format,'pipe:1']).stdout;
  const ogg=await convert(source);
  assert.equal(ogg.subarray(0,4).toString(),'OggS');
  const decoded=run(['-i','pipe:0','-f','s16le','pipe:1'],ogg);
  assert.match(decoded.stderr.toString(),/Audio: opus, 48000 Hz, mono/);
  assert.match(decoded.stderr.toString(),/start: 0\.000000/);
  assert.ok(decoded.stdout.length>80000,'complete one-second audio decodes');
  assert.ok(decoded.stdout.some(byte=>byte!==0),'recorded tone survives conversion');
 });
}
test('invalid recording is rejected',async()=>{await assert.rejects(convert(Buffer.from('not audio')),/Could not process/);});
