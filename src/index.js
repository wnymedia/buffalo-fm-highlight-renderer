import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateAudioSource, probe } from './media.js';
import { renderHighlight } from './render.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const uploadDir = path.join(root, 'uploads');
const outputDir = path.join(root, 'output');
await fsp.mkdir(uploadDir, { recursive: true });
await fsp.mkdir(outputDir, { recursive: true });

const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB per source file for beta
const MAX_FILES_PER_JOB = 21; // 20 visuals + soundtrack

function safeId(id) {
  return typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
}
function dataPath(id) { return path.join(uploadDir, `${id}.bin`); }
function metaPath(id) { return path.join(uploadDir, `${id}.json`); }
async function readMeta(id) {
  if (!safeId(id)) throw new Error('Invalid upload ID.');
  return JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
}
async function writeMeta(meta) {
  await fsp.writeFile(metaPath(meta.id), JSON.stringify(meta));
}
async function removeUpload(id) {
  if (!safeId(id)) return;
  await Promise.all([
    fsp.rm(dataPath(id), { force: true }).catch(() => {}),
    fsp.rm(metaPath(id), { force: true }).catch(() => {}),
  ]);
}
async function receiveChunk(req, dest, expectedOffset, expectedTotal) {
  const stat = await fsp.stat(dest).catch(() => ({ size: 0 }));
  if (stat.size !== expectedOffset) {
    const err = new Error(`Offset mismatch. Server has ${stat.size} bytes; client expected ${expectedOffset}.`);
    err.status = 409;
    err.serverOffset = stat.size;
    throw err;
  }
  if (expectedTotal > MAX_FILE_BYTES) {
    const err = new Error('File exceeds the 1 GB beta limit.');
    err.status = 413;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: 'a' });
    let received = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(error);
    };
    req.on('data', (chunk) => {
      received += chunk.length;
      if (expectedOffset + received > expectedTotal || expectedOffset + received > MAX_FILE_BYTES) {
        fail(Object.assign(new Error('Chunk would exceed declared file size.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('aborted', () => fail(Object.assign(new Error('Chunk upload aborted.'), { status: 499 })));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve(received);
      }
    });
    req.pipe(out);
  });
}

const legacyUpload = multer({
  dest: uploadDir,
  limits: { fileSize: 750 * 1024 * 1024, files: 25 },
});

const app = express();
app.use(cors({ origin: true, methods: ['GET','HEAD','POST','PUT','OPTIONS'], allowedHeaders: ['Content-Type','X-Upload-Offset'] }));
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} content-length=${req.headers['content-length'] || 'unknown'}`);
  next();
});
app.use('/output', express.static(outputDir));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'buffalofm-highlight-api', uploadMode: 'chunked-v1' }));

// Start a resumable upload. The browser sends one file at a time in small chunks.
app.post('/api/uploads/start', async (req, res) => {
  try {
    const { name = 'upload.bin', type = 'application/octet-stream', size, role = 'media' } = req.body || {};
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) return res.status(400).json({ error: 'Invalid file size.' });
    if (bytes > MAX_FILE_BYTES) return res.status(413).json({ error: 'File exceeds the 1 GB beta limit.' });
    if (!['media', 'source'].includes(role)) return res.status(400).json({ error: 'Invalid upload role.' });
    const id = crypto.randomUUID();
    const meta = { id, name: String(name), type: String(type), size: bytes, role, complete: false, createdAt: Date.now() };
    await fsp.writeFile(dataPath(id), '');
    await writeMeta(meta);
    console.log(`[UPLOAD] started ${id} role=${role} name=${meta.name} bytes=${bytes}`);
    res.json({ ok: true, uploadId: id, offset: 0 });
  } catch (error) {
    console.error('[UPLOAD START]', error);
    res.status(500).json({ error: error.message || 'Could not start upload.' });
  }
});

// Append one small binary chunk. Sequential chunks make mobile uploads retryable.
app.put('/api/uploads/:id/chunk', async (req, res) => {
  try {
    const id = req.params.id;
    const meta = await readMeta(id);
    if (meta.complete) return res.status(409).json({ error: 'Upload is already complete.' });
    const offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'Invalid chunk offset.' });
    const bytes = await receiveChunk(req, dataPath(id), offset, meta.size);
    const newOffset = offset + bytes;
    console.log(`[UPLOAD] ${id} ${newOffset}/${meta.size}`);
    res.json({ ok: true, uploadId: id, offset: newOffset, size: meta.size });
  } catch (error) {
    console.error('[UPLOAD CHUNK]', error);
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Chunk upload failed.', serverOffset: error.serverOffset });
  }
});

app.post('/api/uploads/:id/complete', async (req, res) => {
  try {
    const id = req.params.id;
    const meta = await readMeta(id);
    const stat = await fsp.stat(dataPath(id));
    if (stat.size !== meta.size) return res.status(409).json({ error: `Upload incomplete: ${stat.size}/${meta.size} bytes.`, offset: stat.size });
    meta.complete = true;
    meta.completedAt = Date.now();
    await writeMeta(meta);

    let sourceValidation = null;
    if (meta.role === 'source') {
      sourceValidation = await validateAudioSource(dataPath(id), 30);
      if (!sourceValidation.valid) {
        await removeUpload(id);
        return res.status(422).json({ error: sourceValidation.message || 'Audio source rejected.' });
      }
    }
    console.log(`[UPLOAD] complete ${id} role=${meta.role}`);
    res.json({ ok: true, uploadId: id, validation: sourceValidation });
  } catch (error) {
    console.error('[UPLOAD COMPLETE]', error);
    res.status(500).json({ error: error.message || 'Could not finish upload.' });
  }
});

app.delete('/api/uploads/:id', async (req, res) => {
  await removeUpload(req.params.id);
  res.json({ ok: true });
});

// Generate from already-uploaded files. This request is tiny, so the render no longer depends on a giant mobile POST.
app.post('/api/generate-job', async (req, res) => {
  const idsToClean = [];
  try {
    const { sourceId, mediaIds, artist, venue, showDate, template, style, editType } = req.body || {};
    if (!safeId(sourceId)) return res.status(400).json({ error: 'Missing soundtrack upload.' });
    if (!Array.isArray(mediaIds) || !mediaIds.length) return res.status(400).json({ error: 'Add at least one photo or video.' });
    if (mediaIds.length > 20) return res.status(400).json({ error: 'Maximum 20 visual items.' });
    if (new Set([sourceId, ...mediaIds]).size > MAX_FILES_PER_JOB) return res.status(400).json({ error: 'Too many uploads.' });

    const sourceMeta = await readMeta(sourceId);
    if (!sourceMeta.complete || sourceMeta.role !== 'source') return res.status(409).json({ error: 'Soundtrack upload is not complete.' });
    idsToClean.push(sourceId);
    const mediaMetas = [];
    for (const id of mediaIds) {
      if (!safeId(id)) return res.status(400).json({ error: 'Invalid media upload ID.' });
      const meta = await readMeta(id);
      if (!meta.complete || meta.role !== 'media') return res.status(409).json({ error: `Media upload ${id} is not complete.` });
      mediaMetas.push(meta);
      idsToClean.push(id);
    }

    const sourceValidation = await validateAudioSource(dataPath(sourceId), 30);
    if (!sourceValidation.valid) return res.status(422).json({ error: sourceValidation.message || 'Audio source rejected.' });

    // Authoritative 5–30 second rule for visual video clips.
    for (const meta of mediaMetas) {
      const isImage = String(meta.type || '').startsWith('image/');
      if (!isImage) {
        const info = await probe(dataPath(meta.id));
        if (info.hasVideo && (info.duration < 5 || info.duration > 30.25)) {
          return res.status(422).json({ error: `${meta.name} is ${info.duration.toFixed(1)}s. Visual video clips must be 5–30 seconds.` });
        }
      }
    }

    console.log(`[JOB] render source=${sourceId} media=${mediaIds.length}`);
    const rendered = await renderHighlight({
      mediaItems: mediaMetas.map((m) => ({ path: dataPath(m.id), mimetype: m.type, originalname: m.name })),
      sourcePath: dataPath(sourceId),
      outputDir,
      artist,
      venue,
      showDate,
      style: style || template || editType || 'HYPE',
    });
    console.log(`[JOB] render complete ${rendered.outName}`);
    res.json({ ok: true, duration: 30, width: 720, height: 1280, editType, downloadUrl: `/output/${rendered.outName}` });
  } catch (error) {
    console.error('[GENERATE JOB]', error);
    res.status(500).json({ error: error.message || 'Render failed.' });
  } finally {
    await Promise.all([...new Set(idsToClean)].map(removeUpload));
  }
});

// Legacy endpoints kept temporarily for old plugin versions and tiny desktop tests.
app.post('/api/validate-source', legacyUpload.single('source'), async (req, res) => {
  if (!req.file) return res.status(400).json({ valid: false, message: 'No audio source uploaded.' });
  try {
    const result = await validateAudioSource(req.file.path, 30);
    res.status(result.valid ? 200 : 422).json({ valid: result.valid, duration: result.duration, hasAudio: result.hasAudio, kind: result.hasVideo ? 'video' : 'audio', message: result.message });
  } catch (_error) {
    res.status(422).json({ valid: false, message: 'The selected file could not be analyzed.' });
  } finally {
    await fsp.rm(req.file.path, { force: true }).catch(() => {});
  }
});

app.post('/api/generate', legacyUpload.fields([{ name: 'source', maxCount: 1 }, { name: 'media', maxCount: 20 }]), async (req, res) => {
  const source = req.files?.source?.[0];
  const media = req.files?.media || [];
  const allTemp = [...(source ? [source] : []), ...media];
  try {
    if (!source || !media.length) return res.status(400).json({ error: 'Source and media are required.' });
    const validation = await validateAudioSource(source.path, 30);
    if (!validation.valid) return res.status(422).json({ error: validation.message });
    const rendered = await renderHighlight({ mediaItems: media.map((m) => ({ path: m.path, mimetype: m.mimetype, originalname: m.originalname })), sourcePath: source.path, outputDir, artist: req.body.artist, venue: req.body.venue, showDate: req.body.showDate, style: req.body.style });
    res.json({ ok: true, duration: 30, downloadUrl: `/output/${rendered.outName}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Render failed.' });
  } finally {
    await Promise.all(allTemp.map((f) => fsp.rm(f.path, { force: true }).catch(() => {})));
  }
});

app.use((err, _req, res, _next) => {
  console.error('[HTTP ERROR]', err);
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'Request failed.' });
});

process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (err) => console.error('[UNHANDLED REJECTION]', err));

const port = Number(process.env.PORT || 8787);
const server = app.listen(port, '0.0.0.0', () => console.log(`Buffalo.fm Highlight API listening on http://0.0.0.0:${port}`));
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 120000;
server.keepAliveTimeout = 120000;
