export type RendererGoneDetails = Readonly<{ reason: string; exitCode: number }>;

export function recoverRendererAfterGone(
  details: RendererGoneDetails,
  dependencies: Readonly<{
    isCurrentWindow: boolean;
    quitting: boolean;
    windowCloseAccepted: boolean;
    windowDestroyed: boolean;
    webContentsDestroyed: boolean;
    reload: () => void;
    log: (details: RendererGoneDetails, reloaded: boolean) => void;
  }>,
): boolean {
  const reloaded = details.reason !== "clean-exit" &&
    dependencies.isCurrentWindow &&
    !dependencies.quitting &&
    !dependencies.windowCloseAccepted &&
    !dependencies.windowDestroyed &&
    !dependencies.webContentsDestroyed;
  dependencies.log(details, reloaded);
  if (reloaded) dependencies.reload();
  return reloaded;
}
