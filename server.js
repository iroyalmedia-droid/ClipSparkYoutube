const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { once } = require("events");
const { File } = require("node:buffer");
const ytdl = require("@distube/ytdl-core");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { YoutubeTranscript } = require("youtube-transcript");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 3000;

if (!ffmpegPath || !ffprobePath) {
  throw new Error("FFmpeg binaries not found. Install ffmpeg or use ffmpeg-static.");
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const jobs = new Map();
const JOB_TTL_MS = 1000 * 60 * 60;
const MAX_OPENAI_AUDIO_BYTES = 25 * 1024 * 1024;
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const DEFAULT_PLAYER_CLIENTS = ["ANDROID", "IOS", "TV"];

const STYLE_MAP = {
  kinetic: "FontName=Arial,FontSize=58,PrimaryColour=&H00FFFFFF&,BackColour=&H90000000&,BorderStyle=3,Outline=2,Shadow=1,Alignment=2",
  minimal: "FontName=Arial,FontSize=46,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=1,Shadow=0,Alignment=2",
  karaoke: "FontName=Arial,FontSize=52,PrimaryColour=&H00000000&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Shadow=1,Alignment=2",
  bold: "FontName=Arial Black,FontSize=60,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=3,Shadow=1,Alignment=2",
};

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "queued",
    step: 0,
    message: "Queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    progress: 0,
    outputZip: null,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

function sanitizeTitle(title) {
  return (title || "clipspark")
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.floor(seconds * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function buildVttTime(seconds) {
  const totalMs = Math.max(0, Math.floor(seconds * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildYtdlOptions() {
  const headers = {
    "User-Agent": process.env.YTDL_USER_AGENT || DEFAULT_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (process.env.YTDL_COOKIE) {
    headers.Cookie = process.env.YTDL_COOKIE;
  }

  const options = { requestOptions: { headers } };

  const envClients = process.env.YTDL_PLAYER_CLIENTS;
  if (envClients) {
    const cleaned = envClients
      .split(",")
      .map((client) => client.trim().toUpperCase())
      .filter(Boolean);
    if (cleaned.length) {
      options.playerClients = cleaned;
    }
  } else {
    options.playerClients = DEFAULT_PLAYER_CLIENTS;
  }

  if (process.env.YTDL_COOKIES_JSON) {
    try {
      const cookies = JSON.parse(process.env.YTDL_COOKIES_JSON);
      options.agent = ytdl.createAgent(cookies);
    } catch (error) {
      console.warn("Invalid YTDL_COOKIES_JSON. Falling back to header cookies.");
    }
  }

  return options;
}

async function extractAudio(videoPath, audioPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("aac")
      .audioBitrate("64k")
      .audioChannels(1)
      .audioFrequency(16000)
      .outputOptions(["-movflags", "+faststart"])
      .on("end", resolve)
      .on("error", reject)
      .save(audioPath);
  });
}

async function transcribeWithOpenAI(audioPath, language) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const stats = await fs.promises.stat(audioPath);
  if (stats.size > MAX_OPENAI_AUDIO_BYTES) {
    throw new Error("Audio too large for transcription. Keep clips under 25MB.");
  }

  if (typeof FormData === "undefined") {
    throw new Error("FormData is unavailable. Use Node 18+ to enable transcription.");
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
  const audioBuffer = await fs.promises.readFile(audioPath);
  const form = new FormData();
  const file = new File([audioBuffer], "audio.m4a", { type: "audio/mp4" });

  form.append("file", file);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  if (language) {
    form.append("language", language);
  }

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || "OpenAI transcription failed.");
  }

  if (!data.segments || !data.segments.length) {
    throw new Error("OpenAI transcription returned no segments.");
  }

  return data.segments
    .map((segment) => ({
      text: (segment.text || "").trim(),
      offset: Number(segment.start) || 0,
      duration: Math.max(0, (Number(segment.end) || 0) - (Number(segment.start) || 0)),
    }))
    .filter((segment) => segment.text && segment.duration > 0.02);
}

async function getTranscriptWithFallback({ url, language, videoPath, jobId, jobDir }) {
  const youtubeTranscript = await fetchTranscript(url, language);
  if (youtubeTranscript && youtubeTranscript.length) {
    return youtubeTranscript;
  }

  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  updateJob(jobId, { step: 1, message: "Transcribing audio with OpenAI...", progress: 0.25 });

  const audioPath = path.join(jobDir, "audio.m4a");
  await extractAudio(videoPath, audioPath);
  return await transcribeWithOpenAI(audioPath, language);
}

function scoreText(text, goal) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordScore = words.length;
  const exclamations = (text.match(/[!?]/g) || []).length;
  const hookWords = ["secret", "mistake", "fast", "tip", "hack", "why", "how", "stop", "start", "best", "worst", "truth", "real"];
  const storyWords = ["then", "suddenly", "but", "until", "finally", "turned", "realized"];
  const tutorialWords = ["step", "first", "second", "third", "next", "exactly", "change", "setup"];

  const list = goal === "story" ? storyWords : goal === "tutorial" ? tutorialWords : hookWords;
  const hookScore = list.reduce((sum, word) => (lower.includes(word) ? sum + 2 : sum), 0);

  return wordScore + exclamations * 2 + hookScore;
}

function selectHighlights(transcript, durationSeconds, options) {
  const target = options.targetDuration;
  const desiredCount = options.count;
  const goal = options.goal;
  const maxStart = Math.max(0, durationSeconds - target - 1);

  const candidates = [];
  for (let i = 0; i < transcript.length; i += 1) {
    const start = transcript[i].offset;
    if (start < 5 || start > maxStart) continue;
    const end = start + target;
    const windowItems = transcript.filter(
      (item) => item.offset < end && item.offset + item.duration > start
    );
    const text = windowItems.map((item) => item.text).join(" ");
    const score = scoreText(text, goal);
    candidates.push({ start, end, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picks = [];
  const minSpacing = target * 0.6;

  for (const candidate of candidates) {
    if (picks.length >= desiredCount) break;
    const overlaps = picks.some((pick) => Math.abs(pick.start - candidate.start) < minSpacing);
    if (!overlaps) {
      picks.push(candidate);
    }
  }

  if (picks.length < desiredCount) {
    const fallback = [0.12, 0.45, 0.72].slice(0, desiredCount);
    fallback.forEach((ratio) => {
      const start = Math.min(maxStart, Math.max(0, durationSeconds * ratio));
      const end = Math.min(durationSeconds, start + target);
      picks.push({ start, end, score: 0 });
    });
  }

  return picks.slice(0, desiredCount).map((pick, index) => ({
    id: index + 1,
    start: pick.start,
    end: pick.end,
    duration: pick.end - pick.start,
  }));
}

function filterTranscript(transcript, start, end) {
  return transcript.filter(
    (item) => item.offset < end && item.offset + item.duration > start
  );
}

async function writeSrtFile(transcript, start, end, filePath) {
  const lines = [];
  let index = 1;
  const items = filterTranscript(transcript, start, end);

  for (const item of items) {
    const localStart = Math.max(item.offset, start) - start;
    const localEnd = Math.min(item.offset + item.duration, end) - start;
    if (localEnd - localStart < 0.08) continue;
    lines.push(String(index));
    lines.push(`${formatSrtTime(localStart)} --> ${formatSrtTime(localEnd)}`);
    lines.push(item.text.trim());
    lines.push("");
    index += 1;
  }

  await fs.promises.writeFile(filePath, lines.join("\n"), "utf8");
}

async function writeVttFile(transcript, start, end, filePath) {
  const lines = ["WEBVTT", ""]; 
  const items = filterTranscript(transcript, start, end);

  for (const item of items) {
    const localStart = Math.max(item.offset, start) - start;
    const localEnd = Math.min(item.offset + item.duration, end) - start;
    if (localEnd - localStart < 0.08) continue;
    lines.push(`${buildVttTime(localStart)} --> ${buildVttTime(localEnd)}`);
    lines.push(item.text.trim());
    lines.push("");
  }

  await fs.promises.writeFile(filePath, lines.join("\n"), "utf8");
}

async function getVideoDimensions(filePath) {
  const metadata = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  const videoStream = metadata.streams.find((stream) => stream.codec_type === "video");
  if (!videoStream) throw new Error("Unable to read video stream.");
  return { width: videoStream.width, height: videoStream.height };
}

function buildCropFilters(width, height) {
  const targetRatio = 9 / 16;
  const currentRatio = width / height;
  let crop = "";

  if (currentRatio > targetRatio) {
    const newWidth = Math.floor(height * targetRatio);
    const x = Math.floor((width - newWidth) / 2);
    crop = `crop=${newWidth}:${height}:${x}:0`;
  } else {
    const newHeight = Math.floor(width / targetRatio);
    const y = Math.floor((height - newHeight) / 2);
    crop = `crop=${width}:${newHeight}:0:${y}`;
  }

  return [crop, "scale=1080:1920", "setsar=1"];
}

async function renderClip({
  inputPath,
  outputPath,
  start,
  duration,
  subtitlePath,
  subtitleStyle,
  burnIn,
  cropFilters,
}) {
  const filters = [...cropFilters];
  if (burnIn && subtitlePath) {
    const style = STYLE_MAP[subtitleStyle] || STYLE_MAP.kinetic;
    const safePath = escapeFilterPath(subtitlePath);
    filters.push(`subtitles='${safePath}':force_style='${style}'`);
  }

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .duration(duration)
      .videoFilters(filters)
      .audioCodec("aac")
      .videoCodec("libx264")
      .outputOptions(["-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

async function zipOutputs(jobDir, files) {
  const zipPath = path.join(jobDir, "clipspark_output.zip");
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.pipe(output);
  files.forEach((file) => {
    archive.file(file.path, { name: file.name });
  });

  await archive.finalize();
  await once(output, "close");
  return zipPath;
}

async function fetchTranscript(url, language) {
  try {
    return await YoutubeTranscript.fetchTranscript(url, language ? { lang: language } : undefined);
  } catch (error) {
    return null;
  }
}

async function runJob(jobId, payload) {
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clipspark-"));

  try {
    updateJob(jobId, { status: "processing", step: 0, message: "Downloading video...", progress: 0.1, jobDir });

    const ytdlOptions = buildYtdlOptions();
    const info = await ytdl.getInfo(payload.url, ytdlOptions);
    const videoTitle = sanitizeTitle(info.videoDetails?.title);
    const videoDuration = Number(info.videoDetails?.lengthSeconds || 0);
    const videoPath = path.join(jobDir, "source.mp4");

    const format = ytdl.chooseFormat(info.formats, {
      quality: "highest",
      filter: (item) => item.hasAudio && item.hasVideo && item.container === "mp4",
    });

    const downloadStream = ytdl.downloadFromInfo(info, { format, ...ytdlOptions });
    await pipeline(downloadStream, fs.createWriteStream(videoPath));

    updateJob(jobId, { step: 1, message: "Fetching transcript...", progress: 0.2 });
    const transcript = await getTranscriptWithFallback({
      url: payload.url,
      language: payload.language,
      videoPath,
      jobId,
      jobDir,
    });

    if (!transcript || !transcript.length) {
      throw new Error(
        "No transcript found. Add captions on YouTube or set OPENAI_API_KEY for auto transcription."
      );
    }

    updateJob(jobId, { message: "Detecting highlights...", progress: 0.35 });

    const lengthMap = {
      short: 24,
      medium: 36,
      long: 52,
    };

    const targetDuration = lengthMap[payload.length] || lengthMap.short;
    const clips = selectHighlights(transcript, videoDuration || 600, {
      targetDuration,
      count: 3,
      goal: payload.goal || "highlights",
    });

    const { width, height } = await getVideoDimensions(videoPath);
    const cropFilters = buildCropFilters(width, height);

    const outputFiles = [];

    for (const clip of clips) {
      updateJob(jobId, { step: 2, message: `Rendering clip ${clip.id}...`, progress: 0.45 + clip.id * 0.15 });

      const clipBase = `clip_${clip.id}`;
      const clipVideoPath = path.join(jobDir, `${clipBase}.mp4`);
      const srtPath = path.join(jobDir, `${clipBase}.srt`);
      const vttPath = path.join(jobDir, `${clipBase}.vtt`);

      await writeSrtFile(transcript, clip.start, clip.end, srtPath);
      await writeVttFile(transcript, clip.start, clip.end, vttPath);

      updateJob(jobId, { step: 3, message: "Burning subtitles...", progress: 0.65 + clip.id * 0.05 });
      await renderClip({
        inputPath: videoPath,
        outputPath: clipVideoPath,
        start: clip.start,
        duration: clip.duration,
        subtitlePath: srtPath,
        subtitleStyle: payload.subtitleStyle,
        burnIn: payload.burnIn,
        cropFilters,
      });

      outputFiles.push({ path: clipVideoPath, name: `${videoTitle}_${clipBase}.mp4` });
      outputFiles.push({ path: srtPath, name: `${videoTitle}_${clipBase}.srt` });
      outputFiles.push({ path: vttPath, name: `${videoTitle}_${clipBase}.vtt` });
    }

    updateJob(jobId, { step: 4, message: "Packaging exports...", progress: 0.95 });
    const zipPath = await zipOutputs(jobDir, outputFiles);

    updateJob(jobId, {
      status: "done",
      step: 4,
      message: "Highlights ready.",
      progress: 1,
      outputZip: zipPath,
    });
  } catch (error) {
    const rawMessage = error.message || "Unable to process video.";
    const is403 = rawMessage.includes("Status code: 403");
    const hint = is403
      ? "YouTube blocked the server (403). Try another video, or set YTDL_COOKIE in Render."
      : rawMessage;

    updateJob(jobId, {
      status: "error",
      message: "Processing failed.",
      error: hint,
    });
  }
}

app.post("/api/highlights", async (req, res) => {
  const { url, goal, length, subtitleStyle, burnIn, platforms, language } = req.body || {};

  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).json({ error: "Enter a valid YouTube URL." });
  }

  const job = createJob();
  updateJob(job.id, {
    status: "processing",
    step: 0,
    message: "Starting job...",
    progress: 0,
    meta: { goal, length, subtitleStyle, burnIn, platforms, language },
  });

  runJob(job.id, { url, goal, length, subtitleStyle, burnIn, platforms, language });

  return res.json({ jobId: job.id });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  return res.json({
    id: job.id,
    status: job.status,
    step: job.step,
    message: job.error ? job.error : job.message,
    progress: job.progress,
    downloadReady: Boolean(job.outputZip),
  });
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.outputZip) {
    return res.status(404).json({ error: "Output not ready." });
  }

  res.download(job.outputZip, "clipspark_output.zip");
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.updatedAt > JOB_TTL_MS) {
      if (job.jobDir) {
        try {
          await fs.promises.rm(job.jobDir, { recursive: true, force: true });
        } catch (error) {
          // ignore cleanup errors
        }
      }
      jobs.delete(id);
    }
  }
}, 1000 * 60 * 10);

app.listen(PORT, () => {
  console.log(`ClipSpark running on http://localhost:${PORT}`);
});
