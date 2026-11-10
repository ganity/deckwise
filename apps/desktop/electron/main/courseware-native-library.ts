import type { CoursewareTeachingView } from "@pi-desktop/shared";
import type { CoursewareNativeMusic } from "./courseware-native-music";
import type { CoursewareNativeVideo } from "./courseware-native-video";
type Result = { value: unknown } | undefined;
/** Browse existing task journals; only the explicit adopt command queries and adopts results. */
export async function routeNativeMediaLibrary(input: {
  operation: string; args: Record<string, unknown>; page: number; result: Result;
  open(): Promise<Result>;
  music: Pick<CoursewareNativeMusic, "jobs" | "execute">;
  video: Pick<CoursewareNativeVideo, "jobs" | "execute">;
}): Promise<Result> {
  const { operation, args, page, result } = input;
  if (!result || !["media:list", "media:adopt"].includes(operation) ||
      !result.value || typeof result.value !== "object" || Reflect.get(result.value, "nativeService") !== true) return;
  const current = await input.open(), view = current!.value as CoursewareTeachingView;
  if (operation === "media:list") {
    const pending = [...await input.music.jobs(page, view), ...await input.video.jobs(page, view)];
    if (JSON.stringify((await input.open())?.value) !== JSON.stringify(view)) throw new Error("Native media page changed");
    return { value: [...Reflect.get(result.value, "embedded") as unknown[], ...pending.map(job => ({ ...job,
      title: `待采纳 ${job.kind}`, model: "generated", inPage: false }))] };
  }
  const { actionId: _unused, ...selection } = args;
  const adopted = args.kind === "music" ? await input.music.execute(selection, false, page, view, () => true)
    : args.kind === "video" ? await input.video.execute(selection, false, page, view, () => true) : undefined;
  if (!adopted || !("applied" in adopted) || !adopted.applied) throw new Error("素材任务尚未完成，请稍后刷新再采纳");
  return input.open();
}
