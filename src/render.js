import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { probe, run } from './media.js';

const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;
const TARGET_SECONDS = 30;
const FONT = process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

function escapeDrawText(value = '') {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('%', '\\%');
}

async function makeSegment(item, outputPath, seconds) {
  const inputPath = item.path;
  const isImage = String(item.mimetype || '').startsWith('image/');
  const info = await probe(inputPath);
  if (info.hasVideo && !isImage) {
    await run('ffmpeg', [
      '-y', '-i', inputPath,
      '-t', String(seconds),
      '-an',
      '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '1',
      outputPath,
    ]);
  } else {
    await run('ffmpeg', [
      '-y', '-loop', '1', '-i', inputPath,
      '-t', String(seconds),
      '-an',
      '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '1',
      outputPath,
    ]);
  }
}

export async function renderHighlight({ mediaItems, sourcePath, outputDir, artist, venue, showDate, style }) {
  const jobId = crypto.randomUUID();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'buffalofm-highlight-'));
  const limited = mediaItems.slice(0, 12);
  if (!limited.length) throw new Error('At least one visual photo or video is required.');

  const segmentSeconds = TARGET_SECONDS / limited.length;
  const segments = [];
  for (let i = 0; i < limited.length; i++) {
    const segment = path.join(work, `segment-${String(i).padStart(2, '0')}.mp4`);
    await makeSegment(limited[i], segment, segmentSeconds);
    segments.push(segment);
  }

  const concatList = path.join(work, 'concat.txt');
  await fs.writeFile(concatList, segments.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n'));

  const visual = path.join(work, 'visual.mp4');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', visual]);

  const withAudio = path.join(work, 'with-audio.mp4');
  await run('ffmpeg', [
    '-y', '-i', visual, '-i', sourcePath,
    '-t', String(TARGET_SECONDS),
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', withAudio,
  ]);

  await fs.mkdir(outputDir, { recursive: true });
  const outName = `${jobId}.mp4`;
  const outPath = path.join(outputDir, outName);
  const artistText = escapeDrawText(artist || 'LIVE IN BUFFALO');
  const detailText = escapeDrawText([venue, showDate].filter(Boolean).join(' • '));
  const styleText = escapeDrawText(style || 'HYPE');

  const vf = [
    `drawtext=fontfile='${FONT}':text='BUFFALO.FM':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=80:box=1:boxcolor=black@0.45:boxborderw=18`,
    `drawtext=fontfile='${FONT}':text='${artistText}':fontcolor=white:fontsize=70:x=(w-text_w)/2:y=h-315:box=1:boxcolor=black@0.55:boxborderw=20`,
    detailText ? `drawtext=fontfile='${FONT}':text='${detailText}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-215:box=1:boxcolor=black@0.45:boxborderw=14` : null,
    `drawtext=fontfile='${FONT}':text='${styleText} CUT':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h-125:box=1:boxcolor=black@0.35:boxborderw=10`,
  ].filter(Boolean).join(',');

  await run('ffmpeg', [
    '-y', '-i', withAudio,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-threads', '1',
    '-c:a', 'copy', '-movflags', '+faststart',
    outPath,
  ]);

  await fs.rm(work, { recursive: true, force: true });
  return { outName, outPath };
}
