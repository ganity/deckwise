export const COURSEWARE_DEFAULT_FONT = 'Noto Sans SC Variable';
export const COURSEWARE_SERIF_FONT = 'Noto Serif SC Variable';

const COURSEWARE_FONT_ALIASES: Record<string, string> = {
  宋体: COURSEWARE_SERIF_FONT,
  simsun: COURSEWARE_SERIF_FONT,
  nsimsun: COURSEWARE_SERIF_FONT,
  'songti sc': COURSEWARE_SERIF_FONT,
  stsong: COURSEWARE_SERIF_FONT,
  sourcehanserif: COURSEWARE_SERIF_FONT,
  sourcehanserifsc: COURSEWARE_SERIF_FONT,
  'sourcehanserif sc': COURSEWARE_SERIF_FONT,
  'source han serif': COURSEWARE_SERIF_FONT,
  'source han serif sc': COURSEWARE_SERIF_FONT,
  'noto serif cjk sc': COURSEWARE_SERIF_FONT,
  'noto serif sc variable': COURSEWARE_SERIF_FONT,
  思源宋体: COURSEWARE_SERIF_FONT,
  华文中宋: COURSEWARE_SERIF_FONT,
  仿宋: COURSEWARE_SERIF_FONT,
  fangsong: COURSEWARE_SERIF_FONT,
  stfangsong: COURSEWARE_SERIF_FONT,
  楷体: 'LXGW WenKai',
  楷体_gb2312: 'LXGW WenKai',
  kaiti: 'LXGW WenKai',
  kaiti_gb2312: 'LXGW WenKai',
  stkaiti: 'LXGW WenKai',
  'kaiti sc': 'LXGW WenKai',
  'ar pl ukai cn': 'LXGW WenKai',
  'lxgw wenkai': 'LXGW WenKai',
  华文楷体: 'LXGW WenKai',
  隶书: 'LXGW WenKai',
  lisu: 'LXGW WenKai',
  stliti: 'LXGW WenKai',
  hykaitikw: 'LXGW WenKai',
  'hy kaiti kw': 'LXGW WenKai',
  黑体: COURSEWARE_DEFAULT_FONT,
  simhei: COURSEWARE_DEFAULT_FONT,
  stheiti: COURSEWARE_DEFAULT_FONT,
  'heiti sc': COURSEWARE_DEFAULT_FONT,
  微软雅黑: COURSEWARE_DEFAULT_FONT,
  'microsoft yahei': COURSEWARE_DEFAULT_FONT,
  等线: COURSEWARE_DEFAULT_FONT,
  dengxian: COURSEWARE_DEFAULT_FONT,
  'noto sans cjk sc': COURSEWARE_DEFAULT_FONT,
  'noto sans sc variable': COURSEWARE_DEFAULT_FONT,
  sourcehansans: COURSEWARE_DEFAULT_FONT,
  sourcehansanssc: COURSEWARE_DEFAULT_FONT,
  'sourcehansans sc': COURSEWARE_DEFAULT_FONT,
  'source han sans': COURSEWARE_DEFAULT_FONT,
  'source han sans sc': COURSEWARE_DEFAULT_FONT,
  思源黑体: COURSEWARE_DEFAULT_FONT,
  'comic sans ms': 'Comic Neue',
  'comic sans': 'Comic Neue',
  'comic neue': 'Comic Neue',
  arial: 'Arimo Variable',
  'arial narrow': 'Arimo Variable',
  helvetica: 'Arimo Variable',
  'helvetica neue': 'Arimo Variable',
  tahoma: 'Arimo Variable',
  verdana: 'Arimo Variable',
  'trebuchet ms': 'Arimo Variable',
  'century gothic': 'Arimo Variable',
  'segoe ui': 'Arimo Variable',
  'arimo variable': 'Arimo Variable',
  calibri: 'Carlito',
  'calibri light': 'Carlito',
  aptos: 'Carlito',
  'aptos body': 'Carlito',
  'aptos display': 'Carlito',
  carlito: 'Carlito',
  cambria: 'Caladea',
  caladea: 'Caladea',
  'times new roman': 'Tinos',
  'times new roman regular': 'Tinos',
  georgia: 'Tinos',
  tinos: 'Tinos',
  'courier new': 'Cousine',
  courier: 'Cousine',
  consolas: 'Cousine',
  cousine: 'Cousine',
};

const CHINESE_SAMPLE = '影子前后左右跟着黑狗它们好朋友';
const PINYIN_SAMPLE = 'yǐng zi qián hòu zuǒ yòu gēn zhe hēi gǒu';
const LATIN_SAMPLE = 'Primary classroom ABC abc 0123456789';

export const COURSEWARE_FONT_LOAD_REQUESTS = [
  { descriptor: '400 24px "LXGW WenKai"', sample: CHINESE_SAMPLE },
  { descriptor: '700 24px "LXGW WenKai"', sample: CHINESE_SAMPLE },
  { descriptor: '400 24px "Comic Neue"', sample: PINYIN_SAMPLE },
  { descriptor: '700 24px "Comic Neue"', sample: PINYIN_SAMPLE },
  { descriptor: '400 24px "Arimo Variable"', sample: PINYIN_SAMPLE },
  { descriptor: '700 24px "Arimo Variable"', sample: LATIN_SAMPLE },
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

function unquoteFontFamily(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

export function resolveCoursewareFontFamily(fontFace?: string): string | undefined {
  if (!fontFace) return undefined;
  const firstFamily = unquoteFontFamily(fontFace.split(',')[0] ?? '').toLowerCase();
  return COURSEWARE_FONT_ALIASES[firstFamily] ?? COURSEWARE_DEFAULT_FONT;
}

export function normalizeCoursewareHtmlFonts(content: string): string {
  return content.replace(/style=(["'])([\s\S]*?)\1/gi, (_match, quote: string, style: string) => {
    const normalizedStyle = style.replace(
      /(font-family\s*:\s*)([^;]+)/gi,
      (_fontMatch, prefix: string, value: string) =>
        `${prefix}${resolveCoursewareFontFamily(value) ?? value.trim()}`,
    );
    return `style=${quote}${normalizedStyle}${quote}`;
  });
}

export async function loadCoursewareFontSet(fonts: FontFaceSet): Promise<void> {
  await Promise.all(
    COURSEWARE_FONT_LOAD_REQUESTS.map(({ descriptor, sample }) => fonts.load(descriptor, sample)),
  );
  await fonts.ready;
}

export function ensureCoursewareFontsLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  coursewareFontsReady ??= loadCoursewareFontSet(document.fonts).catch(() => undefined);
  return coursewareFontsReady;
}
