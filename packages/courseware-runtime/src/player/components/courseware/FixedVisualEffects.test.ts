import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FixedVisualEffects } from './FixedVisualEffects';
import type { Slide } from '../../lib/types/slides';

it('illuminates all visible targets of concurrent cues in one mask', () => {
  const slide: Slide = { id:'body', viewportSize:100, viewportRatio:1, theme:{backgroundColor:'white',themeColors:[],fontName:'Arial',fontColor:'black'},
    elements:['arrow','label','cloud'].map((id,i) => ({id,type:'text',content:id,defaultFontName:'Arial',defaultColor:'black',left:i*30,top:20,width:10,height:10,rotate:0})) };
  const html = renderToStaticMarkup(createElement(FixedVisualEffects, {slide, cues:[
    {id:'first',atMs:0,endMs:3000,effect:{kind:'spotlight',targetId:'arrow',elementIds:['label']}},
    {id:'second',atMs:1000,endMs:2000,effect:{kind:'spotlight',targetId:'cloud',elementIds:['missing','label']}},
  ]}));
  expect(html).toContain('data-target-ids="arrow,label,cloud"');
  expect(html.match(/<path /g)).toHaveLength(1);
});
