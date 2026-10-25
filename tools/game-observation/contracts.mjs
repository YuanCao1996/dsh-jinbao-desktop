export const PROTOCOL_VERSION = 1;
const MAX_WINDOW_PIXELS = 32 * 1024 * 1024;
const QUALITY = { overview: 960, standard: 1440, detail: 2048 };

export function safeId(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

export function validateTarget(target) {
  if (!target || target.authorized !== true || target.kind !== 'window') {
    throw new Error('authorized_window_required');
  }
  safeId(target.id, 'window_id');
  const { width, height } = target;
  if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1
      || width * height > MAX_WINDOW_PIXELS) throw new Error('invalid_window_size');
  return { kind: 'window', id: target.id, authorized: true, width, height };
}

export function validateRoi(roi) {
  if (!roi || Object.keys(roi).sort().join(',') !== 'height,width,x,y') throw new Error('invalid_roi');
  const { x, y, width, height } = roi;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0
      || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error('roi_outside_window');
  }
  return { x, y, width, height };
}

// ROI coordinates are relative to the authorized window, never the desktop.
export function planObservation(targetInput, { roi = { x: 0, y: 0, width: 1, height: 1 },
  quality = 'overview', minIntervalMs = 1000 } = {}) {
  const target = validateTarget(targetInput);
  const normalized = validateRoi(roi);
  if (!Object.hasOwn(QUALITY, quality)) throw new Error('invalid_quality');
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 500 || minIntervalMs > 60000) {
    throw new Error('invalid_observation_interval');
  }
  const x = Math.floor(normalized.x * target.width);
  const y = Math.floor(normalized.y * target.height);
  const right = Math.min(target.width, Math.ceil((normalized.x + normalized.width) * target.width));
  const bottom = Math.min(target.height, Math.ceil((normalized.y + normalized.height) * target.height));
  const pixelRoi = { x, y, width: right - x, height: bottom - y };
  const scale = Math.min(1, QUALITY[quality] / Math.max(pixelRoi.width, pixelRoi.height));
  return {
    protocol_version: PROTOCOL_VERSION,
    target_id: target.id,
    roi: normalized,
    pixel_roi: pixelRoi,
    output_size: { width: Math.max(1, Math.round(pixelRoi.width * scale)),
      height: Math.max(1, Math.round(pixelRoi.height * scale)) },
    quality,
    min_interval_ms: minIntervalMs,
    max_age_ms: 5000,
    exclude_assistant: true,
  };
}

export function validateFrame(frame, target, nowMs) {
  if (!frame || frame.target_id !== target.id) throw new Error('frame_target_mismatch');
  if (frame.assistant_excluded !== true) throw new Error('assistant_not_excluded');
  if (![frame.width, frame.height].every(Number.isSafeInteger)
      || frame.width < 1 || frame.height < 1 || frame.width * frame.height > MAX_WINDOW_PIXELS) {
    throw new Error('invalid_frame_size');
  }
  if (!Number.isSafeInteger(frame.captured_at_ms) || frame.captured_at_ms < 0
      || frame.captured_at_ms > nowMs || nowMs - frame.captured_at_ms > 5000) {
    throw new Error('frame_not_fresh');
  }
  if (typeof frame.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(frame.sha256)) {
    throw new Error('invalid_frame_hash');
  }
  return { target_id: frame.target_id, width: frame.width, height: frame.height,
    captured_at_ms: frame.captured_at_ms, sha256: frame.sha256, assistant_excluded: true };
}

export function validateGeometry(geometry, frame, target) {
  if (geometry == null) return null;
  const { pixel_roi: roi, source_size: source, output_size: output } = geometry;
  if (!roi || !source || !output || source.width !== target.width || source.height !== target.height
      || output.width !== frame.width || output.height !== frame.height
      || ![roi.x, roi.y, roi.width, roi.height].every(Number.isSafeInteger)
      || roi.x < 0 || roi.y < 0 || roi.width < 1 || roi.height < 1
      || roi.x + roi.width > source.width || roi.y + roi.height > source.height)
    throw new Error('invalid_observation_geometry');
  return { pixel_roi: { x: roi.x, y: roi.y, width: roi.width, height: roi.height },
    source_size: { width: source.width, height: source.height },
    output_size: { width: output.width, height: output.height } };
}
