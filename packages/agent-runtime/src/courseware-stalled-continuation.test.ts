import { expect, it, vi } from "vitest";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import { CoursewareTurnContinuation } from "./courseware-turn-continuation.js";

const sourceSha256 = "a".repeat(64);
const closing: AgentTurnContext = { context: { messages: [] }, newMessages: [], toolResults: [], message: {
  role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 0,
  content: [{ type: "text", text: "Finished" }], stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} };
const activation: AgentTurnContext = { ...closing, message: { ...closing.message, stopReason: "toolUse", content: [
  { type: "toolCall", id: "start", name: "courseware_media_context", arguments: { continueTeaching: true } },
] }, toolResults: [{ role: "toolResult", toolCallId: "start", toolName: "courseware_media_context",
  timestamp: 0, content: [], isError: false, details: { sourceSha256 } }] };

it("rereads native source after each page adoption before refreshing the next original", async () => {
  const continuation = new CoursewareTurnContinuation();
  let adopted = 0;
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const sha = String(adopted).repeat(64);
    if (name === "courseware_media_refresh") {
      if (args.sourceSha256 !== sha) throw new Error("Native source changed");
      expect(args.intentId).toBe(`original-${adopted + 1}`);
      adopted++;
      return { content: [], details: { saved: true } };
    }
    return { content: [], details: { nativeTeaching: true, sourceSha256: sha,
      narrationReady: true, audioReady: adopted === 2, teachingReady: adopted === 2,
      completion: { ready: adopted === 2, issues: [] },
      jobs: [1, 2].filter(n => n > adopted).map(n => ({ kind: "tts", intentId: `original-${n}`, pageNumber: n, sourceSha256: sha })) } };
  });
  const controls = { execute, canWait: () => true };
  await continuation.finish(activation, controls);
  expect(await continuation.finish(closing, controls)).toContain("Saved courseware content, media and teaching checks are complete");
  expect(adopted).toBe(2);
  expect(execute.mock.calls.filter(([name]) => name === "courseware_media_refresh")).toHaveLength(2);
});

it("reconciles one native refresh exception against current state without declaring the provider failed", async () => {
  vi.useFakeTimers();
  const continuation = new CoursewareTurnContinuation();
  let refreshes = 0;
  const execute = vi.fn(async (name: string) => {
    if (name === "courseware_media_refresh") {
      if (++refreshes === 1) throw new Error("Native view changed before adoption");
      return { content: [], details: { saved: true } };
    }
    return { content: [], details: { nativeTeaching: true, sourceSha256, narrationReady: true,
      audioReady: refreshes === 2, teachingReady: refreshes === 2, completion: { ready: refreshes === 2, issues: [] },
      jobs: refreshes === 2 ? [] : [{ kind: "tts", intentId: "original", pageNumber: 1, sourceSha256 }] } };
  });
  const controls = { execute, canWait: () => true };
  try {
    await continuation.finish(activation, controls);
    const running = continuation.finish(closing, controls);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await running).toContain("Saved courseware content, media and teaching checks are complete");
    expect(refreshes).toBe(2);
    expect(execute.mock.calls.every(([name]) => !name.includes("prepare"))).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("bounds native exception reconciliation and reports the local stage without buying again", async () => {
  vi.useFakeTimers();
  const continuation = new CoursewareTurnContinuation();
  let refreshes = 0;
  const execute = vi.fn(async (name: string) => {
    if (name === "courseware_media_refresh") { refreshes++; throw new Error("Native adoption unavailable"); }
    return { content: [], details: { nativeTeaching: true, sourceSha256,
      jobs: [{ kind: "tts", intentId: "original", pageNumber: 1, sourceSha256 }] } };
  });
  const controls = { execute, canWait: () => true };
  try {
    await continuation.finish(activation, controls);
    const running = continuation.finish(closing, controls);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await running).toContain("does not confirm provider generation failure");
    expect(refreshes).toBe(2);
    expect(continuation.reportOnly).toBe(true);
    expect(execute.mock.calls.every(([name]) => !name.includes("prepare"))).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("accepts native completion when only optional assessment images remain", async () => {
  const continuation = new CoursewareTurnContinuation();
  const controls = { canWait: () => true, execute: vi.fn(async () => ({ content: [], details: {
    nativeTeaching: true, sourceSha256, narrationReady: true, audioReady: true, teachingReady: true,
    completion: { ready: true, issues: [] }, jobs: [],
    assessmentMedia: { ready: false, targets: [{ kind: "image", sceneId: "quiz", optionValue: "A" }] },
  } })) };
  await continuation.finish(activation, controls);
  expect(await continuation.finish(closing, controls)).toContain("Saved courseware content, media and teaching checks are complete");
  expect(controls.execute.mock.calls).toHaveLength(1);
});

it("queries an unknown original once, finishes independent music, then exits unfinished", async () => {
  vi.useFakeTimers();
  const continuation = new CoursewareTurnContinuation();
  const unknown = { kind: "tts", intentId: "original-tts", pageNumber: 4, sourceSha256 };
  const music = { kind: "music", intentId: "original-music", pageNumber: 1, sourceSha256 };
  let musicReads = 0, reads = 0;
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "courseware_media_refresh") {
      if (args.intentId === unknown.intentId) return { content: [], details: { saved: false, waitingFor: "service",
        media: { actionId: "speech", task: { state: "submission_unknown" } } } };
      musicReads++;
      return { content: [], details: { saved: musicReads >= 2, waitingFor: musicReads >= 2 ? null : "service" } };
    }
    reads++;
    return { content: [], details: { sourceSha256, narrationReady: true, audioReady: false, teachingReady: false,
      completion: { ready: false, issues: [{ pageNumber: 4, code: "AUDIO_MISSING", repair: "tts", repairable: true }] },
      jobs: musicReads >= 2 ? [unknown] : [unknown, music] } };
  });
  const controls = { execute, canWait: () => reads < 6 };
  try {
    await continuation.finish(activation, controls);
    const running = continuation.finish(closing, controls);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toContain("unknown");
    expect(musicReads).toBe(2);
    expect(execute.mock.calls.filter(([name, args]) => name === "courseware_media_refresh" && args.intentId === unknown.intentId)).toHaveLength(1);
    expect(await continuation.finish(closing, controls)).toBeUndefined();
    expect(execute.mock.calls.every(([name]) => !name.includes("prepare"))).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each([false, true])("bounds polling without counting timestamp, revision or repeated saved:true as progress (saved=%s)", async repeatedSave => {
  vi.useFakeTimers();
  const continuation = new CoursewareTurnContinuation();
  let reads = 0;
  const execute = vi.fn(async (name: string) => ({ content: [], details: name === "courseware_media_refresh"
    ? { saved: repeatedSave, waitingFor: "service", media: { task: { state: "processing" } } }
    : { sourceSha256, teachingRevision: `noise-${++reads}`, timestamp: Date.now(), jobs: [
      { kind: "music", intentId: "original", pageNumber: 1, sourceSha256 },
    ] } }));
  const controls = { execute, canWait: () => reads < 205 };
  try {
    await continuation.finish(activation, controls);
    const running = continuation.finish(closing, controls);
    await vi.advanceTimersByTimeAsync(610_000);
    expect(await running).toContain("no progress");
    expect(await continuation.finish(closing, controls)).toBeUndefined();
  } finally { vi.useRealTimers(); }
});

it("continues unsubmitted independent teaching while isolating the original unknown speech", async () => {
  const continuation = new CoursewareTurnContinuation();
  const job = { kind: "tts", intentId: "original", pageNumber: 1, sourceSha256 };
  let missing = true;
  const execute = vi.fn(async (name: string) => ({ content: [], details: name === "courseware_media_refresh"
    ? { saved: false, waitingFor: "service", media: { actionId: "speech", task: { state: "submission_unknown" } } }
    : { sourceSha256, jobs: [job], pages: [
      { pageNumber: 1, narrationReady: true, speeches: [{ actionId: "speech", audioReady: false }] },
      { pageNumber: 2, narrationReady: !missing, speeches: [] },
    ] } }));
  const controls = { execute, canWait: () => true };
  await continuation.finish(activation, controls);
  expect(await continuation.finish(closing, controls)).toContain("independent missing work");
  missing = false;
  expect(await continuation.finish(closing, controls)).toContain("results are unknown");
  expect(execute.mock.calls.filter(([name]) => name === "courseware_media_refresh")).toHaveLength(1);
});

it("ignores revision noise when the model closes without completing a missing step", async () => {
  const continuation = new CoursewareTurnContinuation();
  let revision = 0;
  const controls = { canWait: () => true, execute: async () => ({ content: [], details: {
    sourceSha256, jobs: [], narrationReady: false, teachingRevision: `t${++revision}`, timestamp: Date.now(),
  } }) };
  await continuation.finish(activation, controls);
  expect(await continuation.finish(closing, controls)).toContain("unfinished");
  expect(await continuation.finish(closing, controls)).toContain("no saved progress");
  expect(continuation.reportOnly).toBe(true);
  expect(await continuation.finish(closing, controls)).toBeUndefined();
});

it("retains a failed batch segment while finishing the other speech and independent music", async () => {
  const continuation = new CoursewareTurnContinuation();
  const first = { kind: "tts", intentId: "failed-original", pageNumber: 1, sourceSha256 };
  const second = { ...first, intentId: "successful-original" };
  const music = { kind: "music", intentId: "music-original", pageNumber: 2, sourceSha256 };
  let speechSaved = false, musicSaved = false;
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "courseware_media_refresh" && args.kind === "tts") {
      expect(args.intentIds).toEqual([first.intentId, second.intentId]);
      speechSaved = true;
      return { content: [], details: { saved: false, waitingFor: null,
        results: [{ job: second, saved: true }], failures: [{ intentId: first.intentId, error: "Original audio could not be decoded" }] } };
    }
    if (name === "courseware_media_refresh") { musicSaved = true; return { content: [], details: { saved: true } }; }
    return { content: [], details: { sourceSha256, jobs: [first, ...(!speechSaved ? [second] : []), ...(!musicSaved ? [music] : [])] } };
  });
  const controls = { execute, canWait: () => true };
  await continuation.finish(activation, controls);
  expect(await continuation.finish(closing, controls)).toContain("Original audio could not be decoded");
  expect(musicSaved).toBe(true);
  expect(execute.mock.calls.filter(([name]) => name === "courseware_media_refresh")).toHaveLength(2);
});

it("cannot rearm an exhausted workflow in its reporting pass; an explicit new-run reset can resume", async () => {
  vi.useFakeTimers();
  try {
    const continuation = new CoursewareTurnContinuation();
    const execute = vi.fn(async (name: string) => ({ content: [], details: name === "courseware_media_refresh"
      ? { saved: false, waitingFor: "service", media: { task: { state: "submission_unknown" } } }
      : { sourceSha256, jobs: [{ kind: "tts", intentId: "original", pageNumber: 1, sourceSha256 }] } }));
    const controls = { execute, canWait: () => true };
    await continuation.finish(activation, controls);
    const finish = async () => {
      const run = continuation.finish(closing, controls);
      await vi.advanceTimersByTimeAsync(10_000);
      return run;
    };
    expect(await finish()).toContain("unknown");
    const reads = execute.mock.calls.length;
    await continuation.finish(activation, controls);
    expect(await finish()).toBeUndefined();
    expect(execute.mock.calls).toHaveLength(reads);
    continuation.reset();
    await continuation.finish(activation, controls);
    expect(await finish()).toContain("unknown");
    expect(execute.mock.calls.length).toBeGreaterThan(reads);
  } finally { vi.useRealTimers(); }
});


it("does not classify a failed original batch segment as fresh missing speech", async () => {
  const continuation = new CoursewareTurnContinuation();
  const job = { kind: "tts", intentId: "original", pageNumber: 1, sourceSha256, actionId: "speech" };
  const execute = vi.fn(async (name: string) => ({ content: [], details: name === "courseware_media_refresh"
    ? { saved: false, failures: [{ intentId: job.intentId, error: "HTTP 500 original recovery unavailable" }] }
    : { sourceSha256, jobs: [job], completion: { ready: false,
        issues: [{ pageNumber: 1, actionId: "speech", code: "AUDIO_MISSING", repair: "tts", repairable: true }] },
      pages: [{ pageNumber: 1, narrationReady: true, speeches: [{ actionId: "speech", audioReady: false }] }] } }));
  const controls = { execute, canWait: () => true };
  await continuation.finish(activation, controls);
  expect(await continuation.finish(closing, controls)).toContain("results are unknown or failed");
  expect(continuation.reportOnly).toBe(true);
  expect(await continuation.finish(closing, controls)).toBeUndefined();
  expect(execute.mock.calls.filter(([name]) => name === "courseware_media_refresh")).toHaveLength(1);
});


it("finishes independent missing audio on the same page as a blocked original", async () => {
  const continuation = new CoursewareTurnContinuation();
  const job = { kind: "tts", intentId: "original", pageNumber: 1, sourceSha256, actionId: "blocked" };
  let independentSaved = false;
  const execute = vi.fn(async (name: string) => ({ content: [], details: name === "courseware_media_refresh"
    ? { saved: false, failures: [{ intentId: job.intentId, error: "Original recovery failed" }] }
    : { sourceSha256, jobs: [job], completion: { ready: false, issues: [
        { pageNumber: 1, actionId: "blocked", code: "AUDIO_MISSING", repair: "tts", repairable: true },
        ...(!independentSaved ? [{ pageNumber: 1, actionId: "independent", code: "AUDIO_MISSING", repair: "tts", repairable: true }] : []),
      ] }, pages: [{ pageNumber: 1, narrationReady: true, speeches: [
        { actionId: "blocked", audioReady: false }, { actionId: "independent", audioReady: independentSaved },
      ] }] } }));
  const controls = { execute, canWait: () => true };
  await continuation.finish(activation, controls);
  expect(await continuation.finish(closing, controls)).toContain("independent missing work");
  independentSaved = true;
  expect(await continuation.finish(closing, controls)).toContain("results are unknown or failed");
  expect(continuation.reportOnly).toBe(true);
  expect(execute.mock.calls.filter(([name]) => name === "courseware_media_refresh")).toHaveLength(1);
});


it("reconciles a top-level unknown video once and ends the run", async () => {
  vi.useFakeTimers();
  const continuation = new CoursewareTurnContinuation();
  let reads = 0;
  const job = { kind: "video", intentId: "clip", pageNumber: 1, sourceSha256 };
  const execute = vi.fn(async (name: string) => ({ content: [], details: name === "courseware_media_refresh"
    ? { job, saved: false, waitingFor: "service", state: "submission_unknown" }
    : { sourceSha256, jobs: [job], timestamp: ++reads } }));
  const controls = { execute, canWait: () => reads < 5 };
  try {
    await continuation.finish(activation, controls);
    const running = continuation.finish(closing, controls);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toContain("unknown");
    expect(execute.mock.calls.filter(([name]) => name === "courseware_media_refresh")).toHaveLength(1);
    expect(continuation.reportOnly).toBe(true);
  } finally { vi.useRealTimers(); }
});

function imageTurn() {
  const image = { intentId: "image-original", planSha256: sourceSha256, pageId: "page", target: { kind: "cleanPlate" }, current: true,
    phase: "submitted", selected: false, task: { state: "queued" }, asset: null };
  const start: AgentTurnContext = { ...closing, message: { ...closing.message, stopReason: "toolUse", content: [
    { type: "toolCall", id: "image", name: "courseware_scene_image_prepare", arguments: {} },
  ] }, toolResults: [{ role: "toolResult", toolCallId: "image", toolName: "courseware_scene_image_prepare", timestamp: 0,
    content: [], isError: false, details: { image, styleConfirmed: true, waitingFor: "service" } }] };
  const snapshot = { task: { taskType: "scene", generated: false }, plan: { sha256: sourceSha256, approvedSha256: sourceSha256 },
    images: [image], styleConfirmed: true, blockers: [{ pageId: "page", kind: "cleanPlate" }] };
  return { image, start, snapshot };
}

it("stops unchanged image polling after ten minutes of semantic inactivity", async () => {
  vi.useFakeTimers();
  const f=imageTurn(), continuation=new CoursewareTurnContinuation();
  let reads=0;
  const controls={ canWait:()=>reads<205, execute:async (name:string)=>({content:[],details: name === "courseware_workflow_get" ? f.snapshot :
    (reads++, {image:f.image,styleConfirmed:true,waitingFor:"service"})}) };
  try {
    await continuation.finish(f.start,controls);
    const running=continuation.finish(closing,controls);
    await vi.advanceTimersByTimeAsync(620_000);
    expect(await running).toContain("no progress");
    expect(continuation.reportOnly).toBe(true);
  } finally {vi.useRealTimers();}
});

it("continues a healthy image after the first original is unknown", async () => {
  const f=imageTurn(), continuation=new CoursewareTurnContinuation();
  const healthy={...f.image,intentId:"healthy",pageId:"other"};
  const snapshot={...f.snapshot,images:[f.image,healthy]};
  let healthyReads=0;
  const controls={canWait:()=>true,execute:async(name:string,args:Record<string,unknown>)=>{
    if(name === "courseware_workflow_get") return {content:[],details:snapshot};
    if(args.intentId === healthy.intentId) { healthyReads++; healthy.selected=true; return {content:[],details:{image:{...healthy,asset:{sha256:"b".repeat(64)}},styleConfirmed:true}}; }
    return {content:[],details:{image:{...f.image,phase:"submission-unknown",task:null},styleConfirmed:true,waitingFor:null}};
  }};
  await continuation.finish(f.start,controls);
  await continuation.finish(closing,controls);
  expect(healthyReads).toBe(1);
});

for (const required of [true, false]) it(`continues ${required ? 'required' : 'advisory'} repairs in visible calls of at most five pages`, async () => {
  const continuation = new CoursewareTurnContinuation();
  let pending = [1,2,3,4,5,6,7,8], revision = 0;
  const batches: unknown[] = [];
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const sha = String(revision).repeat(64);
    if (name === 'courseware_narration_propose') {
      expect(args.sourceSha256).toBe(sha);
      const pages = args.pageNumbers as number[];
      expect(pages.length).toBeLessThanOrEqual(5);
      batches.push(pages); pending = pending.filter(n=>!pages.includes(n)); revision++;
      return {content:[],details:{saved:true}};
    }
    const issues = pending.map(pageNumber=>({pageNumber,pageId:'p'+pageNumber,code:required?'EFFECT_MISSING':'FOCUS_MISSING',repairable:true,repair:'narration'}));
    return {content:[],details:{nativeTeaching:true,sourceSha256:sha,narrationReady:true,audioReady:true,teachingReady:!required||!pending.length,
      completion:{ready:!required||!pending.length,issues:required?issues:[]},quality:{issues:required?[]:issues},jobs:[]}};
  });
  const controls = {execute,canWait:()=>true};
  await continuation.finish(activation,controls);
  expect(await continuation.finish(closing,controls)).toContain("Saved courseware content, media and teaching checks are complete");
  expect(batches).toEqual([[1,2,3,4,5],[6,7,8]]);
});

it('repairs an unresolved semantic alias within the active turn without replaying audio or waiting for a new user message', async () => {
  const continuation = new CoursewareTurnContinuation(); let repaired = false;
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'courseware_narration_propose') {
      expect(args).toMatchObject({pageNumbers:[2],repairRequiredTeaching:true});
      expect(args.instruction).toContain('exact planned name as an alias');
      repaired = true; return {content:[],details:{saved:true}};
    }
    expect(name).toBe('courseware_media_context');
    return {content:[],details:{nativeTeaching:true,sourceSha256,narrationReady:true,audioReady:true,teachingReady:repaired,jobs:[],
      completion:{ready:repaired,issues:repaired?[]:[{code:'OBJECT_REQUIREMENT_UNRESOLVED',pageId:'p2',pageNumber:2,repairable:true,repair:'narration'}]}}};
  });
  const controls={execute,canWait:()=>true};
  await continuation.finish(activation,controls);
  expect(await continuation.finish(closing,controls)).toContain('Saved courseware content');
  expect(execute.mock.calls.filter(([name])=>name==='courseware_narration_propose')).toHaveLength(1);
});
