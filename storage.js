// Storage: Cloudflare R2 (S3-compatible) when R2_* env is set, else local disk (data/store).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { pipeline } = require('stream/promises');
const R2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
const LOCAL = path.join(__dirname, 'data', 'store');
const SECRET = process.env.LOCAL_SIGNING_SECRET || crypto.randomBytes(16).toString('hex');
let s3, cmd, presign;
if (R2) {
  const S3 = require('@aws-sdk/client-s3');
  cmd = S3; presign = require('@aws-sdk/s3-request-presigner').getSignedUrl;
  s3 = new S3.S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
}
const Bucket = process.env.R2_BUCKET;
const safeKey = k => { if (!/^projects\/[a-z0-9]+\/[\w./-]+$/.test(k) || k.includes('..')) throw new Error('bad key'); return k; };
const lp = k => path.join(LOCAL, safeKey(k));
const sign = (k, exp, op) => crypto.createHmac('sha256', SECRET).update(`${op}:${k}:${exp}`).digest('hex').slice(0, 32);

async function presignPut(key, contentType) {
  safeKey(key);
  if (R2) return { url: await presign(s3, new cmd.PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn: 3600 }), headers: { 'Content-Type': contentType } };
  const exp = Date.now() + 3600e3;
  return { url: `/api/local/put?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sign(key, exp, 'put')}`, headers: { 'Content-Type': contentType } };
}
async function presignGet(key, downloadName) {
  safeKey(key);
  if (R2) return presign(s3, new cmd.GetObjectCommand({ Bucket, Key: key, ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` } : {}) }), { expiresIn: 3600 });
  const exp = Date.now() + 3600e3;
  return `/api/local/get?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sign(key, exp, 'get')}${downloadName ? '&dl=' + encodeURIComponent(downloadName) : ''}`;
}
function verifyLocal(q, op) { const k = safeKey(q.key); if (+q.exp < Date.now() || sign(k, q.exp, op) !== q.sig) throw new Error('bad signature'); return k; }
async function putFile(key, file, contentType) {
  if (R2) return s3.send(new cmd.PutObjectCommand({ Bucket, Key: safeKey(key), Body: fs.createReadStream(file), ContentLength: fs.statSync(file).size, ContentType: contentType }));
  fs.mkdirSync(path.dirname(lp(key)), { recursive: true }); fs.copyFileSync(file, lp(key));
}
async function getFile(key, dest) {
  if (R2) { const o = await s3.send(new cmd.GetObjectCommand({ Bucket, Key: safeKey(key) })); await pipeline(o.Body, fs.createWriteStream(dest)); return dest; }
  fs.copyFileSync(lp(key), dest); return dest;
}
async function exists(key) {
  if (R2) { try { await s3.send(new cmd.HeadObjectCommand({ Bucket, Key: safeKey(key) })); return true; } catch { return false; } }
  return fs.existsSync(lp(key));
}
async function putJSON(key, obj) {
  const body = JSON.stringify(obj, null, 2);
  if (R2) return s3.send(new cmd.PutObjectCommand({ Bucket, Key: safeKey(key), Body: body, ContentType: 'application/json' }));
  fs.mkdirSync(path.dirname(lp(key)), { recursive: true }); fs.writeFileSync(lp(key), body);
}
async function getJSON(key) {
  if (R2) { const o = await s3.send(new cmd.GetObjectCommand({ Bucket, Key: safeKey(key) })); return JSON.parse(await o.Body.transformToString()); }
  return JSON.parse(fs.readFileSync(lp(key), 'utf8'));
}
async function listProjectIds() {
  if (R2) { const ids = []; let tok;
    do { const r = await s3.send(new cmd.ListObjectsV2Command({ Bucket, Prefix: 'projects/', Delimiter: '/', ContinuationToken: tok }));
      (r.CommonPrefixes || []).forEach(p => ids.push(p.Prefix.split('/')[1])); tok = r.IsTruncated ? r.NextContinuationToken : null; } while (tok);
    return ids; }
  const d = path.join(LOCAL, 'projects'); return fs.existsSync(d) ? fs.readdirSync(d) : [];
}
async function ensureCors(origins) {
  if (!R2) return 'local';
  try {
    await s3.send(new cmd.PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }] } }));
    return 'cors set';
  } catch (e) { return 'cors not set: ' + e.message; }
}
module.exports = { R2, presignPut, presignGet, verifyLocal, putFile, getFile, exists, putJSON, getJSON, listProjectIds, ensureCors, LOCAL, lp };
