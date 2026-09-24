// Easing and timing helpers for Flow animations.

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Progress 0→1 of `t` through the window [a, b]. */
export const seg = (t: number, a: number, b: number) => (b <= a ? (t >= b ? 1 : 0) : clamp01((t - a) / (b - a)));

export const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
export const easeOut = (u: number) => 1 - (1 - u) ** 3;
export const easeOutBack = (u: number) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2;

/** Rises over [a, b], holds, and falls over [c, d]. */
export const pulse = (t: number, a: number, b: number, c: number, d: number) => Math.min(seg(t, a, b), 1 - seg(t, c, d));
