const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const ffmpeg=require('ffmpeg-static');
const playback=require('./playback');
function run(args,input){const r=spawnSync(ffmpeg,['-hide_banner',...args],{input,windowsHide:true,maxBuffer:24*1024*1024});assert.equal(r.status,0,r.stderr.toString());return r;}
test('incoming Opus becomes decodable MP3 without truncating long voice notes',async()=>{
 const source=run(['-f','lavfi','-i','sine=frequency=440:duration=181','-c:a','libopus','-f','ogg','pipe:1']).stdout;
 const original=Buffer.from(source);const result=await playback(source);
 assert.deepEqual(source,original);
 const decoded=run(['-i','pipe:0','-f','s16le','pipe:1'],result);
 assert.match(decoded.stderr.toString(),/Audio: mp3/);
 assert.ok(decoded.stdout.length>180*44100*2,'over three minutes retained');
});
test('invalid and oversized playback inputs fail safely',async()=>{
 await assert.rejects(playback(Buffer.from('invalid')),/Could not prepare/);
 await assert.rejects(playback(Buffer.alloc(16*1024*1024+1)),/too large/);
});
