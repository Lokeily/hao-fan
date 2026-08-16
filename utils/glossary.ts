// 预置翻译资料库（术语库 / Glossary）
// 目的：
//   1) 省 Token —— 高频 UI/网页术语「整条精确命中」直接返回译文，0 Token、0 网络往返。
//   2) 保证质量一致 —— 把当前文本里出现的术语作为「术语对照」注入提示词，
//      让 LLM 对同一术语始终产出同一译法（避免忽而"设置"忽而"设定"）。
//
// 内置库以「英文 → 目标语言」组织。目前主打 目标=中文 场景（网页多为英文原文）。
// 用户还可在设置页维护「我的术语表」，优先级高于内置库。

// ===== 内置高频术语库（按目标语言）=====
// key 一律用小写源词，value 为目标译文。命中时大小写不敏感。
const BUILTIN: Record<string, Record<string, string>> = {
  中文: {
    // 账户 / 认证
    'sign in': '登录',
    'sign up': '注册',
    'log in': '登录',
    login: '登录',
    logout: '退出登录',
    'log out': '退出登录',
    'sign out': '退出登录',
    register: '注册',
    account: '账户',
    profile: '个人资料',
    password: '密码',
    username: '用户名',
    email: '邮箱',
    'forgot password': '忘记密码',
    'remember me': '记住我',
    // 导航 / 通用操作
    home: '首页',
    settings: '设置',
    setting: '设置',
    preferences: '偏好设置',
    search: '搜索',
    menu: '菜单',
    dashboard: '仪表盘',
    overview: '概览',
    back: '返回',
    next: '下一步',
    previous: '上一步',
    continue: '继续',
    cancel: '取消',
    confirm: '确认',
    submit: '提交',
    save: '保存',
    delete: '删除',
    remove: '移除',
    edit: '编辑',
    add: '添加',
    create: '创建',
    upload: '上传',
    download: '下载',
    'sign in with google': '使用 Google 登录',
    close: '关闭',
    open: '打开',
    apply: '应用',
    reset: '重置',
    refresh: '刷新',
    retry: '重试',
    copy: '复制',
    paste: '粘贴',
    cut: '剪切',
    share: '分享',
    export: '导出',
    import: '导入',
    print: '打印',
    help: '帮助',
    about: '关于',
    contact: '联系我们',
    'contact us': '联系我们',
    feedback: '反馈',
    support: '支持',
    // 状态 / 提示
    loading: '加载中',
    'please wait': '请稍候',
    success: '成功',
    error: '错误',
    warning: '警告',
    failed: '失败',
    done: '完成',
    pending: '待处理',
    'coming soon': '敬请期待',
    'not found': '未找到',
    'page not found': '页面未找到',
    'no results': '暂无结果',
    'no data': '暂无数据',
    empty: '空',
    online: '在线',
    offline: '离线',
    active: '启用',
    inactive: '未启用',
    enabled: '已启用',
    disabled: '已禁用',
    // 电商 / 常见业务
    cart: '购物车',
    'shopping cart': '购物车',
    checkout: '结算',
    'add to cart': '加入购物车',
    'buy now': '立即购买',
    order: '订单',
    orders: '订单',
    payment: '支付',
    price: '价格',
    total: '合计',
    subtotal: '小计',
    discount: '折扣',
    coupon: '优惠券',
    'free shipping': '免运费',
    'in stock': '有货',
    'out of stock': '缺货',
    'sold out': '售罄',
    sale: '促销',
    'view more': '查看更多',
    'learn more': '了解更多',
    'read more': '阅读更多',
    'see all': '查看全部',
    'show more': '显示更多',
    'show less': '收起',
    // 内容 / 社交
    like: '点赞',
    comment: '评论',
    comments: '评论',
    reply: '回复',
    follow: '关注',
    following: '已关注',
    followers: '粉丝',
    subscribe: '订阅',
    subscribed: '已订阅',
    notifications: '通知',
    messages: '消息',
    'sign up for free': '免费注册',
    'get started': '开始使用',
    'try for free': '免费试用',
    'learn how': '了解方法',
    // 时间
    yesterday: '昨天',
    tomorrow: '明天',
    'just now': '刚刚',
    // 页脚 / 法务
    'terms of service': '服务条款',
    'terms of use': '使用条款',
    'privacy policy': '隐私政策',
    'cookie policy': 'Cookie 政策',
    'all rights reserved': '版权所有',
    'sign in to continue': '登录以继续',
    'accept all': '全部接受',
    'accept cookies': '接受 Cookie',
    'manage cookies': '管理 Cookie',
    faq: '常见问题',
    documentation: '文档',
    docs: '文档',
    guide: '指南',
    tutorial: '教程',
    'view details': '查看详情',
    details: '详情',
    description: '描述',
    category: '分类',
    categories: '分类',
    tags: '标签',
    filter: '筛选',
    'sort by': '排序方式',
    language: '语言',
    'dark mode': '深色模式',
    'light mode': '浅色模式',
    // ===== 第二批：常用问候 / 态度 / 动作 =====
    hello: '你好',
    hi: '你好',
    hey: '嘿',
    welcome: '欢迎',
    'welcome back': '欢迎回来',
    thanks: '谢谢',
    'thank you': '谢谢你',
    'thank you very much': '非常感谢',
    please: '请',
    'you are welcome': '不客气',
    yes: '是',
    no: '否',
    ok: '好的',
    okay: '好的',
    sure: '当然',
    maybe: '也许',
    agree: '同意',
    accept: '接受',
    reject: '拒绝',
    'i agree': '我同意',
    'i see': '我明白了',
    'of course': '当然',
    'good job': '干得漂亮',
    congratulations: '恭喜',
    'see you': '再见',
    goodbye: '再见',
    'excuse me': '抱歉',
    sorry: '对不起',
    // 动作 / 交互
    view: '查看',
    read: '阅读',
    write: '写入',
    send: '发送',
    receive: '接收',
    select: '选择',
    choose: '选择',
    drag: '拖动',
    drop: '拖放',
    scroll: '滚动',
    zoom: '缩放',
    expand: '展开',
    collapse: '收起',
    show: '显示',
    hide: '隐藏',
    enable: '启用',
    disable: '禁用',
    install: '安装',
    uninstall: '卸载',
    connect: '连接',
    disconnect: '断开连接',
    'sign in to': '登录以',
    // 技术 / 常见名词
    api: 'API',
    url: '网址',
    app: '应用',
    application: '应用',
    apps: '应用',
    browser: '浏览器',
    website: '网站',
    webpage: '网页',
    page: '页面',
    link: '链接',
    links: '链接',
    button: '按钮',
    image: '图片',
    images: '图片',
    photo: '照片',
    file: '文件',
    files: '文件',
    folder: '文件夹',
    document: '文档',
    documents: '文档',
    data: '数据',
    user: '用户',
    users: '用户',
    admin: '管理员',
    server: '服务器',
    client: '客户端',
    database: '数据库',
    cache: '缓存',
    bug: '缺陷',
    feature: '功能',
    features: '功能',
    'bug fix': '缺陷修复',
    update: '更新',
    version: '版本',
    config: '配置',
    configuration: '配置',
    plugin: '插件',
    extension: '扩展',
    'log in to': '登录到',
    // 时间 / 日期
    date: '日期',
    time: '时间',
    today: '今天',
    week: '周',
    month: '月',
    year: '年',
    minute: '分钟',
    hour: '小时',
    second: '秒',
    now: '现在',
    later: '稍后',
    'this week': '本周',
    'last week': '上周',
    // 程度 / 状态
    new: '新',
    hot: '热门',
    popular: '热门',
    best: '最佳',
    top: '顶部',
    recommended: '推荐',
    latest: '最新',
    free: '免费',
    premium: '高级版',
    pro: '专业版',
    trial: '试用',
    'on sale': '特价',
    'limited time': '限时',
    'for free': '免费',
    // 反馈 / 提示补充
    'try again': '重试',
    'go back': '返回',
    'load more': '加载更多',
    'no internet': '无网络连接',
    'network error': '网络错误',
    'something went wrong': '出错了',
    'are you sure': '确定吗',
    'do you want to': '是否要',
  },
};

// ===== 用户自定义术语库 =====
// 存储在 AppConfig.customGlossary（多行文本），格式：每行 "源词=译文" 或 "源词 -> 译文"。
// 解析为 Map（小写键）。用户条目优先级高于内置库。
export type TermMap = Record<string, string>;

export function parseCustomGlossary(raw?: string): TermMap {
  const map: TermMap = {};
  if (!raw) return map;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;
    // 支持 "a=b"、"a->b"、"a => b"、"a：b"（中文冒号）、"a\tb"
    const m = s.match(/^(.+?)\s*(?:=>|->|＝|=|：|:|\t)\s*(.+)$/);
    if (!m) continue;
    const src = m[1].trim().toLowerCase();
    const dst = m[2].trim();
    if (src && dst) map[src] = dst;
  }
  return map;
}

// 归一化：去首尾空白、转小写、去掉结尾常见标点，便于「整条精确命中」。
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?。！？:：,，;；\s]+$/u, '')
    .trim();
}

// 合并「内置库 + 用户库」，用户库覆盖内置。
function mergedMap(target: string, custom: TermMap): TermMap {
  const builtin = BUILTIN[target] || {};
  return { ...builtin, ...custom };
}

// ★ 整条精确命中：若整段文本本身就是一个术语 → 直接返回译文（0 Token）。
// 仅用于短文本（术语通常很短），避免误伤长句。
export function matchExact(text: string, target: string, custom: TermMap): string | null {
  const key = normalize(text);
  if (!key || key.length > 40) return null; // 超长不当作术语
  const map = mergedMap(target, custom);
  return map[key] ?? null;
}

// ★ 提取「当前文本里出现的术语」用于提示词注入，保证同一术语译法一致。
// 只回传确实出现在文本中的条目，避免整本术语库塞进 prompt 反而涨 Token。
// 返回形如 ["Settings → 设置", "Dashboard → 仪表盘"]，最多 limit 条。
export function relevantTerms(
  texts: string[],
  target: string,
  custom: TermMap,
  limit = 12,
): string[] {
  const map = mergedMap(target, custom);
  const customKeys = Object.keys(custom);
  const customSet = new Set(customKeys);
  const entries = [
    ...customKeys,
    ...Object.keys(BUILTIN[target] || {}).filter((key) => !customSet.has(key)),
  ];
  if (entries.length === 0) return [];
  const haystack = texts.join('\n').toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  // 短术语优先：同样命中时注入更少字符 = 更少 Token。
  const ranked = entries
    .map((src) => ({ src, len: src.length }))
    .sort((a, b) => a.len - b.len);
  for (const { src } of ranked) {
    if (out.length >= limit) break;
    if (seen.has(src)) continue;
    // 拉丁词用词边界，避免 "cat" 命中 "category"；含空格/非拉丁则用子串包含
    const hit =
      /^[a-z0-9 ]+$/.test(src) && !src.includes(' ')
        ? new RegExp(`\\b${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack)
        : haystack.includes(src.toLowerCase());
    if (hit) {
      seen.add(src);
      // 展示时源词首字母大写更自然（仅展示用，不影响匹配）
      const label = src.replace(/\b\w/g, (c) => c.toUpperCase());
      out.push(`${label} → ${map[src]}`);
      // 总字符上限：避免长术语列表推高每批固定开销
      if (out.reduce((sum, t) => sum + t.length, 0) > 500) break;
    }
  }
  return out;
}

// 组装注入提示词块（无相关术语时返回空串）。
export function buildGlossaryBlock(terms: string[]): string {
  if (terms.length === 0) return '';
  return `\n\n【术语对照表】以下术语请严格按对照译法翻译，保持全文一致：\n${terms.join('\n')}`;
}
