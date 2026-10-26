// Where the watermark logo lands on a frame. Kept identical to src/lib/watermark/math.ts in the gallery site, which
// renders the preview the owner approves; the site's tests compare both implementations.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * @param {number} frameW
 * @param {number} frameH
 * @param {number} logoAspect logo width / height
 * @param {{ position: { mode: "grid", anchor: string } | { mode: "custom", x: number, y: number }, sizePct: number, marginPct: number }} settings
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function computeOverlayRect(frameW, frameH, logoAspect, settings) {
  const short = Math.min(frameW, frameH);
  const margin = (settings.marginPct / 100) * short;

  let w = (settings.sizePct / 100) * short;
  let h = w / logoAspect;
  const fit = Math.min(1, frameW / w, frameH / h);
  w *= fit;
  h *= fit;

  const { position } = settings;
  let x;
  let y;
  if (position.mode === "custom") {
    x = position.x * frameW - w / 2;
    y = position.y * frameH - h / 2;
  } else {
    const col = position.anchor[1] === "l" ? 0 : position.anchor[1] === "c" ? 1 : 2;
    const row = position.anchor[0] === "t" ? 0 : position.anchor[0] === "m" ? 1 : 2;
    x = col === 0 ? margin : col === 1 ? (frameW - w) / 2 : frameW - w - margin;
    y = row === 0 ? margin : row === 1 ? (frameH - h) / 2 : frameH - h - margin;
  }
  return {
    x: Math.round(clamp(x, 0, frameW - w)),
    y: Math.round(clamp(y, 0, frameH - h)),
    w: Math.round(w),
    h: Math.round(h),
  };
}
