import { spawn } from 'node:child_process';

export function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

export async function probe(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height',
    '-of', 'json',
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const duration = Number(data?.format?.duration || 0);
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  return {
    duration,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasVideo: streams.some((s) => s.codec_type === 'video'),
    streams,
  };
}

export async function validateAudioSource(filePath, minSeconds = 30) {
  const info = await probe(filePath);
  const validDuration = info.duration >= minSeconds;
  const valid = validDuration && info.hasAudio;
  let message = '';
  if (!validDuration) message = `Audio source must be at least ${minSeconds} seconds long.`;
  else if (!info.hasAudio) message = 'That video has no detectable audio track. Choose a video with sound or upload an audio file.';
  return { valid, ...info, message };
}
