// 给词典 2.0 加「用法提示(note)」和「检索别名(aliases)」，并把版本提到 2。
// 只补高频 / 容易混的词；没有补的保持原样，界面上不显示空行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'glossary.json');
const g = JSON.parse(fs.readFileSync(file, 'utf8'));

// en -> [note, aliases]
const patch = {
  // ---- 画质 / 质感 ----
  'masterpiece': ['质量词只在 SD1.5/XL 有明显作用，Flux、Qwen-Image 这类基本无效，别堆', ['杰作', '大作']],
  'best quality': ['和 masterpiece 二选一就够，重复堆叠不会变好', ['最佳品质']],
  'high resolution': ['想提高细节优先加分辨率/放大流程，不是加这个词', ['高解析']],
  'ultra-detailed': ['容易让画面变“糊满细节”，人像慎用，可与 texture 类词冲突', ['超细节', '极细节']],
  'intricate details': ['适合机械、花纹、布料特写；加在人脸上会变脏', ['繁复细节']],
  'sharp focus': ['想全画面锐利就加；配 shallow DOF 会互相打架', ['清晰对焦']],
  'photorealistic': ['真人向用这个；和 anime style 同时出现会出四不像', ['照片级', '拟真']],
  'cinematic look': ['偏调色观感；要电影打光用 cinematic lighting 更准', ['电影感']],
  'HDR': ['容易过曝、发灰；已经有强对比就别加', []],

  // ---- 风格 ----
  'cyberpunk': ['赛博朋克；想要夜景霓虹再搭 neon-lit street', ['赛博', '赛伯朋克']],
  'steampunk': ['蒸汽朋克；黄铜/齿轮质感可再配 metallic texture', ['蒸汽']],
  'anime style': ['二次元；和 photorealistic 互斥，别同时上', ['动漫风', '二次元']],
  'Chinese style': ['国风；具体朝代感要再指明（ancient Chinese style）', ['国风', '中国风']],
  'ink wash painting': ['水墨；容易发灰，背景建议留白', ['水墨画', '水墨风']],
  'oil painting': ['油画；会带笔触，想要干净画面慎用', []],
  'watercolor painting': ['水彩；适合浅色、通透，别配高对比 HDR', ['水彩画']],
  'line art': ['线稿；常与 monochrome、white background 搭配', ['线条画']],
  'pixel art': ['像素风；分辨率设小一点更自然，别开高清放大', ['像素风']],
  '3D render': ['3D 渲染；想要玩具/模型感再配 claymation 或 low poly', ['三维渲染']],
  'cel shading': ['赛璐璐上色；动画感的关键词，配 flat color 更纯', ['赛璐璐']],
  'painterly illustration': ['厚涂插画；会有明显笔触，和 photorealism 冲突', ['厚涂']],
  'concept art': ['概念设计；常出设定图那种构图，适合场景', ['概念设定']],
  'dark fantasy': ['暗黑奇幻；会自动降压色调，别和环境词里的 bright 撞', ['黑奇幻']],

  // ---- 镜头 / 光线 ----
  'shallow depth of field': ['浅景深=背景模糊；要虚化用这个，别和 sharp focus 同用', ['浅景深', '景深浅']],
  'bokeh': ['只描述“光斑”这个效果，不等于背景虚化；要虚化得配 shallow DOF', ['光斑', '焦外']],
  'backlighting': ['逆光；容易过曝，人像常配 rim light', ['逆光']],
  'rim light': ['轮廓光；抠出边缘用，配 backlighting 很稳', ['边缘光']],
  'Rembrandt lighting': ['伦勃朗光；人像半脸阴影，脸部特写最见效', ['伦勃朗布光']],
  'volumetric lighting': ['体积光/丁达尔；需要有雾或尘，否则看不出来', ['体积光', '丁达尔']],
  'cinematic lighting': ['电影打光；比 cinematic look 更直接作用于光', ['电影光']],
  'wide-angle lens': ['广角；会把边缘拉变形，人像别贴太近', ['广角']],
  'telephoto lens': ['长焦；压缩空间感，适合人像/远景', ['长焦']],
  'macro shot': ['微距；主体极近，适合材质、昆虫、水滴', ['微距']],
  'close-up': ['近景；脸或物体占画面主体，和 full body shot 互斥', ['特写', '近景']],
  'full body shot': ['全身；必须写，否则模型默认半身或大头', ['全身', '全身照']],
  'rule of thirds composition': ['三分构图；和 centered composition 互斥', ['三分法', '九宫格']],
  'symmetrical composition': ['对称构图；建筑、正面人像好用', ['对称']],

  // ---- 人物 / 服饰 ----
  'lolita fashion': ['洛丽塔；常配 frills、lace 细节词', ['洛丽塔', 'lo裙']],
  'hanfu': ['汉服；朝代感要再指明会更准', ['汉服']],
  'kimono': ['和服；和 hanfu 别同时写', ['和服']],
  'maid outfit': ['女仆装；配 cafe 场景很自然', ['女仆装']],
  'mechanical arm': ['机械臂；需要材质词才不塑料，配 metallic texture', ['义肢', '机械手臂']],
  'animal ears': ['兽耳；cat ears 更具体，二选一', ['兽耳']],
  'twin tails': ['双马尾；和 ponytail 同时写会打架', ['双马尾']],
  'silver hair': ['银发；想纯白用 white hair，两者观感不同', ['银发']],
  'heterochromia': ['异色瞳；左右眼不同色，特写才看得出来', ['异色瞳']],
  'freckles': ['雀斑；需要近景/特写才明显', ['雀斑']],
  'cybernetic implants': ['义体植入；适合赛博题材，配 neon 光更对味', ['义体']],

  // ---- 场景 ----
  'neon-lit street': ['霓虹街道；夜景必备，白天场景会矛盾', ['霓虹街']],
  'rainy night': ['雨夜；会自动加反光地面，配 wet reflective ground 重复', ['雨夜']],
  'morning mist': ['晨雾；体积光的好搭档', ['晨雾']],
  'starry sky': ['星空；想要银河用 milky way，两个一起写容易糊', ['星空']],
  'ruins': ['废墟；适合废土/末世，配 debris', ['废墟']],
  'library': ['图书馆；室内景，注意和 outdoor 光线词冲突', ['图书馆']],

  // ---- 材质 / 特效 ----
  'metallic texture': ['金属质感；机械、盔甲必配', ['金属质感']],
  'translucent': ['半透明；纱、皮肤、玻璃都能用，别全图都加', ['半透明']],
  'particle effects': ['粒子特效；会加很多小点，人像背景慎用', ['粒子']],
  'light spots': ['光点；和 bokeh 有点像，后者更圆更虚', ['光点']],
  'glowing effect': ['发光；自发光物体用，配 volumetric 才亮得起来', ['自发光']],

  // ---- 氛围 / 情绪 ----
  'melancholy': ['忧郁；会压暗色调，别和 bright/cheerful 类词同用', ['忧郁']],
  'serene': ['宁静；偏冷色调、留白多', ['宁静']],
  'ethereal': ['空灵；常配 mist、soft light', ['空灵']],
  'dreamy': ['梦幻；会加柔光和色偏，写实向慎用', ['梦幻']],

  // ---- 画幅 / 用途 ----
  'vertical composition': ['竖构图；出图尺寸也要设竖的，否则白搭', ['竖构图']],
  'poster design': ['海报设计；会加排版元素，纯插画别用', ['海报']],
  '9:16 aspect ratio': ['9:16；只影响构图倾向，实际尺寸要在出图设置里改', ['竖屏比例']],
};

let added = 0;
for (const e of g.entries) {
  const p = patch[e.en];
  if (!p) continue;
  const [note, aliases] = p;
  if (note) { e.note = note; added++; }
  if (aliases && aliases.length) e.aliases = aliases;
}

g.version = 2;
g.updatedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync(file, JSON.stringify(g, null, 2) + '\n', 'utf8');
const withNote = g.entries.filter(e => e.note).length;
const withAlias = g.entries.filter(e => e.aliases).length;
console.log(`写了 ${added} 条 note，${withAlias} 条 aliases，共 ${g.entries.length} 条词条，version=${g.version}`);
