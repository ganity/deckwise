#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTarGz } from "./extract-tar.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = join(ROOT, "apps", "desktop", "dist", "ppt-master");
const PPT_MASTER_COMMIT = "6e3ce9c5a3b994a0e223a14a0f7eddf42fd0b9f5";
const PPT_MASTER_ARCHIVE_SHA256 = "8064591bba8ed97cd1dc77987232157be31fe088d5821c6ffb05a178084c83df";
const PPT_MASTER_ARCHIVE_URL =
  `https://github.com/hugohe3/ppt-master/archive/${PPT_MASTER_COMMIT}.tar.gz`;
const REQUIRED_FILES = [
  "SKILL.md",
  "scripts/attribution_guard.py",
  "scripts/project_manager.py",
  "scripts/svg_quality_checker.py",
  "scripts/svg_to_pptx.py",
  "scripts/svg_editor/server.py",
  "workflows/routing.md",
  "workflows/generate-pptx.md",
  "templates/design_spec_reference.md",
  "templates/spec_lock_reference.md",
];

function parseArgs(argv) {
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { output };
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => null));
}

async function sha256(path) {
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest("hex");
}

async function download(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    }
  }
  throw new Error(`Unable to download PPT Master: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function findExtractedRoot(extractRoot) {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  const top = entries.find((entry) => entry.isDirectory());
  if (!top) throw new Error("PPT Master archive has no root directory");
  return join(extractRoot, top.name, "skills", "ppt-master");
}

async function assertSkillRoot(skillRoot) {
  for (const file of REQUIRED_FILES) {
    if (!(await exists(join(skillRoot, file)))) {
      throw new Error(`PPT Master package is incomplete: missing ${file}`);
    }
  }
}

async function localSkillRoot() {
  const configured = process.env.DECKWISE_PPT_MASTER_SKILL_ROOT?.trim();
  const candidates = [
    configured,
    join(ROOT, "..", "ppt-gen", "vendors", "ppt-master", "skills", "ppt-master"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}


async function patchPptMaster(skillRoot) {
  const flattenPath = join(skillRoot, "scripts", "svg_finalize", "flatten_tspan.py");
  if (await exists(flattenPath)) {
    let flatten = await readFile(flattenPath, "utf8");
    const splitMode = `        if merge_paragraphs:\n            paragraph = classify_paragraph_block(\n                text_el,\n                preserve_line_breaks=preserve_line_breaks,\n            )`;
    const preserveMode = `        preserve_object = text_el.get("data-deckwise-preserve-object") == "1"\n        if merge_paragraphs or preserve_object:\n            paragraph = classify_paragraph_block(\n                text_el,\n                preserve_line_breaks=preserve_line_breaks or preserve_object,\n            )`;
    if (!flatten.includes('text_el.get("data-deckwise-preserve-object")')) {
      if (!flatten.includes(splitMode)) throw new Error("PPT Master text identity patch anchor not found");
      flatten = flatten.replace(splitMode, preserveMode);
      flatten = flatten.replace(
        `                    synthetic_first=synthetic_first,\n                )\n                changed = True\n                continue`,
        `                    synthetic_first=synthetic_first,\n                )\n                text_el.attrib.pop("data-deckwise-preserve-object", None)\n                changed = True\n                continue\n            if preserve_object:\n                raise ValueError(\n                    f"Unable to preserve DeckWise text object {text_el.get('id')!r}"\n                )`,
      );
      if (!flatten.includes('Unable to preserve DeckWise text object')) {
        throw new Error("PPT Master text identity validation patch did not apply");
      }
      await writeFile(flattenPath, flatten);
    }

    const testPath = join(skillRoot, "scripts", "tests", "test_native_export_guards.py");
    if (await exists(testPath)) {
      let tests = await readFile(testPath, "utf8");
      if (!tests.includes("test_deckwise_assessment_text_keeps_object_identity")) {
        const anchor = "    def test_line_starter_dx_is_consumed_once_and_small_dy_still_splits(self) -> None:\n";
        const regression = `    def test_deckwise_assessment_text_keeps_object_identity(self) -> None:\n        tree = ET.ElementTree(ET.fromstring(\n            '<svg xmlns="http://www.w3.org/2000/svg"><text id="assessment-q" '\n            'data-deckwise-preserve-object="1" x="100" y="120" font-size="20">'\n            '<tspan x="100" dy="0">First line</tspan>'\n            '<tspan x="100" dy="26">Second line</tspan></text></svg>'\n        ))\n        self.assertTrue(flatten_text_with_tspans(tree))\n        text = tree.getroot().find('{http://www.w3.org/2000/svg}text')\n        self.assertIsNotNone(text)\n        self.assertEqual(text.get('id'), 'assessment-q')\n        self.assertIsNone(text.get('data-deckwise-preserve-object'))\n        self.assertEqual(''.join(text.itertext()), 'First lineSecond line')\n        self.assertEqual(len(tree.getroot().findall('{http://www.w3.org/2000/svg}text')), 1)\n\n`;
        if (!tests.includes(anchor)) throw new Error("PPT Master identity regression test anchor not found");
        await writeFile(testPath, tests.replace(anchor, `${regression}${anchor}`));
      }
    }
  }

  // Planning must distinguish identity references before the provided-asset fast path.
  const referencePolicy = `## DeckWise Fixed-identity Reference Policy (mandatory)

Uploaded character, spacecraft, vehicle, or object design/model sheets used to preserve identity are reference-only inputs, not ready-made slide illustrations. This rule overrides the provided-image fast path in Default and Quick. Direct use remains valid for ordinary supplied photos/screenshots/diagrams and when the user explicitly requests display of the original sheet.

Before resource planning, identify the reference subjects from the user's intent and inspect relevant sheets when needed. Plan each affected final illustration with Acquire Via: ai, Status: Pending, and a distinct output filename. Keep the original reference paths separate from placed assets and out of spec_lock.md images; Quick uses the same distinction in active context. Never embed the original design sheet in SVG/PPTX or crop a pose out of it as a substitute for the requested new scene.

For every affected image_prompts.json item, pass the relevant original paths in reference_images (relative to the manifest). Map each reference to its subject and specify identity anchors plus the slide's action, pose, expression, camera, setting, and composition. Generate a single scene: preserve faces, hair, clothing, proportions, colors, spacecraft hull and markings; do not reproduce multi-view layouts, pose/expression grids, swatches, labels, or captions from the sheet. Identity requirements take precedence over generic deck styling. Use only references whose subjects appear in that scene. A face-capture lesson, for example, needs the referenced character facing a camera in a capture scene, not the character's model sheet with a scan icon over it.

Use the configured reference-capable Seedream backend and the existing multi-reference limits. Text-only descriptions of filenames do not count as reference-image generation. Only the generated output becomes a placed asset; inspect it for subject identity and scene fit before preview/export. If generation fails, or reference-image support is unavailable, report the affected required image as incomplete. Never silently fall back to the original sheet, a cropped pose, or a generic replacement character. Existing incorrect slides require regeneration of their illustrations, not merely a new PPTX export.
`;
  for (const relativePath of [
    "references/strategist-image.md",
    "workflows/profiles/quick-generate.md",
    "references/image-generator.md",
  ]) {
    const path = join(skillRoot, relativePath);
    if (!(await exists(path))) continue;
    const body = await readFile(path, "utf8");
    if (!body.includes("## DeckWise Fixed-identity Reference Policy (mandatory)")) {
      await writeFile(path, `${body.trimEnd()}\n\n${referencePolicy}`);
    }
  }

  const backendPath = join(skillRoot, "scripts", "image_backends", "backend_openai.py");
  const imageGenPath = join(skillRoot, "scripts", "image_gen.py");
  if (!(await exists(backendPath)) || !(await exists(imageGenPath))) return;

  let backend = await readFile(backendPath, "utf8");
  if (!backend.includes("SEEDREAM_MAX_REFERENCE_IMAGES")) {
    backend = backend.replace(
      "SUPPORTS_REFERENCE_IMAGE = True\n",
      `SUPPORTS_REFERENCE_IMAGE = True
SEEDREAM_MAX_REFERENCE_IMAGES = 14

`,
    );
    backend = backend.replace(
      `def _normalized_model(model: str) -> str:
    return (model or "").strip().lower()
`,
      `def _normalized_model(model: str) -> str:
    return (model or "").strip().lower()


def _is_seedream_model(model: str) -> bool:
    return "seedream" in _normalized_model(model)


def _seedream_reference_limit(model: str) -> int:
    normalized = _normalized_model(model)
    return 10 if "seedream-5" in normalized and any(tier in normalized for tier in ("pro", "flash")) else SEEDREAM_MAX_REFERENCE_IMAGES


def _reference_image_data(image_path: str) -> str:
    from PIL import Image

    path = Path(image_path)
    if path.stat().st_size > 30 * 1024 * 1024:
        raise ValueError(f"Reference image exceeds Seedream's 30 MB limit: {path}")
    with Image.open(path) as image:
        width, height = image.size
        if min(width, height) <= 14 or width * height > 36_000_000 or not 1 / 16 <= width / height <= 16:
            raise ValueError(f"Reference image dimensions exceed Seedream's limits: {path}")
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime_type};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"
`,
    );
    backend = backend.replace(
      `                    model: str = DEFAULT_MODEL, base_url: str = None) -> str:
`,
      `                    model: str = DEFAULT_MODEL, base_url: str = None,
                    reference_images: list[str] | None = None) -> str:
`,
    );
    backend = backend.replace(
      `        "n": 1,
    }
    if quality is not None:
`,
      `        "n": 1,
    }
    if reference_images:
        reference_limit = _seedream_reference_limit(model)
        if len(reference_images) > reference_limit:
            raise ValueError(
                f"{model} accepts at most {reference_limit} reference images."
            )
        request["image"] = [_reference_image_data(path) for path in reference_images]
    if quality is not None:
`,
    );
    backend = backend.replace(
      `             reference_image: str = None) -> str:
`,
      `             reference_image: str = None,
             reference_images: list[str] | None = None) -> str:
`,
    );
    backend = backend.replace(
      `    if model is None:
        model = os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL

    image_size = normalize_image_size(image_size)
`,
      `    if model is None:
        model = os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL

    if reference_image is not None:
        reference_images = [reference_image] if reference_images is None else [*reference_images, reference_image]
    if reference_images and not _is_seedream_model(model) and len(reference_images) > 1:
        raise ValueError("Multiple reference images require a Seedream model.")

    image_size = normalize_image_size(image_size)
`,
    );
    backend = backend.replace(
      `        editing=reference_image is not None,
`,
      `        editing=bool(reference_images) and not _is_seedream_model(model),
`,
    );
    backend = backend.replace(
      `            if reference_image is not None:
                return _edit_image(api_key, prompt, reference_image,
                                   aspect_ratio, image_size, output_dir,
                                   filename, model, base_url)
`,
      `            if reference_images and _is_seedream_model(model):
                return _generate_image(api_key, prompt,
                                       aspect_ratio, image_size, output_dir,
                                       filename, model, base_url,
                                       reference_images=reference_images)
            if reference_images:
                return _edit_image(api_key, prompt, reference_images[0],
                                   aspect_ratio, image_size, output_dir,
                                   filename, model, base_url)
`,
    );
    if (!backend.includes('request["image"] = [_reference_image_data(path) for path in reference_images]')) {
      throw new Error("PPT Master OpenAI image backend patch did not apply");
    }
    await writeFile(backendPath, backend);
  }

  let imageGen = await readFile(imageGenPath, "utf8");
  if (!imageGen.includes("field 'reference_images'")) {
    imageGen = imageGen.replace(
      '  python3 image_gen.py "edit instruction" --reference-image src.png -o images/\n',
      '  python3 image_gen.py "edit instruction" --reference-image character.png --reference-image vehicle.png -o images/\n',
    );
    imageGen = imageGen.replace(
      "    `page_role`, `text_policy`, `slice_grid`, `slice_names`, `last_error`.\n",
      "    `page_role`, `text_policy`, `slice_grid`, `slice_names`, `reference_images`,\n    `last_error`.\n",
    );
    imageGen = imageGen.replace(
      `        if "last_error" in item and not isinstance(item["last_error"], str):
`,
      `        if "reference_images" in item:
            references = item["reference_images"]
            if (
                not isinstance(references, list)
                or not references
                or any(not isinstance(reference, str) or not reference.strip() for reference in references)
            ):
                raise ValueError(
                    f"{prefix} field 'reference_images' must be a non-empty array of paths"
                )
        if "last_error" in item and not isinstance(item["last_error"], str):
`,
    );
    imageGen = imageGen.replace(
      `            saved_path = backend_module.generate(
                prompt=item["prompt"],
                aspect_ratio=item["aspect_ratio"],
                image_size=item.get("image_size", image_size),
                output_dir=output_dir,
                filename=Path(item["filename"]).stem,
                model=item.get("model", model),
            )
`,
      `            reference_images = item.get("reference_images")
            if reference_images:
                reference_images = [
                    str((Path(manifest_path).resolve().parent / reference).resolve())
                    for reference in reference_images
                ]
            generate_kwargs = dict(
                prompt=item["prompt"],
                aspect_ratio=item["aspect_ratio"],
                image_size=item.get("image_size", image_size),
                output_dir=output_dir,
                filename=Path(item["filename"]).stem,
                model=item.get("model", model),
            )
            if reference_images:
                if getattr(backend_module, "__name__", "").endswith("backend_openai"):
                    generate_kwargs["reference_images"] = reference_images
                elif len(reference_images) == 1:
                    generate_kwargs["reference_image"] = reference_images[0]
                else:
                    raise ValueError(
                        "Multiple reference images require the OpenAI-compatible Seedream backend."
                    )
            saved_path = backend_module.generate(**generate_kwargs)
`,
    );
    imageGen = imageGen.replace(
      `        "--reference-image", dest="reference_image", default=None, metavar="PATH",
`,
      `        "--reference-image", dest="reference_image", action="append", default=None, metavar="PATH",
`,
    );
    imageGen = imageGen.replace(
      `            "Source image for image-to-image editing (single-image mode only). "
`,
      `            "Source image for image-to-image editing; repeat for multiple Seedream references. "
`,
    );
    imageGen = imageGen.replace(
      `    if args.reference_image is not None:
        # Reference editing is a single-image-only enhancement; keep it out of
        # the manifest / sidecar / list surfaces entirely.
`,
      `    if args.reference_image:
        # Reference editing is a single-image CLI mode; keep it out of the
        # manifest / sidecar / list surfaces entirely.
`,
    );
    imageGen = imageGen.replace(
      `        if not os.path.isfile(args.reference_image):
            parser.error(
                f"--reference-image file not found: {args.reference_image}"
            )
`,
      `        missing = [path for path in args.reference_image if not os.path.isfile(path)]
        if missing:
            parser.error(f"--reference-image file not found: {missing[0]}")
`,
    );
    imageGen = imageGen.replace(
      `    if args.reference_image is not None:
        if not getattr(backend, "SUPPORTS_REFERENCE_IMAGE", False):
`,
      `    if args.reference_image:
        if not getattr(backend, "SUPPORTS_REFERENCE_IMAGE", False):
`,
    );
    imageGen = imageGen.replace(
      `        gen_kwargs["reference_image"] = args.reference_image
`,
      `        if backend_name == "openai":
            gen_kwargs["reference_images"] = args.reference_image
        elif len(args.reference_image) == 1:
            gen_kwargs["reference_image"] = args.reference_image[0]
        else:
            print(
                f"Error: backend '{backend_name}' supports only one reference image."
            )
            sys.exit(1)
`,
    );
    if (!imageGen.includes("field 'reference_images'") || !imageGen.includes('action="append"')) {
      throw new Error("PPT Master image reference patch did not apply");
    }
    await writeFile(imageGenPath, imageGen);
  }

  const imageGuidePath = join(skillRoot, "references", "image-generator.md");
  if (await exists(imageGuidePath)) {
    let imageGuide = await readFile(imageGuidePath, "utf8");
    if (!imageGuide.includes("Fixed visual references")) {
      imageGuide = imageGuide.replace(
        "| Type | An Illustration Sheet omits `type` and follows §4.3; another local structural infographic takes one of the 11 types only on a real index match, otherwise §4.1 E prose; a local single-subject/portrait uses §4.1 A/B; a `hero_page` uses §4.1 A–E. Read `image-type-templates/<type>.md` only when selected |\n",
        "| Type | An Illustration Sheet omits `type` and follows §4.3; another local structural infographic takes one of the 11 types only on a real index match, otherwise §4.1 E prose; a local single-subject/portrait uses §4.1 A/B; a `hero_page` uses §4.1 A–E. Read `image-type-templates/<type>.md` only when selected |\n\n**Fixed visual references**: when the user supplies a character, vehicle, logo, or other design sheet that must remain recognizable, add `reference_images` to each affected manifest item. Use paths relative to `image_prompts.json`, keep the prompt explicit about preserving identity, and use the OpenAI-compatible Seedream backend; Seedream 5.0 Pro/Flash accept up to 10 references, while 5.0 Lite/4.x accept up to 14. Each reference must be at most 30 MB and 36 million pixels, with both dimensions above 14 pixels and an aspect ratio between 1:16 and 16:1. Do not add unrelated references to every row.\n",
      );
      imageGuide = imageGuide.replace(
        "| `items[].model` | no | Per-item backend model override |\n",
        "| `items[].model` | no | Per-item backend model override |\n| `items[].reference_images` | no | One or more image paths relative to the manifest for Seedream identity/style references; omitted when the image is unrelated |\n",
      );
      if (!imageGuide.includes("Fixed visual references") || !imageGuide.includes("items[].reference_images")) {
        throw new Error("PPT Master image guide reference patch did not apply");
      }
      await writeFile(imageGuidePath, imageGuide);
    }
  }
}

async function main() {
  const { output } = parseArgs(process.argv.slice(2));
  if (output === "/" || output === resolve(process.env.HOME || "", "") || output === ROOT) {
    throw new Error(`Refusing unsafe output directory: ${output}`);
  }

  const local = await localSkillRoot();
  if (local) {
    await assertSkillRoot(local);
    const sameSource = resolve(local) === output || (await exists(output) && await realpath(local) === await realpath(output));
    if (!sameSource) {
      await rm(output, { recursive: true, force: true });
      await mkdir(dirname(output), { recursive: true });
      await cp(local, output, { recursive: true });
    }
    await patchPptMaster(output);
    console.log(`PPT Master staged from local checkout at ${output}`);
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "deckwise-ppt-master-"));
  try {
    const archive = join(tempRoot, "ppt-master.tar.gz");
    const extractRoot = join(tempRoot, "extract");
    await download(PPT_MASTER_ARCHIVE_URL, archive);
    const actual = await sha256(archive);
    if (actual !== PPT_MASTER_ARCHIVE_SHA256) {
      throw new Error(`PPT Master archive checksum mismatch: ${actual}`);
    }
    await mkdir(extractRoot, { recursive: true });
    await extractTarGz(archive, extractRoot);
    const extracted = await findExtractedRoot(extractRoot);
    await assertSkillRoot(extracted);
    await rm(output, { recursive: true, force: true });
    await mkdir(dirname(output), { recursive: true });
    await cp(extracted, output, { recursive: true });
    await patchPptMaster(output);
    await writeFile(
      join(output, ".deckwise-ppt-master.json"),
      `${JSON.stringify({ commit: PPT_MASTER_COMMIT, sha256: PPT_MASTER_ARCHIVE_SHA256 }, null, 2)}\n`,
    );
    console.log(`PPT Master ${PPT_MASTER_COMMIT} staged at ${output}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
