import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { MAX_AUDIO_BYTES } from "./courseware-media";
import type { PortableMediaMime } from "./courseware-portable-media";

const partition = `courseware-audio-${randomUUID()}`;
const document = "data:text/html;charset=utf-8," + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src blob:">');
const MAX_CONCURRENT_DECODES = 10;
let decoding = 0;
const waiting: Array<() => void> = [];

/** Decode untrusted bytes without Node, preload, credentials, network or audio output. */
export async function decodeCoursewareAudio(bytes: Buffer, mime: "audio/wav" | "audio/mpeg"): Promise<number> {
  return (await decodeMedia(bytes, mime)).durationMs;
}

export async function decodeCoursewareVideo(bytes: Buffer): Promise<{ durationMs: number; width: number; height: number }> {
  return decodeMedia(bytes, "video/mp4");
}

export async function decodeCoursewarePortableMedia(bytes: Buffer, mime: PortableMediaMime) {
  return decodeMedia(bytes, mime, 50 * 1024 * 1024, 3_600_000);
}

async function decodeMedia(bytes: Buffer, mime: PortableMediaMime, maxBytes = MAX_AUDIO_BYTES,
  maxDurationMs = mime === "video/mp4" ? 30_000 : 86_400_000): Promise<{ durationMs: number; width: number; height: number }> {
  const video = mime === "video/mp4";
  const matches = mime === "audio/wav" ? bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE"
    : video || mime === "audio/mp4" ? bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp"
    : mime === "audio/ogg" ? bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS"
    : mime === "audio/mpeg" && bytes.length >= 4 && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  if (!matches || bytes.length > maxBytes) throw new Error("COURSEWARE_AUDIO_INVALID_FORMAT");
  if (decoding >= MAX_CONCURRENT_DECODES) await new Promise<void>(resolve => waiting.push(resolve));
  else decoding++;
  let window: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    window = new BrowserWindow({ show: false, webPreferences: { partition: `${partition}-${video ? "video" : "audio"}`, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== document && !(video && details.url.startsWith("blob:")) }));
    const failed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("COURSEWARE_AUDIO_DECODE_TIMEOUT")), 30_000);
      contents.once("render-process-gone", () => reject(new Error("COURSEWARE_AUDIO_DECODE_FAILED")));
      window?.once("closed", () => reject(new Error("COURSEWARE_AUDIO_DECODE_FAILED")));
    });
    const decode = async () => {
      await window?.loadURL(document);
      return contents.executeJavaScript(`(async () => {
        const raw = atob(${JSON.stringify(bytes.toString("base64"))});
        const data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
        if (${video}) {
          const media = document.createElement('video');
          const url = URL.createObjectURL(new Blob([data], {type:'video/mp4'}));
          media.muted = true; media.preload = 'auto';
          try {
            const loaded = new Promise((resolve, reject) => { media.onloadeddata = resolve; media.onerror = () => reject(new Error('Invalid video')); });
            media.src = url; media.load(); await loaded;
            return {durationMs: Math.round(media.duration * 1000), width: media.videoWidth, height: media.videoHeight};
          } finally { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); }
        }
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data.buffer);
        return {durationMs: Math.round(audio.duration * 1000), width:0, height:0};
      })()`);
    };
    const metadata: unknown = await Promise.race([decode(), failed]);
    if (!metadata || typeof metadata !== "object") throw new Error("COURSEWARE_AUDIO_INVALID_DURATION");
    const duration = Reflect.get(metadata, "durationMs"), width = Reflect.get(metadata, "width"), height = Reflect.get(metadata, "height");
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > maxDurationMs ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || video && (width < 1 || height < 1 || width > 4096 || height > 4096))
      throw new Error("COURSEWARE_AUDIO_INVALID_DURATION");
    return { durationMs: duration, width, height };
  } catch (error) {
    if (error instanceof Error && /^COURSEWARE_AUDIO_[A-Z_]+$/u.test(error.message)) throw error;
    throw new Error("COURSEWARE_AUDIO_DECODE_FAILED");
  } finally {
    clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    const next = waiting.shift();
    if (next) next();
    else decoding--;
  }
}
