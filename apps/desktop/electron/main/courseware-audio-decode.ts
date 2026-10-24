import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { MAX_AUDIO_BYTES } from "./courseware-media";

const partition = `courseware-audio-${randomUUID()}`;
const document = "data:text/html;charset=utf-8,%3Cmeta%20http-equiv%3D%22Content-Security-Policy%22%20content%3D%22default-src%20'none'%22%3E";
let decoding = false;

/** Decode untrusted bytes without Node, preload, credentials, network or audio output. */
export async function decodeCoursewareAudio(bytes: Buffer, mime: "audio/wav" | "audio/mpeg"): Promise<number> {
  const matches = mime === "audio/wav" ? bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE"
    : mime === "audio/mpeg" && bytes.length >= 4 && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  if (!matches || bytes.length > MAX_AUDIO_BYTES) throw new Error("COURSEWARE_AUDIO_INVALID_FORMAT");
  if (decoding) throw new Error("COURSEWARE_AUDIO_DECODE_BUSY");
  decoding = true;
  let window: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    window = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== document }));
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
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data.buffer);
        return Math.round(audio.duration * 1000);
      })()`);
    };
    const duration: unknown = await Promise.race([decode(), failed]);
    if (!Number.isSafeInteger(duration) || Number(duration) < 1 || Number(duration) > 86_400_000) throw new Error("COURSEWARE_AUDIO_INVALID_DURATION");
    return Number(duration);
  } catch (error) {
    if (error instanceof Error && /^COURSEWARE_AUDIO_[A-Z_]+$/u.test(error.message)) throw error;
    throw new Error("COURSEWARE_AUDIO_DECODE_FAILED");
  } finally {
    clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    decoding = false;
  }
}
