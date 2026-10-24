import { expect, it } from "vitest";
import { bindMediaDucking } from "./media-ducking";

it("ducks page media, keeps native mute, and restores the user's volume after narration", () => {
  const media = new EventTarget() as HTMLMediaElement;
  media.volume = 0.6;
  media.muted = true;
  const release = bindMediaDucking(media);
  expect(media.volume).toBeCloseTo(0.12);
  media.dispatchEvent(new Event("volumechange"));
  expect(media.volume).toBeCloseTo(0.12);
  media.volume = 0.8;
  media.dispatchEvent(new Event("volumechange"));
  expect(media.volume).toBeCloseTo(0.16);
  release();
  expect(media.volume).toBe(0.8);
  expect(media.muted).toBe(true);
  media.volume = 0.4;
  media.dispatchEvent(new Event("volumechange"));
  expect(media.volume).toBe(0.4);
});
