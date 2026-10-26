// Self-test of the video pipeline on a synthetic clip, run by .github/workflows/selftest.yml. It never touches Drive or
// the gallery site: it renders a 4K, high-bitrate, BT.709 clip with the real worker code and compares the result with the
// source (resolution, frame count, colour description, PSNR/SSIM outside the logo).
import { execFile } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { measureVideoQuality, renderVideo } from "./worker.mjs";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "selftest-"));
const src = join(dir, "in.mp4");
const out = join(dir, "out.mp4");
const logoPath = join(dir, "logo.png");

// A 10 s 4K30 clip with noise (hard to compress, like real footage) at 100 Mbit/s, tagged like a DJI recording.
await run("ffmpeg", [
  "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", `testsrc2=size=3840x2160:rate=30,noise=alls=${process.env.SELFTEST_NOISE ?? 10}:allf=t+u`,
  "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
  "-t", "10",
  "-c:v", "libx264", "-b:v", "100M", "-maxrate", "100M", "-bufsize", "200M", "-pix_fmt", "yuv420p",
  "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-c:a", "aac", "-shortest", src,
]);
await sharp({ create: { width: 600, height: 200, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.9 } } }).png().toFile(logoPath);

const probe = async (file) => {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-count_packets", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,pix_fmt,r_frame_rate,nb_read_packets,bit_rate,color_range,color_space,color_primaries,color_transfer,profile",
    "-of", "json", file,
  ]);
  return JSON.parse(stdout).streams[0];
};

const settings = { position: { mode: "grid", anchor: "br" }, sizePct: 18, opacity: 0.7, marginPct: 3 };
const started = Date.now();
const { rect, duration } = await renderVideo({ src, logoPath, out, settings, dir });
const renderSeconds = Math.round((Date.now() - started) / 1000);
const quality = await measureVideoQuality({ src, out, rect, duration });
const [a, b] = [await probe(src), await probe(out)];

const keys = ["width", "height", "pix_fmt", "r_frame_rate", "nb_read_packets", "color_range", "color_space", "color_primaries", "color_transfer"];
const mismatches = keys.filter((k) => a[k] !== b[k]);
const mbps = (s, f) => (Number(s.bit_rate) / 1e6).toFixed(1);
console.log(JSON.stringify({
  renderSeconds,
  source: { ...Object.fromEntries(keys.map((k) => [k, a[k]])), mbps: mbps(a), mb: (statSync(src).size / 1e6).toFixed(1) },
  output: { ...Object.fromEntries(keys.map((k) => [k, b[k]])), mbps: mbps(b), mb: (statSync(out).size / 1e6).toFixed(1), profile: b.profile },
  quality,
  mismatches,
}, null, 2));

console.log(`SWEEP crf=${process.env.WORKER_CRF ?? "default"} noise=${process.env.SELFTEST_NOISE ?? 10} src=${mbps(a)}Mbps out=${mbps(b)}Mbps (${((Number(b.bit_rate) / Number(a.bit_rate) - 1) * 100).toFixed(0)}%) psnr=${quality?.psnr?.toFixed(1)}dB ssim=${quality?.ssim?.toFixed(4)} render=${renderSeconds}s`);
if (process.env.SELFTEST_SOFT) process.exit(0);
const problems = [];
if (mismatches.length) problems.push(`stream properties differ: ${mismatches.join(", ")}`);
if (!quality || quality.psnr == null || quality.ssim == null) problems.push("quality could not be measured");
else {
  if (quality.psnr < 42) problems.push(`PSNR ${quality.psnr} dB is below 42`);
  if (quality.ssim < 0.99) problems.push(`SSIM ${quality.ssim} is below 0.99`);
}
if (problems.length) {
  console.error("SELFTEST FAILED:", problems.join("; "));
  process.exit(1);
}
console.log("SELFTEST OK");
