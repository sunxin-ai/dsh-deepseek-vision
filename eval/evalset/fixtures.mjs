/**
 * evalset 的机器可读真值表：视口、语义区块、缺陷清单。
 * shoot.mjs 与 assert.mjs 都从这里取，避免同一事实有两处出处。
 * 人读版本在各组的 defects.md 与 README.md，数值以本文件为准。
 */

/**
 * 每组夹具的视口与语义区块。
 * 视觉模型对单图收固定 token 预算（约 1024 tokens，与图像尺寸无关），整页图必被降采样，
 * 因此判定按区块送检；blocks 坐标是 CSS px 的 [x, y, width, height]。
 * `seam-` 前缀表示**跨区块缝隙**：区块间距类缺陷在任一单独区块内都看不出来，
 * 必须把上下两块一起裁进来才可归因。
 */
export const GROUPS = {
  landing: {
    kind: 'desktop', viewport: { width: 1280, height: 800 },
    blocks: {
      nav: [0, 0, 1280, 72],
      'hero-head': [290, 88, 700, 168],
      'hero-actions': [330, 250, 620, 172],
      features: [46, 434, 1188, 208],
      'feature-1': [46, 434, 396, 208],
      'feature-2': [442, 434, 396, 208],
      'feature-3': [838, 434, 396, 208],
      'seam-features-cta': [46, 596, 1188, 204],
      cta: [46, 662, 1188, 122],
    },
  },
  dashboard: {
    kind: 'desktop', viewport: { width: 1280, height: 800 },
    blocks: {
      sidebar: [0, 0, 217, 800],
      header: [232, 10, 1032, 70],
      metrics: [232, 78, 1032, 144],
      'metric-1': [236, 78, 253, 144],
      'metric-3': [750, 78, 253, 144],
      'metric-4': [1007, 78, 247, 144],
      chart: [232, 220, 1032, 325],
      table: [232, 543, 1032, 223],
    },
  },
  list: {
    kind: 'mobile', viewport: { width: 393, height: 852 },
    blocks: {
      header: [0, 44, 393, 62],
      search: [0, 100, 393, 56],
      chips: [0, 156, 393, 44],
      'seam-chips-list': [0, 154, 393, 132],
      'row-1': [0, 202, 393, 76],
      'row-2': [0, 273, 393, 76],
      rows: [0, 202, 393, 536],
      tabs: [0, 768, 393, 84],
    },
  },
  form: {
    kind: 'mobile', viewport: { width: 393, height: 852 },
    blocks: {
      bar: [0, 44, 393, 50],
      progress: [0, 96, 393, 22],
      title: [0, 108, 393, 96],
      'fields-top': [0, 200, 393, 138],
      'field-country': [0, 336, 393, 92],
      fields: [0, 198, 393, 340],
      'seam-fields-checks': [0, 498, 393, 172],
      checks: [0, 548, 393, 88],
      actions: [0, 664, 393, 188],
    },
  },
}

/**
 * 注入缺陷清单。每条：
 *   tier   易 / 中 / 难（RUBRIC §3 难度分档）
 *   facet  保真面
 *   blocks 该缺陷会改变像素的**全部**区块；第一个是归因区块。
 *          含 `seam-` 的条目是跨区块缺陷，单块裁图看不出来。
 *   v1/v2  唯一字符串锚点：必须在对应文件里恰好出现 1 次、在另一文件里 0 次。
 */
export const DEFECTS = {
  landing: [
    { id: 'L1', tier: '难', facet: '字体排印', blocks: ['hero-head'],
      what: '主标题 font-weight 800 → 500（跨一档）',
      v1: 'font-size:42px; font-weight:800; line-height:1.1;',
      v2: 'font-size:42px; font-weight:500; line-height:1.1;' },
    { id: 'L2', tier: '难', facet: '间距节奏', blocks: ['seam-features-cta', 'cta'],
      what: 'CTA 深色条上边距 40px → 12px（Δ28px），整条上移',
      v1: '.promo { margin-top:40px;', v2: '.promo { margin-top:12px;' },
    { id: 'L3', tier: '中', facet: '素材保真', blocks: ['feature-2', 'features'],
      what: '第 2 张特性卡的线性放大镜图标 → CSS 描边方块',
      v1: '<circle cx="11" cy="11" r="6.8"/>',
      v2: '<div style="width:21px;height:21px;border:1.7px solid #4B5ED8;"></div>' },
    { id: 'L4', tier: '中', facet: '布局', blocks: ['features', 'feature-1', 'feature-3'],
      what: '第 1 张卡（Live metrics）与第 3 张卡（Audit ready）位置对调',
      v1: '<h3 class="feature-name">Audit ready</h3>\n      <p class="feature-body">SOC 2 controls, row level permissions and a full history of who changed which definition and when they did it.</p>\n    </article>\n  </section>',
      v2: '<h3 class="feature-name">Live metrics</h3>\n      <p class="feature-body">Every event lands in under a second, so the dashboard your team opens is the dashboard that is true right now.</p>\n    </article>\n  </section>' },
    { id: 'L5', tier: '易', facet: '颜色', blocks: ['nav'],
      what: '导航「Get started」按钮 #4B5ED8 靛蓝 → #4BD886 绿（色相 232°→145°，S/L 不变）',
      v1: 'background:#4B5ED8; color:#FFFFFF; font-size:14px; font-weight:600; }',
      v2: 'background:#4BD886; color:#FFFFFF; font-size:14px; font-weight:600; }' },
    { id: 'L6', tier: '易', facet: '文案', blocks: ['hero-actions'],
      what: 'hero 信任背书数字 12,000+ → 21,000+',
      v1: 'Trusted by 12,000+ teams', v2: 'Trusted by 21,000+ teams' },
  ],
  dashboard: [
    { id: 'D1', tier: '难', facet: '字体排印', blocks: ['metric-3', 'metrics'],
      what: '第 3 张指标卡（Avg contract value）数值字号 28px → 26px（−2px）',
      v1: '.kpi-vs { font-size:11px; color:#98A0AE; }\n\n  /* chart panel */',
      v2: '.kpi:nth-child(3) .kpi-num { font-size:26px; }' },
    { id: 'D2', tier: '难', facet: '圆角', blocks: ['chart'],
      what: '折线图卡片圆角 14px → 8px（−6px）',
      v1: 'border:1px solid #E7E9EF; border-radius:14px; padding:16px 18px 12px; }',
      v2: 'border:1px solid #E7E9EF; border-radius:8px; padding:16px 18px 12px; }' },
    { id: 'D3', tier: '中', facet: '颜色', blocks: ['metric-1', 'metrics'],
      what: '第 1 张指标卡涨幅胶囊底色 #DFF6EB → #96E3BD（同色相 150°、S 58% 不变，明度 92%→74%，Δ18%）',
      v1: '.tag--pos { background:#DFF6EB; color:#1F8452; }\n  .tag--neg',
      v2: '.kpi:nth-child(1) .tag--pos { background:#96E3BD; }' },
    { id: 'D4', tier: '中', facet: '布局', blocks: ['table'],
      what: '表格 Status 列与 Amount 列整列对调（表头 + 3 行单元格）',
      v1: '<td class="who">Halcyon Labs</td>\n          <td><span class="flag flag--ok">Paid</span></td>',
      v2: '<td class="who">Halcyon Labs</td>\n          <td class="money">$18,400</td>' },
    { id: 'D5', tier: '易', facet: '文案', blocks: ['metric-4', 'metrics'],
      what: '第 4 张指标卡（Churned MRR）数值 $7,260 → $7,620（数字调换）',
      v1: '<div class="kpi-num">$7,260</div>', v2: '<div class="kpi-num">$7,620</div>' },
    { id: 'D6', tier: '易', facet: '颜色', blocks: ['sidebar'],
      what: '侧栏当前项底色/文字 #E9ECFB·#3444B2 靛蓝 → #FBE9F2·#B23473 品红（色相 232°→330°）',
      v1: '.nv--current { background:#E9ECFB; color:#3444B2;',
      v2: '.nv--current { background:#FBE9F2; color:#B23473;' },
  ],
  list: [
    { id: 'LS1', tier: '难', facet: '间距节奏', blocks: ['seam-chips-list', 'row-1', 'row-2', 'rows'],
      what: '筛选条与列表之间的间距 14px → 38px（Δ24px），整个列表下移',
      v1: '.threads { margin-top:14px;', v2: '.threads { margin-top:38px;' },
    { id: 'LS2', tier: '难', facet: '字体排印', blocks: ['header'],
      what: '页面标题 Messages 字号 26px → 24px（−2px）',
      v1: '.hdr h1 { flex:1; font-size:26px;', v2: '.hdr h1 { flex:1; font-size:24px;' },
    { id: 'LS3', tier: '中', facet: '素材保真', blocks: ['search'],
      what: '搜索框线性放大镜图标 → CSS 描边正圆（无手柄）',
      v1: '<circle cx="11" cy="11" r="6.4"/>',
      v2: '<div style="width:17px;height:17px;border-radius:50%;border:1.9px solid #9096A2;margin-right:9px;"></div>' },
    { id: 'LS4', tier: '中', facet: '颜色', blocks: ['row-2', 'rows'],
      what: '第 2 行头像底色 #EA8053 → #F4BCA4（同色相 18°、S 78% 不变，明度 62%→80%，Δ18%）',
      v1: 'style="background:#EA8053">MW', v2: 'style="background:#F4BCA4">MW' },
    { id: 'LS5', tier: '易', facet: '文案', blocks: ['row-1', 'rows', 'seam-chips-list'],
      what: '第 1 行摘要 "moved to Thursday" → "moved to Tuesday"（词替换）',
      v1: 'Design review moved to Thursday', v2: 'Design review moved to Tuesday' },
  ],
  form: [
    { id: 'F1', tier: '难', facet: '圆角', blocks: ['actions'],
      what: '主按钮 Continue to payment 圆角 12px → 18px（+6px）',
      v1: '.go { background:#4B5ED8; color:#FFFFFF; }\n  .actions .back',
      v2: '.actions .go { border-radius:18px; }' },
    { id: 'F2', tier: '难', facet: '间距节奏', blocks: ['seam-fields-checks', 'checks'],
      what: '表单字段区与复选框组之间的间距 24px → 50px（Δ26px），复选框组下移',
      v1: '.options { margin:24px 20px 0; }', v2: '.options { margin:50px 20px 0; }' },
    { id: 'F3', tier: '难', facet: '字体排印', blocks: ['title'],
      what: '页面标题 Shipping details 字重 700 → 500（跨一档）',
      v1: '.intro-title { font-size:24px; font-weight:700;',
      v2: '.intro-title { font-size:24px; font-weight:500;' },
    { id: 'F4', tier: '中', facet: '素材保真', blocks: ['field-country', 'fields'],
      what: '国家下拉框的线性 chevron 图标 → CSS 描边方块',
      v1: '<path d="M6.2 9.6L12 15.4l5.8-5.8"/>',
      v2: '<div class="caret" style="border:2px solid #6B7280;"></div>' },
    { id: 'F5', tier: '中', facet: '布局', blocks: ['fields-top', 'fields'],
      what: 'Full name 与 Email address 两个字段位置对调',
      v1: '<div class="form">\n    <div class="row">\n      <label for="fname">Full name</label>',
      v2: '<div class="form">\n    <div class="row">\n      <label for="mail">Email address</label>' },
    { id: 'F6', tier: '易', facet: '颜色', blocks: ['progress'],
      what: '进度条已完成段 #4B5ED8 靛蓝 → #E67433 橙（色相 232°→22°）',
      v1: 'width:66%; background:#4B5ED8;', v2: 'width:66%; background:#E67433;' },
  ],
}
