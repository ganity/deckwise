export const COURSEWARE_DEFAULT_FONT = "Noto Sans SC Variable";
export const COURSEWARE_SERIF_FONT = "Noto Serif SC Variable";
export const COURSEWARE_MONOSPACE_FONT = "Cousine";

export const COURSEWARE_FONT_STYLESHEETS = [
  "/courseware-fonts/fonts/dynapuff/index.css",
  "/courseware-fonts/fonts/comic-neue/index.css",
  "/courseware-fonts/fonts/lxgw-wenkai/index.css",
  "/courseware-fonts/fonts/@fontsource-variable/arimo/index.css",
  "/courseware-fonts/fonts/@fontsource-variable/inter/index.css",
  "/courseware-fonts/fonts/@fontsource-variable/noto-sans-sc/index.css",
  "/courseware-fonts/fonts/@fontsource-variable/noto-serif-sc/index.css",
  "/courseware-fonts/fonts/@fontsource/tinos/index.css",
  "/courseware-fonts/fonts/@fontsource/caladea/index.css",
  "/courseware-fonts/fonts/@fontsource/carlito/index.css",
  "/courseware-fonts/fonts/@fontsource/cousine/index.css",
] as const;

const COURSEWARE_FONT_ALIASES: Record<string, string> = {
  dynapuff: "DynaPuff",
  宋体: COURSEWARE_SERIF_FONT,
  simsun: COURSEWARE_SERIF_FONT,
  nsimsun: COURSEWARE_SERIF_FONT,
  "songti sc": COURSEWARE_SERIF_FONT,
  stsong: COURSEWARE_SERIF_FONT,
  sourcehanserif: COURSEWARE_SERIF_FONT,
  sourcehanserifsc: COURSEWARE_SERIF_FONT,
  "sourcehanserif sc": COURSEWARE_SERIF_FONT,
  "source han serif": COURSEWARE_SERIF_FONT,
  "source han serif sc": COURSEWARE_SERIF_FONT,
  "source han serif cn": COURSEWARE_SERIF_FONT,
  "noto serif cjk sc": COURSEWARE_SERIF_FONT,
  "noto serif sc variable": COURSEWARE_SERIF_FONT,
  notoserifsc: COURSEWARE_SERIF_FONT,
  思源宋体: COURSEWARE_SERIF_FONT,
  华文中宋: COURSEWARE_SERIF_FONT,
  仿宋: COURSEWARE_SERIF_FONT,
  fangsong: COURSEWARE_SERIF_FONT,
  stfangsong: COURSEWARE_SERIF_FONT,
  wendingplsongti: COURSEWARE_SERIF_FONT,
  zhuquefangsong: COURSEWARE_SERIF_FONT,
  sourceserif4: COURSEWARE_SERIF_FONT,
  "source serif 4": COURSEWARE_SERIF_FONT,
  literata: COURSEWARE_SERIF_FONT,
  merriweather: COURSEWARE_SERIF_FONT,
  serif: COURSEWARE_SERIF_FONT,
  "ui-serif": COURSEWARE_SERIF_FONT,
  楷体: "LXGW WenKai",
  楷体_gb2312: "LXGW WenKai",
  kaiti: "LXGW WenKai",
  kaiti_gb2312: "LXGW WenKai",
  stkaiti: "LXGW WenKai",
  "kaiti sc": "LXGW WenKai",
  "ar pl ukai cn": "LXGW WenKai",
  "lxgw wenkai": "LXGW WenKai",
  lxgwwenkai: "LXGW WenKai",
  华文楷体: "LXGW WenKai",
  隶书: "LXGW WenKai",
  lisu: "LXGW WenKai",
  stliti: "LXGW WenKai",
  hykaitikw: "LXGW WenKai",
  "hy kaiti kw": "LXGW WenKai",
  wendingplkaiti: "LXGW WenKai",
  黑体: COURSEWARE_DEFAULT_FONT,
  simhei: COURSEWARE_DEFAULT_FONT,
  stheiti: COURSEWARE_DEFAULT_FONT,
  "heiti sc": COURSEWARE_DEFAULT_FONT,
  微软雅黑: COURSEWARE_DEFAULT_FONT,
  "microsoft yahei": COURSEWARE_DEFAULT_FONT,
  等线: COURSEWARE_DEFAULT_FONT,
  dengxian: COURSEWARE_DEFAULT_FONT,
  "noto sans cjk sc": COURSEWARE_DEFAULT_FONT,
  "noto sans sc variable": COURSEWARE_DEFAULT_FONT,
  notosanssc: COURSEWARE_DEFAULT_FONT,
  sourcehansans: COURSEWARE_DEFAULT_FONT,
  sourcehansanssc: COURSEWARE_DEFAULT_FONT,
  "sourcehansans cn": COURSEWARE_DEFAULT_FONT,
  "sourcehansans sc": COURSEWARE_DEFAULT_FONT,
  "source han sans": COURSEWARE_DEFAULT_FONT,
  "source han sans sc": COURSEWARE_DEFAULT_FONT,
  "source han sans cn": COURSEWARE_DEFAULT_FONT,
  思源黑体: COURSEWARE_DEFAULT_FONT,
  alibabapuhuiti: COURSEWARE_DEFAULT_FONT,
  misans: COURSEWARE_DEFAULT_FONT,
  deyihei: COURSEWARE_DEFAULT_FONT,
  cangerxiaowanzi: COURSEWARE_DEFAULT_FONT,
  youshetitleblack: COURSEWARE_DEFAULT_FONT,
  fengguangmingrui: COURSEWARE_DEFAULT_FONT,
  shetumodernsquare: COURSEWARE_DEFAULT_FONT,
  zizhiquximai: COURSEWARE_DEFAULT_FONT,
  sucaijishikangkang: COURSEWARE_DEFAULT_FONT,
  sucaijishicoolsquare: COURSEWARE_DEFAULT_FONT,
  tuniurounded: COURSEWARE_DEFAULT_FONT,
  ruizizhenyan: COURSEWARE_DEFAULT_FONT,
  sans: COURSEWARE_DEFAULT_FONT,
  "sans-serif": COURSEWARE_DEFAULT_FONT,
  "ui-sans-serif": COURSEWARE_DEFAULT_FONT,
  "system-ui": COURSEWARE_DEFAULT_FONT,
  "-apple-system": COURSEWARE_DEFAULT_FONT,
  blinkmacsystemfont: COURSEWARE_DEFAULT_FONT,
  "pingfang sc": COURSEWARE_DEFAULT_FONT,
  "hiragino sans gb": COURSEWARE_DEFAULT_FONT,
  "comic sans ms": "Comic Neue",
  "comic sans": "Comic Neue",
  "comic neue": "Comic Neue",
  arial: "Arimo Variable",
  "arial narrow": "Arimo Variable",
  helvetica: "Arimo Variable",
  "helvetica neue": "Arimo Variable",
  tahoma: "Arimo Variable",
  verdana: "Arimo Variable",
  "trebuchet ms": "Arimo Variable",
  "century gothic": "Arimo Variable",
  "segoe ui": "Arimo Variable",
  "arimo variable": "Arimo Variable",
  roboto: "Arimo Variable",
  opensans: "Arimo Variable",
  "open sans": "Arimo Variable",
  montserrat: "Arimo Variable",
  sourcesanspro: "Arimo Variable",
  "source sans pro": "Arimo Variable",
  inter: "Inter Variable",
  "inter variable": "Inter Variable",
  calibri: "Carlito",
  "calibri light": "Carlito",
  aptos: "Carlito",
  "aptos body": "Carlito",
  "aptos display": "Carlito",
  carlito: "Carlito",
  cambria: "Caladea",
  caladea: "Caladea",
  "times new roman": "Tinos",
  "times new roman regular": "Tinos",
  georgia: "Tinos",
  tinos: "Tinos",
  "courier new": COURSEWARE_MONOSPACE_FONT,
  courier: COURSEWARE_MONOSPACE_FONT,
  consolas: COURSEWARE_MONOSPACE_FONT,
  cousine: COURSEWARE_MONOSPACE_FONT,
  jetbrainsmono: COURSEWARE_MONOSPACE_FONT,
  "jetbrains mono": COURSEWARE_MONOSPACE_FONT,
  monospace: COURSEWARE_MONOSPACE_FONT,
  "ui-monospace": COURSEWARE_MONOSPACE_FONT,
};

const CHINESE_SAMPLE = "影子前后左右跟着黑狗它们好朋友";
const PINYIN_SAMPLE = "yǐng zi qián hòu zuǒ yòu gēn zhe hēi gǒu";
const LATIN_SAMPLE = "Primary classroom ABC abc 0123456789";
const MAX_DYNAMIC_FONT_SAMPLE_CHARACTERS = 4096;

const DYNAMIC_CJK_FONT_LOAD_DESCRIPTORS = [
  '400 24px "Noto Sans SC Variable"',
  '700 24px "Noto Sans SC Variable"',
  '400 24px "Noto Serif SC Variable"',
  '700 24px "Noto Serif SC Variable"',
] as const;

export const COURSEWARE_FONT_LOAD_REQUESTS = [
  { descriptor: '700 24px "DynaPuff"', sample: LATIN_SAMPLE },
  { descriptor: '400 24px "LXGW WenKai"', sample: CHINESE_SAMPLE },
  { descriptor: '700 24px "LXGW WenKai"', sample: CHINESE_SAMPLE },
  { descriptor: '400 24px "Comic Neue"', sample: PINYIN_SAMPLE },
  { descriptor: '700 24px "Comic Neue"', sample: PINYIN_SAMPLE },
  { descriptor: '400 24px "Arimo Variable"', sample: PINYIN_SAMPLE },
  { descriptor: '700 24px "Arimo Variable"', sample: LATIN_SAMPLE },
  { descriptor: '400 24px "Inter Variable"', sample: LATIN_SAMPLE },
  { descriptor: '700 24px "Inter Variable"', sample: LATIN_SAMPLE },
  { descriptor: '400 24px "Noto Sans SC Variable"', sample: CHINESE_SAMPLE },
  { descriptor: '700 24px "Noto Sans SC Variable"', sample: CHINESE_SAMPLE },
  { descriptor: '400 24px "Noto Serif SC Variable"', sample: CHINESE_SAMPLE },
  { descriptor: '700 24px "Noto Serif SC Variable"', sample: CHINESE_SAMPLE },
  { descriptor: '400 24px "Tinos"', sample: LATIN_SAMPLE },
  { descriptor: '700 24px "Tinos"', sample: LATIN_SAMPLE },
  { descriptor: '400 24px "Carlito"', sample: LATIN_SAMPLE },
  { descriptor: '700 24px "Carlito"', sample: LATIN_SAMPLE },
  { descriptor: '400 24px "Caladea"', sample: LATIN_SAMPLE },
  { descriptor: '700 24px "Caladea"', sample: LATIN_SAMPLE },
  { descriptor: '400 24px "Cousine"', sample: LATIN_SAMPLE },
  { descriptor: '700 24px "Cousine"', sample: LATIN_SAMPLE },
] as const;

let coursewareFontsReady: Promise<void> | undefined;
const dynamicCoursewareFontLoads = new Map<string, Promise<void>>();

function normalizeFontSampleText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&(?:nbsp|ensp|emsp);/gi, " ");
}

export function createCoursewareFontSample(value: unknown): string {
  const characters = new Set<string>();
  const visited = new WeakSet<object>();

  const collect = (candidate: unknown, key?: string) => {
    if (characters.size >= MAX_DYNAMIC_FONT_SAMPLE_CHARACTERS) return;
    if (typeof candidate === "string") {
      if (
        key === "src" ||
        key === "url" ||
        key === "path" ||
        candidate.startsWith("data:") ||
        candidate.startsWith("blob:") ||
        /^https?:\/\//i.test(candidate)
      ) {
        return;
      }
      for (const character of normalizeFontSampleText(candidate)) {
        if (!/\s/u.test(character)) characters.add(character);
        if (characters.size >= MAX_DYNAMIC_FONT_SAMPLE_CHARACTERS) break;
      }
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    if (visited.has(candidate)) return;
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      candidate.forEach((item) => collect(item));
      return;
    }
    Object.entries(candidate).forEach(([childKey, child]) =>
      collect(child, childKey),
    );
  };

  collect(value);
  return Array.from(characters).join("");
}

function decodeFontFamilyHtmlEntities(value: string): string {
  return value
    .replace(/&(?:quot|#0*34|#x0*22);/gi, '"')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'");
}

function unquoteFontFamily(value: string): string {
  return decodeFontFamilyHtmlEntities(value)
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

export function resolveCoursewareFontFamily(
  fontFace?: string,
): string | undefined {
  if (!fontFace) return undefined;
  const decodedFontFace = decodeFontFamilyHtmlEntities(fontFace);
  const firstFamily = unquoteFontFamily(
    decodedFontFace.split(",")[0] ?? "",
  ).toLowerCase();
  return COURSEWARE_FONT_ALIASES[firstFamily] ?? COURSEWARE_DEFAULT_FONT;
}

export function resolveCoursewareFontStack(
  fontFace?: string,
): string | undefined {
  const family = resolveCoursewareFontFamily(fontFace);
  if (
    !family ||
    [COURSEWARE_DEFAULT_FONT, COURSEWARE_SERIF_FONT, "LXGW WenKai"].includes(
      family,
    )
  ) {
    return family;
  }
  return `${family}, ${COURSEWARE_DEFAULT_FONT}`;
}

export function normalizeCoursewareHtmlFonts(content: string): string {
  return content.replace(
    /style=(["'])([\s\S]*?)\1/gi,
    (_match, quote: string, style: string) => {
      const normalizedStyle = style.replace(
        /(font-family\s*:\s*)((?:(?:&(?:quot|apos|#0*34|#x0*22|#0*39|#x0*27);)|[^;])+)(?=;|$)/gi,
        (_fontMatch, prefix: string, value: string) =>
          `${prefix}${resolveCoursewareFontStack(value) ?? value.trim()}`,
      );
      return `style=${quote}${normalizedStyle}${quote}`;
    },
  );
}

export async function loadCoursewareFontSet(fonts: FontFaceSet): Promise<void> {
  await Promise.all(
    COURSEWARE_FONT_LOAD_REQUESTS.map(({ descriptor, sample }) =>
      fonts.load(descriptor, sample),
    ),
  );
  await fonts.ready;
}

async function loadDynamicCoursewareCharacters(
  fonts: FontFaceSet,
  sample: string,
): Promise<void> {
  await Promise.all(
    DYNAMIC_CJK_FONT_LOAD_DESCRIPTORS.map((descriptor) =>
      fonts.load(descriptor, sample),
    ),
  );
  await fonts.ready;
}

export function ensureCoursewareFontsLoaded(sample?: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts)
    return Promise.resolve();
  coursewareFontsReady ??= loadCoursewareFontSet(document.fonts);
  if (!sample) return coursewareFontsReady;

  const normalizedSample = createCoursewareFontSample(sample);
  if (!normalizedSample) return coursewareFontsReady;

  const cached = dynamicCoursewareFontLoads.get(normalizedSample);
  if (cached) return cached;

  const dynamicLoad = coursewareFontsReady.then(() =>
    loadDynamicCoursewareCharacters(document.fonts, normalizedSample),
  );
  dynamicCoursewareFontLoads.set(normalizedSample, dynamicLoad);
  return dynamicLoad;
}
