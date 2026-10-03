const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getR2Client } = require('../utils/r2Storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const PREFIX = 'joshspot-inbox/v1/';
function assertKey(key) {
  // Never accept a caller-supplied arbitrary bucket key, including other Inbox prefixes.
  if (!new RegExp(`^${PREFIX}[a-f0-9]{24}$`).test(key)) throw new Error('Invalid Inbox media key');
}
exports.keyFor = id => { const key = `${PREFIX}${id}`; assertKey(key); return key; };
exports.configured = () => ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'].every(key => Boolean(process.env[key]));
exports.link = async (asset, download = false) => {
  assertKey(asset.key);
  const name = (asset.name || 'attachment').replace(/[^\w.-]/g, '_');
  return getSignedUrl(getR2Client(), new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: asset.key, ResponseContentDisposition: `${download ? 'attachment' : 'inline'}; filename="${name}"` }), { expiresIn: 3600 });
};
exports.put = async (key, buffer, mime) => { assertKey(key); await getR2Client().send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: buffer, ContentType: mime }), { abortSignal: AbortSignal.timeout(30000) }); };
exports.get = async key => { assertKey(key); const result = await getR2Client().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(30000) }); return { buffer: Buffer.from(await result.Body.transformToByteArray()), mime: result.ContentType }; };
exports.remove = async key => { assertKey(key); await getR2Client().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(30000) }); };
