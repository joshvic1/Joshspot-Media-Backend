const http=require('node:http');
const {randomUUID}=require('node:crypto');
// MP4 metadata may be at the end. Give FFmpeg seekable, memory-only input.
module.exports=async function audioInput(buffer){
 if(buffer.subarray(4,8).toString()!=='ftyp')return {args:['-protocol_whitelist','pipe','-i','pipe:0'],pipe:true,close:async()=>{}};
 const path='/'+randomUUID();
 const server=http.createServer((req,res)=>{
  if(req.url!==path||!['GET','HEAD'].includes(req.method)){res.writeHead(404).end();return;}
  let start=0,end=buffer.length-1;const range=req.headers.range;
  if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m){res.writeHead(416).end();return;}start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(start>end){res.writeHead(416,{'Content-Range':`bytes */${buffer.length}`}).end();return;}}
  res.writeHead(range?206:200,{'Content-Type':'audio/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${buffer.length}`}:{})});res.end(req.method==='HEAD'?undefined:buffer.subarray(start,end+1));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 return {args:['-protocol_whitelist','http,tcp','-f','mov','-i',`http://127.0.0.1:${server.address().port}${path}`],pipe:false,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
};
