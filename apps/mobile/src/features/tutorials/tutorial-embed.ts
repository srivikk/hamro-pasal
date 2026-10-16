/*
 * Step 7.8 (SPEC core 11): a tutorial plays inside the app, in YouTube's embedded player (the
 * privacy-enhanced youtube-nocookie.com domain), never in the YouTube app or the browser.
 */

const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The embedded player of one video: inline, without related videos from other channels. */
export function embedUrl(videoId: string): string {
  if (!VIDEO_ID.test(videoId)) throw new RangeError(`Not a YouTube video id: ${videoId}`);
  return `${EMBED_ORIGIN}/embed/${videoId}?playsinline=1&rel=0&modestbranding=1`;
}

/** The video's thumbnail for the floating card. */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * Whether the player may load `url`: only this video's embed page (and the blank page a WebView
 * starts on). A tap on the YouTube logo, "Watch on YouTube" or a channel link asks to go elsewhere
 * and is refused, so the viewer never leaves the app.
 */
export function isEmbedNavigation(url: string, videoId: string): boolean {
  if (url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === EMBED_ORIGIN && parsed.pathname === `/embed/${videoId}`;
}
