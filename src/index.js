import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateAudioSource } from './media.js';
import { renderHighlight } from './render.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const uploadDir = path.join(root, 'uploads');
const outputDir = path.join(root, 'output');
await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 750 * 1024 * 1024,
    files: 25,
  },
});

const app = express();
app.use(cors({ origin: true }));
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} content-length=${req.headers['content-length'] || 'unknown'}`);
  next();
});
app.use('/output', express.static(outputDir));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'buffalofm-highlight-api' }));

app.post('/api/validate-source', upload.single('source'), async (req, res) => {
  if (!req.file) return res.status(400).json({ valid: false, message: 'No audio source uploaded.' });
  try {
    const result = await validateAudioSource(req.file.path, 30);
    res.status(result.valid ? 200 : 422).json({
      valid: result.valid,
      duration: result.duration,
      hasAudio: result.hasAudio,
      kind: result.hasVideo ? 'video' : 'audio',
      message: result.message,
    });
  } catch (error) {
    res.status(422).json({ valid: false, message: 'The selected file could not be analyzed.' });
  } finally {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
});

app.post(
  '/api/generate',
  upload.fields([
    { name: 'source', maxCount: 1 },
    { name: 'media', maxCount: 20 },
  ]),
  async (req, res) => {
    console.log('[GENERATE] upload received');
    const source = req.files?.source?.[0];
    const media = req.files?.media || [];
    const allTemp = [...(source ? [source] : []), ...media];

    try {
      if (!source) return res.status(400).json({ error: 'Step 3 is required: add a 30+ second audio source.' });
      if (!media.length) return res.status(400).json({ error: 'Add at least one photo or video for the montage.' });

      // Authoritative server-side gate. Even a modified client cannot bypass this.
      console.log(`[GENERATE] source=${source.originalname} media=${media.length}`);
      const validation = await validateAudioSource(source.path, 30);
      if (!validation.valid) {
        return res.status(422).json({ error: validation.message || 'Audio source does not qualify.' });
      }

      console.log('[GENERATE] validation passed; starting ffmpeg render');
      const rendered = await renderHighlight({
        mediaItems: media.map((m) => ({ path: m.path, mimetype: m.mimetype, originalname: m.originalname })),
        sourcePath: source.path,
        outputDir,
        artist: req.body.artist,
        venue: req.body.venue,
        showDate: req.body.showDate,
        style: req.body.style,
      });

      console.log(`[GENERATE] render complete: ${rendered.outName}`);
      res.json({
        ok: true,
        duration: 30,
        downloadUrl: `/output/${rendered.outName}`,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message || 'Render failed.' });
    } finally {
      await Promise.all(allTemp.map((f) => fs.rm(f.path, { force: true }).catch(() => {})));
    }
  }
);

app.use((err, _req, res, _next) => {
  console.error('[HTTP ERROR]', err);
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'Upload/render request failed.' });
});

process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (err) => console.error('[UNHANDLED REJECTION]', err));

const port = Number(process.env.PORT || 8787);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Buffalo.fm Highlight API listening on http://0.0.0.0:${port}`);
});
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 120000;
server.keepAliveTimeout = 120000;
