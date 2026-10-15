const {spawn}=require('node:child_process');
let active=0;
// Memory-only browser playback; never persist or replace Meta media.
module.exports=async function playback(buffer){
 if(buffer.length>16*1024*1024)throw Object.assign(new Error('Audio is too large for compatible playback.'),{status:413});
 if(active>=2)throw Object.assign(new Error('Audio processing is busy. Please retry shortly.'),{status:503});
 active++;
 let input;
 try{input=await require('./audioInput')(buffer);return await new Promise((resolve,reject)=>{
  const child=spawn(require('ffmpeg-static'),['-hide_banner','-loglevel','error',...input.args,'-map','0:a:0','-vn','-af','asetpts=N/SR/TB','-map_metadata','-1','-ac','1','-ar','44100','-c:a','libmp3lame','-b:a','64k','-f','mp3','pipe:1'],{windowsHide:true});
  const chunks=[];let size=0,error;
  const timer=setTimeout(()=>{error='Audio processing timed out. Please retry.';child.kill();},25000);
  child.on('error',()=>{clearTimeout(timer);reject(Object.assign(new Error('Audio processing is unavailable.'),{status:503}));});
  child.stdin.on('error',()=>{});child.stderr.resume();
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024){error='Audio is too large for compatible playback.';child.kill();}else chunks.push(chunk);});
  child.on('close',code=>{clearTimeout(timer);if(code===0&&size&&!error)resolve(Buffer.concat(chunks));else reject(Object.assign(new Error(error||'Could not prepare this audio for playback.'),{status:422}));});
  child.stdin.end(input.pipe?buffer:undefined);
 });}finally{await input?.close();active--;}
};
