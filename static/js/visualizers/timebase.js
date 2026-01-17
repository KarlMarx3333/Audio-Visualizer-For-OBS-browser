export function dtFromFrameOrNow(frame, nowMs, self) {
  const dt = Number(frame?.dt);
  if (Number.isFinite(dt) && dt > 0) return dt;
  const last = self._lastNowMs;
  let out = last ? (nowMs - last) * 0.001 : 1 / 60;
  self._lastNowMs = nowMs;
  if (!Number.isFinite(out) || out <= 0) out = 1 / 60;
  return out;
}

export function tFromFrameOrSelf(frame, dt, self) {
  const t = Number(frame?.t);
  if (Number.isFinite(t) && t >= 0) return t;
  let acc = self._tFallback;
  if (!Number.isFinite(acc)) acc = 0;
  acc += dt;
  self._tFallback = acc;
  return acc;
}
