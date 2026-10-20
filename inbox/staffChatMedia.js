const { Attachment, StaffMessage } = require('./staffChatModels');
const MAX = 3 * 1024 * 1024;
function detect(b) {
  if (b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(b.subarray(0,6).toString())) return 'image/gif';
  if (b.subarray(8,12).toString() === 'WEBP' && b.subarray(0,4).toString() === 'RIFF') return 'image/webp';
  if (b.subarray(0,4).toString() === 'OggS') return 'audio/ogg';
  if (b.subarray(0,3).toString() === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224)) return 'audio/mpeg';
  if (b.subarray(4,8).toString() === 'ftyp') return /M4A|M4B/.test(b.subarray(8,12).toString()) ? 'audio/mp4' : 'video/mp4';
  if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WAVE') return 'audio/wav';
  return null;
}
function routes(router, wrap, fail, id, rateLimit, accessible) {
  router.post('/staff-chats/:threadId/media', wrap(async (req, res) => {
    await rateLimit(req, 20);
    const thread = await accessible(req);
    if (typeof req.body.data !== 'string' || req.body.data.length > 4200000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(req.body.data)) fail(400, 'Choose a file up to 3 MB.');
    let data = Buffer.from(req.body.data, 'base64');
    if (!data.length || data.length > MAX) fail(400, 'Choose a file up to 3 MB.');
    let mime = detect(data);
    // Convert once on upload, so iPhone and Android receive the same playable MP3.
    if (req.body.recording === true || mime?.startsWith('audio/')) {
      data = await require('./playback')(data);
      mime = 'audio/mpeg';
    }
    if (!mime) fail(400, 'Use a photo, GIF, PDF, MP4 video or audio file.');
    if (data.length > MAX) fail(400, 'Processed audio exceeds 3 MB. Use a shorter recording.');
    const name = (req.body.recording ? 'Voice note.mp3' : String(req.body.name || 'Attachment')).slice(0,120).replace(/[^\w. -]/g,'_');
    const type = mime === 'application/pdf' ? 'document' : mime.split('/')[0];
    const asset = await Attachment.create({ thread: thread._id, owner: req.actor.id, data, mime, type, name, size: data.length, expiresAt: new Date(Date.now()+86400000) });
    res.json({ attachmentId: asset._id, type, name, size: asset.size });
  }));
  router.get('/staff-chats/:threadId/media/:assetId', wrap(async (req, res) => {
    const thread = await accessible(req);
    const asset = await Attachment.findOne({ _id: id(req.params.assetId), thread: thread._id }).select('+data');
    if (!asset || (asset.owner !== req.actor.id && !await StaffMessage.exists({ thread: thread._id, 'media.id': asset._id }))) fail(404, 'Attachment not found.');
    res.set({ 'Content-Type':asset.mime, 'Content-Disposition':`attachment; filename="${asset.name}"`, 'X-Content-Type-Options':'nosniff', 'Cache-Control':'private, no-store' }).send(Buffer.from(asset.data));
  }));
}
module.exports = { routes, detect };
