const {spawn}=require('node:child_process');
// Rebuild timestamps from decoded samples rather than carrying browser timing offsets.
// All input/output travels through pipes. No recording or temporary file is written.
module.exports=function convertRecording(buffer){
 return new Promise((resolve,reject)=>{
  const child=spawn(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-i','pipe:0','-map','0:a:0','-vn','-af','asetpts=N/SR/TB','-map_metadata','-1','-t','180','-ac','1','-ar','48000','-c:a','libopus','-b:a','32k','-f','ogg','pipe:1'],{windowsHide:true});
  const chunks=[];let size=0,settled=false;
  const finish=(error,data)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(Object.assign(new Error(error),{status:400})):resolve(data);};
  const timer=setTimeout(()=>{child.kill();finish('Audio processing timed out. Try a shorter recording.');},30000);
  child.on('error',()=>finish('Audio processing is unavailable. Please try again.'));
  child.stdin.on('error',()=>{});child.stderr.resume();
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>5*1024*1024){child.kill();finish('Recording is too large.');}else chunks.push(chunk);});
  child.on('close',code=>code===0&&size?finish(null,Buffer.concat(chunks)):finish('Could not process this recording. Please record again.'));
  child.stdin.end(buffer);
 });
};
