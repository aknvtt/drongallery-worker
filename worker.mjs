// Watermark worker. Runs inside GitHub Actions (see .github/workflows/watermark.yml).
//
// It asks the gallery site for jobs one at a time over HMAC-signed requests, downloads the original from Google Drive
// with a short-lived token the site hands out per job, renders the watermarked copy, verifies that no GPS data survived,
// uploads the copy back to Drive and reports the new file id. Nothing in this repository is secret: the site URL and the
// shared signing key come from repository secrets, and file names/ids are never printed (they are also masked).

import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync, statSync, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { computeOverlayRect } from "./overlay-math.mjs";
import { colorArgs, outputPixFmt, parseQuality, qualityArgs } from "./quality.mjs";

const run = promisify(execFile);
const SITE = (process.env.GALLERY_SITE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.WORKER_HMAC_SECRET ?? "";

const DEFAULT_CRF = 18; // x264 quality: lower is closer to the source (and bigger). WORKER_CRF overrides it for experiments.
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB, as Drive requires
const mask = (value) => value && console.log(`::add-mask::${value}`);

class JobError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// --- signed calls to the site ------------------------------------------------------------------------------------

function sign(path, body) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = ["POST", path, ts, nonce, bodyHash].join("\n");
  return { "x-ts": ts, "x-nonce": nonce, "x-signature": createHmac("sha256", SECRET).update(canonical).digest("hex") };
}

async function site(path, payload) {
  const body = JSON.stringify(payload);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${SITE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sign(path, body) },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return await res.json();
      if (res.status < 500 || attempt >= 3) throw new JobError(`site-${res.status}`);
    } catch (err) {
      if (err instanceof JobError) throw err;
      if (attempt >= 3) throw new JobError("site-unreachable");
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// --- Google Drive ------------------------------------------------------------------------------------------------

async function driveDownload(token, fileId, dest, expectedSize) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      if (expectedSize && statSync(dest).size !== expectedSize) throw new Error("size mismatch");
      return;
    } catch {
      if (attempt >= 3) throw new JobError("download-failed");
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function driveUpload(token, { path, name, mimeType, parentId }) {
  const size = statSync(path).size;
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mimeType,
      "x-upload-content-length": String(size),
    },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  const session = start.headers.get("location");
  if (!start.ok || !session) throw new JobError("upload-failed");

  const handle = await open(path, "r");
  try {
    let offset = 0;
    let failures = 0;
    while (offset < size) {
      const end = Math.min(offset + CHUNK, size);
      const chunk = Buffer.alloc(end - offset);
      await handle.read(chunk, 0, chunk.length, offset);
      let res;
      try {
        res = await fetch(session, {
          method: "PUT",
          headers: { "content-range": `bytes ${offset}-${end - 1}/${size}`, "content-length": String(chunk.length) },
          body: chunk,
        });
      } catch {
        res = null;
      }
      if (res && (res.status === 200 || res.status === 201)) return (await res.json()).id;
      if (res && res.status === 308) {
        // Trust Drive's own count of persisted bytes (a node client can read the Range header).
        const range = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
        offset = range ? Number(range[1]) + 1 : end;
        failures = 0;
        continue;
      }
      if (++failures >= 5) throw new JobError("upload-failed");
      await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
      const probe = await fetch(session, { method: "PUT", headers: { "content-range": `bytes */${size}`, "content-length": "0" } }).catch(() => null);
      if (probe && (probe.status === 200 || probe.status === 201)) return (await probe.json()).id;
      if (probe && probe.status === 308) {
        const range = /bytes=0-(\d+)/.exec(probe.headers.get("range") ?? "");
        offset = range ? Number(range[1]) + 1 : 0;
      }
    }
  } finally {
    await handle.close();
  }
  throw new JobError("upload-failed");
}

// --- rendering ---------------------------------------------------------------------------------------------------

/** Logo scaled to its final size with the requested opacity baked into the alpha channel. */
async function prepareLogo(logoPath, rect, opacity) {
  const { data, info } = await sharp(logoPath)
    .resize({ width: rect.w, height: rect.h, fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * opacity);
  return { data, info };
}

export async function renderPhoto({ src, logoPath, out, settings }) {
  const meta = await sharp(src, { failOn: "none", limitInputPixels: false }).metadata();
  if (!meta.width || !meta.height) throw new JobError("process-failed");
  const swapped = (meta.orientation ?? 1) >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;

  const logoMeta = await sharp(logoPath).metadata();
  const rect = computeOverlayRect(width, height, logoMeta.width / logoMeta.height, settings);
  const logo = await prepareLogo(logoPath, rect, settings.opacity);

  await sharp(src, { failOn: "none", limitInputPixels: false })
    .rotate() // apply the EXIF orientation; metadata (incl. GPS) is not carried over to the output
    .composite([{ input: logo.data, raw: { width: logo.info.width, height: logo.info.height, channels: 4 }, left: rect.x, top: rect.y }])
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toFile(out);
}

async function probeVideo(src) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,duration:stream_side_data=rotation:stream_tags=rotate:format=duration",
    "-of", "json",
    src,
  ]);
  const json = JSON.parse(stdout);
  const stream = json.streams?.[0];
  if (!stream?.width || !stream?.height) throw new JobError("process-failed");
  const rotation = Math.abs(Number(stream.side_data_list?.[0]?.rotation ?? stream.tags?.rotate ?? 0)) % 180;
  // ffmpeg auto-rotates, so the overlay must be placed on the rotated frame.
  const size = rotation === 90 ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
  return { ...size, stream, duration: Number(stream.duration ?? json.format?.duration ?? 0) };
}

/**
 * Re-encodes the video with the logo on top. The picture keeps its resolution, frame timing, pixel format and colour
 * description; only the codec pass is lossy (x264 at CRF 18, which is visually transparent). Audio is copied bit-exact.
 */
export async function renderVideo({ src, logoPath, out, settings, dir }) {
  const { width, height, stream, duration } = await probeVideo(src);
  const logoMeta = await sharp(logoPath).metadata();
  const rect = computeOverlayRect(width, height, logoMeta.width / logoMeta.height, settings);
  const logo = await prepareLogo(logoPath, rect, settings.opacity);
  const overlay = join(dir, "overlay.png");
  await sharp(logo.data, { raw: { width: logo.info.width, height: logo.info.height, channels: 4 } }).png().toFile(overlay);
  const pixFmt = outputPixFmt(stream.pix_fmt);
  const crf = String(Math.min(28, Math.max(8, Number(process.env.WORKER_CRF) || DEFAULT_CRF)));

  await run(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", src,
      "-i", overlay,
      "-filter_complex", `[0:v][1:v]overlay=${rect.x}:${rect.y}:format=auto,format=${pixFmt}[v]`,
      "-map", "[v]", "-map", "0:a?",
      "-fps_mode", "passthrough", // never duplicate or drop frames
      "-c:v", "libx264", "-crf", crf, "-preset", "medium", "-profile:v", "high", "-pix_fmt", pixFmt,
      ...colorArgs(stream),
      "-c:a", "copy",
      // Only the picture and audio streams are mapped, so the drone's telemetry/GPS data track is dropped; also clear
      // container metadata.
      "-map_metadata", "-1", "-map_chapters", "-1",
      "-movflags", "+faststart",
      out,
    ],
    { maxBuffer: 10 * 1024 * 1024, timeout: 100 * 60_000, killSignal: "SIGKILL" },
  );
  return { rect, duration };
}

/**
 * Compares the result with the original over a short sample, ignoring the logo area. Best effort: a failure here never
 * fails the job.
 */
export async function measureVideoQuality({ src, out, rect, duration }) {
  try {
    const seconds = Math.min(12, Math.max(2, Math.floor(duration || 12)));
    const start = duration > seconds * 3 ? Math.floor(duration / 3) : 0;
    let log = "";
    for (const metric of ["ssim", "psnr"]) {
      const { stderr } = await run("ffmpeg", qualityArgs({ src, out, rect, start, seconds, metric }), { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60_000, killSignal: "SIGKILL" });
      log += stderr;
    }
    return parseQuality(log);
  } catch {
    return null;
  }
}

/** Strips every metadata block and then proves no GPS tag is left. */
async function stripAndVerify(file) {
  await run("exiftool", ["-all=", "-overwrite_original", "-q", file]).catch(() => undefined);
  const { stdout } = await run("exiftool", ["-json", "-a", "-G1", "-ee", file], { maxBuffer: 20 * 1024 * 1024 });
  const tags = Object.keys(JSON.parse(stdout)[0] ?? {});
  if (tags.some((tag) => /gps/i.test(tag))) throw new JobError("gps-leak");
}

// --- one job ----------------------------------------------------------------------------------------------------

async function handle(job) {
  mask(job.id);
  mask(job.source.fileId);
  mask(job.logoFileId);
  mask(job.outputFolderId);
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "wm-"));
  try {
    // Room for the original, the render and scratch space.
    const free = statfsSync(dir).bavail * statfsSync(dir).bsize;
    if (free < job.source.size * 3 + 300 * 1024 * 1024) throw new JobError("too-large");

    const { accessToken } = await site("/api/worker/token", { jobId: job.id });
    mask(accessToken);

    const ext = (extname(job.source.name) || (job.kind === "video" ? ".mp4" : ".jpg")).toLowerCase();
    const src = join(dir, `source${ext}`);
    const logoPath = join(dir, "logo.png");
    await driveDownload(accessToken, job.source.fileId, src, job.source.size);
    await driveDownload(accessToken, job.logoFileId, logoPath);

    const out = join(dir, job.kind === "video" ? "out.mp4" : "out.jpg");
    let quality = null;
    try {
      if (job.kind === "video") {
        const done = await renderVideo({ src, logoPath, out, settings: job.settings, dir });
        quality = await measureVideoQuality({ src, out, rect: done.rect, duration: done.duration });
      } else await renderPhoto({ src, logoPath, out, settings: job.settings });
    } catch (err) {
      throw err instanceof JobError ? err : new JobError("process-failed");
    }
    await stripAndVerify(out).catch((err) => {
      throw err instanceof JobError ? err : new JobError("process-failed");
    });

    const stem = basename(job.source.name, extname(job.source.name)).replace(/[^\w.-]+/g, "_").slice(0, 100) || "item";
    const wmFileId = await driveUpload(accessToken, {
      path: out,
      name: `${stem}-wm${job.kind === "video" ? ".mp4" : ".jpg"}`,
      mimeType: job.kind === "video" ? "video/mp4" : "image/jpeg",
      parentId: job.outputFolderId,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    await site("/api/worker/complete", {
      ok: true,
      jobId: job.id,
      wmFileId,
      seconds,
      ...(quality?.psnr != null && quality?.ssim != null ? { psnr: quality.psnr, ssim: quality.ssim } : {}),
    });
    console.log(`job ok kind=${job.kind} in=${(job.source.size / 1e6).toFixed(1)}MB out=${(statSync(out).size / 1e6).toFixed(1)}MB seconds=${seconds}${quality?.psnr != null ? ` psnr=${quality.psnr.toFixed(1)}dB ssim=${quality.ssim}` : ""}`);
  } catch (err) {
    const code = err instanceof JobError ? err.code : "process-failed";
    console.log(`job failed kind=${job.kind} code=${code}`);
    await site("/api/worker/complete", { ok: false, jobId: job.id, seconds: Math.round((Date.now() - started) / 1000), code: ["download-failed", "too-large", "process-failed", "upload-failed", "gps-leak", "no-logo", "timeout"].includes(code) ? code : "process-failed" }).catch(() => undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (!SITE.startsWith("https://") || SECRET.length < 32) {
    console.error("Missing GALLERY_SITE_URL / WORKER_HMAC_SECRET");
    process.exit(1);
  }
  let processed = 0;
  for (;;) {
    const { job } = await site("/api/worker/next", {});
    if (!job) break;
    await handle(job);
    processed++;
  }
  console.log(`queue empty, jobs handled: ${processed}`);
}

// Only run the queue when started directly (tests import renderPhoto without side effects).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

