// Helpers for keeping the watermarked video as close to the original as possible, and for proving it.

const KNOWN = (value) => (value && value !== "unknown" && value !== "unspecified" ? value : undefined);

/**
 * ffmpeg options that carry the source's colour description over to the output. Without them an encoder may leave the
 * tags unset and some players then guess a different matrix or range, which shifts colours.
 */
export function colorArgs(stream) {
  const args = [];
  const range = KNOWN(stream.color_range);
  if (range === "tv" || range === "pc") args.push("-color_range", range);
  const space = KNOWN(stream.color_space);
  if (space) args.push("-colorspace", space);
  const primaries = KNOWN(stream.color_primaries);
  if (primaries) args.push("-color_primaries", primaries);
  const trc = KNOWN(stream.color_transfer);
  if (trc) args.push("-color_trc", trc);
  return args;
}

/** Output pixel format: keep 8-bit 4:2:0 exactly as the source has it (also the "full range" variant), else yuv420p. */
export function outputPixFmt(sourcePixFmt) {
  return sourcePixFmt === "yuv420p" || sourcePixFmt === "yuvj420p" ? sourcePixFmt : "yuv420p";
}

/** Extracts PSNR (dB) and SSIM (0..1) from ffmpeg's log. Missing values come back as null. */
export function parseQuality(log) {
  const ssim = /SSIM[^\n]*?All:([0-9.]+)/.exec(log)?.[1];
  const psnr = /PSNR[^\n]*?average:([0-9.]+|inf)/.exec(log)?.[1];
  return {
    ssim: ssim ? Number(ssim) : null,
    psnr: psnr ? (psnr === "inf" ? 99 : Number(psnr)) : null,
  };
}

/**
 * ffmpeg arguments that compare the original with the watermarked file over a short sample, with the logo area blacked
 * out on both sides so only the picture that should be untouched is measured. One metric per run ("ssim" or "psnr"):
 * a single graph feeding two null outputs can stall ffmpeg.
 */
export function qualityArgs({ src, out, rect, start, seconds, metric }) {
  const box = `drawbox=x=${Math.max(0, rect.x - 4)}:y=${Math.max(0, rect.y - 4)}:w=${rect.w + 8}:h=${rect.h + 8}:color=black:t=fill`;
  return [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    "-ss", String(start), "-t", String(seconds), "-i", src,
    "-ss", String(start), "-t", String(seconds), "-i", out,
    "-lavfi", `[0:v]${box}[a];[1:v]${box}[b];[a][b]${metric}`,
    "-f", "null", "-",
  ];
}
