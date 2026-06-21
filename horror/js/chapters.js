// chapters.js — 《九百九十九》27 章定义
// 一条连续的"下降"叙事：从日常的裂缝，穿过潜意识的各层，直面"它"，抵达第 999 关的终局。
// 37 关 × 27 章 = 999，range 连续无缝覆盖 1..999。
//
// 设计原则：
//  - scene 从契约 15 种场景枚举里选，随下降逐渐从"熟悉世界"演化到"非世界"。
//  - mood 从契约 7 种情绪枚举里选，匹配该章的情绪曲线。
//  - palette 6 色：bg(底色) fog(雾) ink(文字/线条) blood(暗红) glow(微光) accent(主色)。
//    基调深黑/暗红/惨白/冷青；每章有独立主色，越深越异常（主色逐渐脱离自然、偏向病态）。
//  - motifs 用契约点缀 key：door/eye/hand/figure/clock/stairs/water/candle …
//
// 整体弧线（四幕）：
//  幕一 第 1–7 章  (1–259)：日常的裂缝。熟悉世界开始失真，你被往下拉。
//  幕二 第 8–14 章 (260–518)：离开熟悉世界，穿过恐惧/记忆/悔恨/失去的潜意识地层。
//  幕三 第 15–22 章(519–814)：身份瓦解。你越来越不像"你"，旧面孔与旧名字脱落。
//  幕四 第 23–27 章(815–999)：直面"它"/真我，与终局抉择。

export const CHAPTERS = [
  // —— 幕一：日常的裂缝（1–259）——
  {
    n: 1, title: "下沉", range: [1, 37], theme: "异常初现", scene: "corridor",
    mood: "dread",
    palette: { bg: "#0a0b0d", fog: "#13161b", ink: "#c9ccd2", blood: "#4a1316", glow: "#2a3138", accent: "#5b6b78" },
    motifs: ["door", "clock", "stairs"],
    summary: "你住的楼里多出了一条走廊。它一直都在，只是你今天才注意到。走廊尽头有一扇门，门后是向下的。"
  },
  {
    n: 2, title: "多出来的一层", range: [38, 74], theme: "空间错位", scene: "stairs",
    mood: "dread",
    palette: { bg: "#090a0c", fog: "#14171c", ink: "#c2c6cc", blood: "#511418", glow: "#283036", accent: "#536470" },
    motifs: ["stairs", "door", "clock"],
    summary: "电梯按钮上多了一个数字，楼梯比记忆里多绕了一圈。每一层都标着比你以为的更小的数。你没在上楼。"
  },
  {
    n: 3, title: "回声", range: [75, 111], theme: "声音的来处", scene: "room",
    mood: "dread",
    palette: { bg: "#0a0a0c", fog: "#161519", ink: "#c6c2c6", blood: "#561519", glow: "#2c2a32", accent: "#6a5f72" },
    motifs: ["door", "hand", "candle"],
    summary: "你听见有人在叫你的名字，用的是只有母亲会用的语气。可你回头时，房间里的家具都比记忆中旧了一点。声音是从墙里来的。"
  },
  {
    n: 4, title: "镜子里慢半拍", range: [112, 148], theme: "自我的延迟", scene: "mirror",
    mood: "dread",
    palette: { bg: "#08090b", fog: "#131418", ink: "#cdd0d4", blood: "#4d1115", glow: "#313842", accent: "#7e8a94" },
    motifs: ["eye", "figure", "candle"],
    summary: "镜中的你眨眼总比你晚一瞬。某一关起，它开始不再模仿你，而是等你先动。它在学。"
  },
  {
    n: 5, title: "数到零之前", range: [149, 185], theme: "倒数的开始", scene: "room",
    mood: "dread",
    palette: { bg: "#0a0809", fog: "#181317", ink: "#c8c3c5", blood: "#621519", glow: "#2e2730", accent: "#8a6b6f" },
    motifs: ["clock", "door", "candle"],
    summary: "墙上的数字开始往回走。每下一层，剩下的数字就少一个。有个声音很温柔地告诉你：数到零，你就到家了。你不记得家在哪里。"
  },
  {
    n: 6, title: "你不是第一个", range: [186, 222], theme: "前人的痕迹", scene: "cellar",
    mood: "dread",
    palette: { bg: "#080808", fog: "#15130f", ink: "#c4bfb6", blood: "#5a1612", glow: "#2d281d", accent: "#7a6a4e" },
    motifs: ["hand", "stairs", "door"],
    summary: "墙上刻满了名字，划痕停在不同的层数。有人刻到三百多就没再往下。地上的鞋是你的尺码，却不是你的鞋。"
  },
  {
    n: 7, title: "门后还是门", range: [223, 259], theme: "无尽的入口", scene: "corridor",
    mood: "numb",
    palette: { bg: "#070708", fog: "#121317", ink: "#bcc0c6", blood: "#4a1216", glow: "#262c33", accent: "#5a6975" },
    motifs: ["door", "stairs", "figure"],
    summary: "你已经数不清推开了多少扇门。每一扇后面都是另一条向下的走廊。你开始怀疑：上面那个世界，是不是也只是一扇门。"
  },

  // —— 幕二：穿过潜意识的地层（260–518）——
  {
    n: 8, title: "离开地面", range: [260, 296], theme: "失去出口", scene: "abyss",
    mood: "panic",
    palette: { bg: "#050608", fog: "#0e1115", ink: "#b8bcc4", blood: "#451015", glow: "#1c252e", accent: "#46586a" },
    motifs: ["stairs", "figure", "eye"],
    summary: "脚下的台阶消失了，但你没有停止下降。回头时，来路已经合拢成黑。这里没有上，只有更下。"
  },
  {
    n: 9, title: "恐惧的形状", range: [297, 333], theme: "具象化的怕", scene: "forest",
    mood: "hunt",
    palette: { bg: "#06080a", fog: "#101611", ink: "#b6c0b8", blood: "#52130f", glow: "#1f2a1f", accent: "#4e6a52" },
    motifs: ["figure", "eye", "hand"],
    summary: "黑暗里长出一片不该有的林子，每棵树都站成你小时候怕过的东西。第 333 关，它们第一次同时转过头。它们一直记得你。"
  },
  {
    n: 10, title: "记忆的潮", range: [334, 370], theme: "被淹没的过去", scene: "ocean",
    mood: "sorrow",
    palette: { bg: "#04070b", fog: "#0c141c", ink: "#b4c2cc", blood: "#3e1218", glow: "#16242f", accent: "#3c6a86" },
    motifs: ["water", "figure", "candle"],
    summary: "水从下面漫上来，每一滴都是你以为忘掉的一天。你越往下，水越深，记忆越清晰，清晰得让你想哭。"
  },
  {
    n: 11, title: "没寄出的信", range: [371, 407], theme: "未说出口的话", scene: "attic",
    mood: "sorrow",
    palette: { bg: "#070605", fog: "#15110c", ink: "#c6bcaf", blood: "#4d1411", glow: "#2a2218", accent: "#8a7558" },
    motifs: ["candle", "hand", "clock"],
    summary: "一间堆满旧物的阁楼，箱子里全是你想说却没说的话。它们落了灰，但墨迹还是湿的。有人替你保存了所有的沉默。"
  },
  {
    n: 12, title: "失去的人坐在那里", range: [408, 444], theme: "缺席的在场", scene: "room",
    mood: "sorrow",
    palette: { bg: "#060507", fog: "#131015", ink: "#c4c0c6", blood: "#451218", glow: "#241f28", accent: "#6a5a72" },
    motifs: ["figure", "candle", "clock"],
    summary: "房间里有一把空椅子，正对着门。每往下一关，椅子上的轮廓就实一点。你认得那个背影，你不敢让它转过来。"
  },
  {
    n: 13, title: "悔", range: [445, 481], theme: "回不去的岔路", scene: "garden",
    mood: "sorrow",
    palette: { bg: "#06070a", fog: "#101418", ink: "#bcc2c8", blood: "#4a131a", glow: "#1e262c", accent: "#5a7068" },
    motifs: ["door", "stairs", "water" ],
    summary: "一座荒掉的花园，每一条小径都是你当年没选的那条。它们开得很好，好得像是在嘲笑。你跪下来，土是软的，像新填的。"
  },
  {
    n: 14, title: "把名字交出去", range: [482, 518], theme: "身份开始松动", scene: "church",
    mood: "calm-before",
    palette: { bg: "#050608", fog: "#0f1116", ink: "#c8cad0", blood: "#3e1014", glow: "#1c2230", accent: "#566a86" },
    motifs: ["candle", "figure", "door"],
    summary: "一座沉在黑里的教堂，没有神，只有一本登记簿。要继续往下，得先在上面写下名字——然后看着它从你脑子里被划掉。"
  },

  // —— 幕三：身份瓦解（519–814）——
  {
    n: 15, title: "不属于这里", range: [519, 555], theme: "异乡的自己", scene: "subway",
    mood: "numb",
    palette: { bg: "#060608", fog: "#101114", ink: "#bec2c8", blood: "#421016", glow: "#1e242c", accent: "#4e5e6e" },
    motifs: ["figure", "clock", "stairs"],
    summary: "一座没有尽头的地下站台，列车永远刚走。站牌上的地名你一个都不认识，可每一个都写着'回家方向'。没人看你，因为你已经不太算个人。"
  },
  {
    n: 16, title: "脸落下来", range: [556, 592], theme: "面孔的剥离", scene: "flesh",
    mood: "panic",
    palette: { bg: "#080406", fog: "#160c0e", ink: "#c8b8ba", blood: "#6e1418", glow: "#2c1418", accent: "#9a4a4e" },
    motifs: ["eye", "hand", "figure"],
    summary: "墙开始有体温。你伸手扶住它，掌印陷进去，像按在脸上。某一关，你摸到自己的脸，发现它也开始软。它想换个人戴。"
  },
  {
    n: 17, title: "谁在用我的手", range: [593, 629], theme: "失去身体的主权", scene: "hospital",
    mood: "panic",
    palette: { bg: "#06080a", fog: "#0e1518", ink: "#c2cccc", blood: "#5a1416", glow: "#1c2a2c", accent: "#52888a" },
    motifs: ["hand", "eye", "clock"],
    summary: "惨白的长廊，每张床上都躺着一个等待手术的你。你的手开始做你没让它做的事。镜子里的医生戴着你的脸，问你叫什么——你答不上来。"
  },
  {
    n: 18, title: "静电里的人", range: [630, 666], theme: "信号中的他者", scene: "static",
    mood: "hunt",
    palette: { bg: "#050505", fog: "#121212", ink: "#c6c6c6", blood: "#561214", glow: "#262626", accent: "#8a8a8a" },
    motifs: ["eye", "figure", "clock"],
    summary: "世界开始像坏掉的频道。雪花点里站着一个轮廓，每一关都更清楚一点。第 666 关，它终于对上焦——那是你，但比你先到了这里。"
  },
  {
    n: 19, title: "数字开始撒谎", range: [667, 703], theme: "倒数的崩坏", scene: "void",
    mood: "panic",
    palette: { bg: "#030305", fog: "#0a0a10", ink: "#b6b8c4", blood: "#3e0e16", glow: "#14141e", accent: "#3e3e6a" },
    motifs: ["clock", "door", "figure"],
    summary: "层数不再老实地减一。你下了一层，数字却跳掉了三十。那个温柔的声音说：别数了，反正你也回不去了。它第一次没装温柔。"
  },
  {
    n: 20, title: "空", range: [704, 740], theme: "无物之境", scene: "void",
    mood: "numb",
    palette: { bg: "#020203", fog: "#08080c", ink: "#a8aab4", blood: "#340c12", glow: "#101018", accent: "#34344e" },
    motifs: ["figure", "eye", "door"],
    summary: "没有墙，没有地，没有上下。只有你和你正在变薄的念头。你想抓住一件确定的事，却发现连'你是谁'都松手了。"
  },
  {
    n: 21, title: "另一个我先到了", range: [741, 777], theme: "被顶替", scene: "mirror",
    mood: "hunt",
    palette: { bg: "#040406", fog: "#0c0c12", ink: "#bcbec8", blood: "#4a1018", glow: "#181822", accent: "#48486e" },
    motifs: ["figure", "eye", "stairs"],
    summary: "镜子不再有你。镜子里的那个，正过着你上面的生活，盖你的被子，回你母亲的话。它做得比你好。也许从来就该是它。"
  },
  {
    n: 22, title: "回声尽头", range: [778, 814], theme: "声音的源头", scene: "cellar",
    mood: "dread",
    palette: { bg: "#030304", fog: "#0a0a0e", ink: "#b0b2bc", blood: "#440e16", glow: "#141420", accent: "#3c3c5e" },
    motifs: ["door", "hand", "candle"],
    summary: "你终于走到所有回声的来处。那个一直叫你名字的声音，住在一扇你从第一关起就在躲的门后。门没锁。它一直在等你自己推开。"
  },

  // —— 幕四：直面"它"/真我，终局抉择（815–999）——
  {
    n: 23, title: "门后的房间", range: [815, 851], theme: "核心的入口", scene: "room",
    mood: "calm-before",
    palette: { bg: "#020203", fog: "#08080a", ink: "#c0c2c8", blood: "#5a121a", glow: "#16161e", accent: "#46466a" },
    motifs: ["door", "figure", "candle"],
    summary: "门后是你出生时的那个房间，分毫不差，连光都对。中央坐着一个背对你的小孩，正数着数。他数到的，正是你现在的层数。"
  },
  {
    n: 24, title: "它一直在你里面", range: [852, 888], theme: "内在的真相", scene: "flesh",
    mood: "revelation",
    palette: { bg: "#050204", fog: "#12080c", ink: "#c8b6bc", blood: "#7a121c", glow: "#28101a", accent: "#a8424e" },
    motifs: ["eye", "hand", "figure"],
    summary: "你以为自己在下降，其实是在内陷。这一路的每一层，都是你为了不去想某件事，亲手砌起来的墙。'它'不是怪物。它是被你关在最底下的你自己。"
  },
  {
    n: 25, title: "真我", range: [889, 925], theme: "直面", scene: "mirror",
    mood: "revelation",
    palette: { bg: "#040104", fog: "#100610", ink: "#ccc2cc", blood: "#84121e", glow: "#2c1024", accent: "#b0466a" },
    motifs: ["figure", "eye", "candle"],
    summary: "最后一面镜子里没有怪物，只有你，安静地看着你，像看着一个终于回来的人。它开口，用的是你的声音，说：你终于肯往下看了。"
  },
  {
    n: 26, title: "数到一", range: [926, 962], theme: "终局将至", scene: "abyss",
    mood: "calm-before",
    palette: { bg: "#030103", fog: "#0c050c", ink: "#c4bcc6", blood: "#6e1020", glow: "#220c20", accent: "#8c3c64" },
    motifs: ["clock", "door", "stairs"],
    summary: "只剩最后几层。下降变得很慢，很轻，像落叶。那个温柔的声音回来了，这次你听出来了——它从来都是你自己。它在替你，数最后几个数。"
  },
  {
    n: 27, title: "数到零", range: [963, 999], theme: "抉择与留白", scene: "void",
    mood: "revelation",
    palette: { bg: "#000000", fog: "#070409", ink: "#d4ccd4", blood: "#9a1024", glow: "#2e0c22", accent: "#c8506a" },
    motifs: ["door", "figure", "candle"],
    summary: "零就在脚下。一扇门朝上开着，门外是你离开的那个清晨；脚下还有最后一层黑，里面是完整的你。两边都喊着'回家'。第 999 关，你要自己数出那个数。"
  }
];

// 校验：range 必须连续无缝覆盖 1..999（开发期自检，生产无副作用）。
(function validate() {
  let expect = 1;
  for (const c of CHAPTERS) {
    if (c.range[0] !== expect) {
      console.warn(`[chapters] 章 ${c.n} 起点 ${c.range[0]} 应为 ${expect}`);
    }
    expect = c.range[1] + 1;
  }
  if (CHAPTERS.length !== 27) console.warn(`[chapters] 章数 ${CHAPTERS.length} 应为 27`);
  if (expect - 1 !== 999) console.warn(`[chapters] 终点 ${expect - 1} 应为 999`);
})();

// 给关卡 id（1..999）返回其所属章节对象。健壮：越界自动夹取到首/末章。
export function chapterOf(id) {
  const n = Math.max(1, Math.min(999, Math.floor(id) || 1));
  // 37 关一章，等距，直接整除定位（避免遍历）。
  const idx = Math.min(26, Math.floor((n - 1) / 37));
  return CHAPTERS[idx];
}
