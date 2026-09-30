/** Largest side of a captured photo (keeps uploads well under the 2 MB limit). */
const MAX_SIDE = 1280;

/**
 * Draws the current frame of a playing video onto a canvas and returns it
 * as a JPEG. Null when the browser has no picture yet or cannot encode.
 */
export function captureVideoFrame(video: HTMLVideoElement, quality = 0.85): Promise<Blob | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return Promise.resolve(null);
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality));
}

/** A frame from a live stream (no element on screen): used once during a video interview. */
export async function captureStreamFrame(stream: MediaStream): Promise<Blob | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth) {
      await new Promise<void>((resolve) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        setTimeout(resolve, 2_000);
      });
    }
    return await captureVideoFrame(video);
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}
