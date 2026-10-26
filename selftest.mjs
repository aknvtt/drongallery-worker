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

if (process.env.SELFTEST_DIAG) {
  const psnrOf = async (label, graph) => {
    try {
      const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "info", "-i", src, "-i", out, "-lavfi", graph, "-f", "null", "-"], { maxBuffer: 20 * 1024 * 1024, timeout: 120_000, killSignal: "SIGKILL" });
      console.log("DIAG", label, (/average:([0-9.]+|inf)/.exec(stderr) ?? [])[1], (/PSNR.*/.exec(stderr) ?? [""])[0].slice(0, 120));
    } catch (e) { console.log("DIAG", label, "error", String(e.stderr ?? e.message).slice(-300)); }
  };
  await psnrOf("full frame, as is", "[0:v][1:v]psnr");
  await psnrOf("crop 400x400 top-left (far from logo)", "[0:v]crop=400:400:100:100[a];[1:v]crop=400:400:100:100[b];[a][b]psnr");
  await psnrOf("first 30 frames only", "[0:v]select='lt(n,30)'[a];[1:v]select='lt(n,30)'[b];[a][b]psnr");
  await psnrOf("output delayed by one frame", "[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS+1/30/TB[b];[a][b]psnr");
  await psnrOf("source delayed by one frame", "[0:v]setpts=PTS-STARTPTS+1/30/TB[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]psnr");
  await psnrOf("setpts aligned", "[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]psnr");
  const { stdout: st } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time,duration,nb_frames", "-of", "csv=p=0", src]);
  const { stdout: ot } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time,duration,nb_frames", "-of", "csv=p=0", out]);
  // Where does the difference come from? Re-encode the same source three ways and compare each with the original.
  const variants = {
    "A plain re-encode, no filters": ["-i", src, "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
    "B overlay without format options": ["-i", src, "-i", join(dir, "overlay.png"), "-filter_complex", "[0:v][1:v]overlay=10:10[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast"],
    "C worker chain (format=auto, yuv420p)": ["-i", src, "-i", join(dir, "overlay.png"), "-filter_complex", "[0:v][1:v]overlay=10:10:format=auto,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
    "D worker chain + colour tags": ["-i", src, "-i", join(dir, "overlay.png"), "-filter_complex", "[0:v][1:v]overlay=10:10:format=auto,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"],
  };
  for (const [label, args] of Object.entries(variants)) {
    const file = join(dir, "v.mp4");
    try {
      await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-t", "3", ...args, file], { timeout: 120_000, killSignal: "SIGKILL" });
      const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "info", "-t", "3", "-i", src, "-i", file, "-lavfi", "[0:v]crop=400:400:600:600[a];[1:v]crop=400:400:600:600[b];[a][b]psnr", "-f", "null", "-"], { maxBuffer: 20 * 1024 * 1024, timeout: 120_000, killSignal: "SIGKILL" });
      console.log("DIAG variant", label, "psnr", (/average:([0-9.]+|inf)/.exec(stderr) ?? [])[1]);
    } catch (e) { console.log("DIAG variant", label, "error", String(e.stderr ?? e.message).slice(-200)); }
  }
  const nl = String.fromCharCode(10);
  console.log("DIAG timing src:", st.trim().split(nl).join(" | "), "out:", ot.trim().split(nl).join(" | "));
}
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
