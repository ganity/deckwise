import React, { Fragment, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FixedCoursewarePlayer, englishPlayerLabels, chinesePlayerLabels, loadFixedBuild, loadTeamFixedBuild, createMediaTaskAssetResolver, type LoadedFixedBuild } from '../dist/player.mjs';
import '../dist/player.css';

const Boundary = new URLSearchParams(location.search).has("strict") ? StrictMode : Fragment;

function Probe() {
  const [build, setBuild] = useState<LoadedFixedBuild>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let loaded: LoadedFixedBuild | undefined;
    void (async () => {
      if (new URLSearchParams(location.search).has("team-fixed")) {
        const { pointer, fixedBuild } = await fetch("/team-fixed-selection.json", { signal: controller.signal }).then(r => r.json());
        const expected = { buildId: pointer.buildId, snapshotId: pointer.snapshotId, packageSha256: pointer.packageSha256 };
        loaded = await loadTeamFixedBuild(fixedBuild, expected, async (path, signal) => {
          // Offline Host transport replay; production Host owns authenticated signed-URL retrieval.
          const response = await fetch(`/team-fixed-files/${path}`, { signal });
          if (!response.ok) throw new Error(`Team file request failed (${response.status})`);
          return new Uint8Array(await response.arrayBuffer());
        }, controller.signal);
        setBuild(loaded);
        return;
      }
      const { buildId } = await fetch("/fixture.json").then((r) => r.json());
      const response = await fetch("/build/package.json");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const taskResolver = new URLSearchParams(location.search).has(
        "media-tasks",
      )
        ? createMediaTaskAssetResolver(
            await fetch("/media-tasks.json").then((r) => r.json()),
            async (taskId, signal) => {
              const response = await fetch(
                `/courseware/media/tasks/${taskId}/asset`,
                { signal },
              );
              if (!response.ok)
                throw new Error(`Asset request failed (${response.status})`);
              return new Uint8Array(await response.arrayBuffer());
            },
          )
        : undefined;
      loaded = await loadFixedBuild(
        bytes,
        buildId,
        async (asset, signal) => {
          // This fixture's PPTX-embedded media stays local; external narration uses the C response adapter.
          if (taskResolver && !asset.id.startsWith("import-asset:"))
            return taskResolver(asset, signal);
          const response = await fetch(`/build/${asset.path}`, {
            signal,
          });
          if (!response.ok) throw new Error("Asset request failed");
          return new Uint8Array(await response.arrayBuffer());
        },
        controller.signal,
      );
      setBuild(loaded);
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      controller.abort();
      loaded?.dispose();
    };
  }, []);
  useEffect(() => {
    if (!build || !new URLSearchParams(location.search).has("autostart"))
      return;
    // Synthetic click deliberately does not confer browser user activation.
    document.querySelectorAll("button").forEach((button) => {
      if (button.textContent === "Play") button.click();
    });
  }, [build]);
  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-[1008px] bg-white px-6 pb-2 shadow-sm">
        {error ? (
          <p role="alert">{error}</p>
        ) : build ? (
          <Boundary><FixedCoursewarePlayer build={build} labels={new URLSearchParams(location.search).has("zh") ? chinesePlayerLabels : englishPlayerLabels} width={960} /></Boundary>
        ) : (
          <p>Loading fixed lesson…</p>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Probe />);
