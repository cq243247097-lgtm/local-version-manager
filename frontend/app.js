'use strict';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));

const tag = (text, color = '') => `<span class="tag ${color}">${escapeHtml(text)}</span>`;

// 判断当前运行模式（由服务端 static.js 注入固定 real 标记；preview.mjs 原样提供 preview 标记）
const isRealMode = document.querySelector('meta[name="app-mode"]')?.getAttribute('content') === 'real';

// ==========================================
// 演示数据与模拟功能（保持 preview 原有行为）
// ==========================================
const fileNames = [
  'src/pages/inventory.vue',
  'src/components/VersionTree.vue',
  'src/styles/theme.css',
  'src/pages/products.vue',
  'src/utils/format.ts',
  'src/components/SearchBar.vue',
  'src/pages/dashboard.vue',
  'src/components/EmptyState.vue',
  'src/utils/version.ts',
  'src/pages/settings.vue',
  'src/components/StatusBadge.vue',
  'src/styles/layout.css',
  'src/pages/customers.vue',
  'src/components/PackageInfo.vue',
  'src/utils/date.ts',
  'src/pages/orders.vue',
  'src/components/CommitGraph.vue',
  'docs/interface.md',
];

const initialCommits = () => [
  { id: 'd3a92f1', message: '优化版本列表与状态提示', note: '本地提交 · 等待推送', ref: 'main · 当前', lane: 0, date: '09-26 14:30' },
  { id: 'b7c18a4', message: '合并安装包信息展示', note: '本地提交 · 等待推送', ref: '', lane: 0, date: '09-25 14:30' },
  { id: 'c5e41d2', message: '增加安装包目录与详情', note: '功能分支已合并 · 等待推送', ref: 'feature/package', lane: 1, date: '09-24 14:30' },
  { id: 'a2d67b9', message: '保存基础页面布局', note: '本地与远端共有的版本', ref: 'origin/main', lane: 0, date: '09-23 14:30' },
  { id: 'f1b04e8', message: '创建演示项目', note: '版本起点', ref: 'v1.1.0', lane: 0, date: '09-22 14:30' },
];

const installers = [
  { id: 'i15', version: 'v1.5.0', revision: 'r1', state: '待校验', color: 'amber', file: 'demo-v1.5.0-installer-r1.exe', size: '186 MB', date: '2026-09-26 16:30', hash: '尚未检查', install: '尚未验证', source: '来源待确认', tip: '已经找到文件。下一步先核对完整性，再在测试环境验证安装。' },
  { id: 'i14', version: 'v1.4.0', revision: 'r2', state: '安装验证通过', color: '', file: 'demo-v1.4.0-installer-r2.exe', size: '182 MB', date: '2026-09-24 10:15', hash: '通过（演示）', install: 'Windows 11 · 2026-09-24（演示）', source: '演示提交 a2d67b9', tip: '演示记录显示此材料通过完整性及 Windows 11 安装测试；其他系统仍未验证。' },
  { id: 'i13', version: 'v1.3.0', revision: 'r1', state: '校验异常', color: 'red', file: 'demo-v1.3.0-installer-r1.exe', size: '97 MB', date: '2026-09-20 09:00', hash: '与登记摘要不一致（演示）', install: '尚未验证', source: '来源待确认', tip: '演示文件摘要与登记值不一致。请核对来源并重新取得完整材料，不应继续安装。' },
  { id: 'i12', version: 'v1.2.0', revision: 'r1', state: '信息不完整', color: 'amber', file: 'demo-v1.2.0-installer-r1.zip', size: '178 MB', date: '2026-09-18 14:20', hash: '尚未检查', install: '尚未验证', source: '缺少材料来源说明', tip: '发现一个归档文件，但缺少适用系统及来源说明，暂不能判断它是否适合安装。' },
  { id: 'i16', version: 'v1.6.0', revision: '待放入', state: '空目录', color: 'gray', file: null, tip: '目录已经预留，但还没有安装包。空目录不代表版本已制作或已发布。' },
];

const upgrades = [
  { id: 'u15', version: 'v1.5.0', revision: 'r1', state: '兼容范围已声明', color: '', file: 'demo-v1.5.0-upgrade-r1.zip', size: '24 MB', sources: [['v1.4.0', '支持直接升级', '已验证（演示）'], ['v1.3.0', '支持直接升级', '已验证（演示）'], ['v1.2.0', '支持直接升级', '待验证'], ['v1.1.0', '需先升级到 v1.2.0', '中间步骤待验证']] },
  { id: 'u14', version: 'v1.4.0', revision: 'r1', state: '兼容范围已声明', color: '', file: 'demo-v1.4.0-upgrade-r1.zip', size: '19 MB', sources: [['v1.3.0', '支持直接升级', '已验证（演示）'], ['v1.2.0', '支持直接升级', '待验证']] },
  { id: 'u13', version: 'v1.3.0', revision: 'r1', state: '升级范围待确认', color: 'amber', file: 'demo-v1.3.0-upgrade-r1.zip', size: '16 MB', sources: [] },
  { id: 'u16', version: 'v1.6.0', revision: '待放入', state: '空目录', color: 'gray', file: null, sources: [] },
];

let state;
let toastTimer;

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4000);
}

function modal(title, body) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  if (!$('#dialog').open) $('#dialog').showModal();
}

function heading(title, subtitle) {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div></div>`;
}

function formatCommitDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
}

function minimumSupport(item) {
  if (!item.file) return '<span class="minimum-support muted">暂无升级包</span>';
  const supported = item.sources.filter((row) => row[1] === '支持直接升级');
  supported.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  if (!supported.length) return '<span class="minimum-support muted">→ 待确认</span>';
  return (
    '<span class="minimum-support" title="声明支持直接升级的最低来源版本；具体范围及实测状态见右侧列表">→ <strong>' +
    escapeHtml(supported[0][0]) +
    '</strong><small>最低支持</small></span>'
  );
}

function archivePage(view) {
  const installer = view === 'installer', items = installer ? installers : upgrades;
  const selected = items.find((item) => item.id === (installer ? state.selectedInstaller : state.selectedUpgrade));
  return `${heading(
    installer ? '安装包资料库' : '升级包资料库',
    installer ? '找到材料，也看懂它是否已经准备好。' : '明确升级起点，让每一次更新有据可循。'
  )}<div class="archive-layout"><section class="panel tree-panel"><h2>${
    installer ? '安装包目录' : '升级包目录'
  }</h2><p>${items.filter((i) => i.file).length} 份演示材料 · ${
    items.filter((i) => !i.file).length
  } 个空目录</p>${
    installer ? '' : '<p class="tree-hint">目标版本 → 最低支持的来源版本</p>'
  }<details class="tree-root" open><summary>${
    installer ? '安装包区' : '升级包区'
  }</summary>${items
    .map(
      (item) =>
        `<details class="version-folder" open><summary>${item.version}${
          installer ? '' : minimumSupport(item)
        }</summary><button class="tree-item ${
          selected.id === item.id ? 'selected' : ''
        }" data-package="${item.id}" aria-pressed="${selected.id === item.id}"><span class="file-symbol">${
          item.file ? '▣' : '□'
        }</span><span><strong>${
          item.file ? item.revision + ' · ' + (installer ? 'Windows 安装包' : '增量升级包') : '预留目录'
        }</strong><small>${item.state}${item.file ? ' · ' + item.size : ''}</small></span></button></details>`
    )
    .join('')}</details></section><section class="panel" aria-label="材料详情">${
    installer ? installerDetail(selected) : upgradeDetail(selected)
  }</section></div>`;
}

function emptyDetail(item) {
  return `<div class="empty"><div class="empty-symbol">□</div><h3>这个版本还没有${
    state.view === 'installer' ? '安装包' : '升级包'
  }</h3><p>目前只有目录，材料尚未放入。</p><p class="caption">目录存在不代表已制作、已备份或已发布。</p></div><div class="actions"><button class="button" data-action="empty-help">了解下一步</button></div>`;
}

function detailHeader(item, type) {
  return `<div class="detail-title"><div><h2>${item.version} ${type}</h2><p>${item.revision} · 虚构材料，仅用于交互体验</p></div>${tag(
    item.state,
    item.color
  )}</div>`;
}

function installerDetail(item) {
  if (!item.file) return detailHeader(item, '安装包') + emptyDetail(item);
  return `${detailHeader(item, '安装包')}<div class="state-notice ${
    item.color === 'red' ? 'bad' : item.color === '' ? 'good' : ''
  }">${item.tip}</div><dl class="metadata"><div><dt>适用系统</dt><dd>${
    item.id === 'i12' ? '尚未登记' : 'Windows x64（演示）'
  }</dd></div><div><dt>归档时间</dt><dd>${item.date}</dd></div><div><dt>源码关联</dt><dd>${
    item.source
  }</dd></div><div><dt>文件大小</dt><dd>${item.size}</dd></div></dl><h3>材料检查</h3><ul class="checklist"><li><span>01　文件是否存在</span>${tag(
    '已有文件'
  )}</li><li><span>02　完整性校验</span><span>${item.hash}</span></li><li><span>03　安装验证</span><span>${
    item.install
  }</span></li></ul><div class="file-entry"><span class="file-symbol">▣</span><div><code>${
    item.file
  }</code><small>仅展示虚构文件名，不对应磁盘文件</small></div></div><div class="actions"><button class="button" data-action="material-record">查看演示记录</button><button class="button" data-action="verify-help">如何确认材料可用？</button></div>`;
}

function upgradeDetail(item) {
  if (!item.file) return detailHeader(item, '升级包') + emptyDetail(item);
  const supported = item.sources.filter((row) => row[1] === '支持直接升级').length;
  const tested = item.sources.filter((row) => row[1] === '支持直接升级' && row[2] === '已验证（演示）').length;
  return `${detailHeader(item, '升级包')}<div class="file-entry"><span class="file-symbol">⇧</span><div><code>${
    item.file
  }</code><small>${
    item.size
  } · 完整性：尚未校验 · 源码来源：待确认</small></div></div><dl class="metadata"><div><dt>升级目标</dt><dd>${
    item.version
  }</dd></div><div><dt>适用系统</dt><dd>Windows x64（演示）</dd></div></dl><div class="compat-stat">${
    item.sources.length
      ? `<strong>${supported}</strong> 个来源版本声明支持直接升级<p>其中 ${tested} 个已验证，${
          supported - tested
        } 个待验证（均为演示记录）</p>`
      : '<h3>升级范围待确认</h3><p>尚未登记来源版本，不能推断兼容数量。</p>'
  }</div>${
    item.sources.length
      ? `<h3>支持从哪些版本升级？</h3><table class="compatibility"><thead><tr><th>当前版本</th><th>升级方式</th><th>验证状态</th></tr></thead><tbody>${item.sources
          .map(
            (row) =>
              `<tr><td><strong>${row[0]}</strong></td><td>${row[1]}</td><td>${tag(
                row[2],
                row[2].startsWith('已验证') ? '' : 'amber'
              )}</td></tr>`
          )
          .join('')}</tbody></table><p class="caption">未列出的版本均为未知；中间升级路径尚未验证，不是可执行指导。</p>`
      : '<div class="state-notice">需要材料提供者登记明确的来源版本及验证证据。版本号更旧，不代表一定能升级。</div>'
  }<div class="actions"><button class="button" data-action="compat-help">我该选哪个升级包？</button></div>`;
}

// 演示模式源码区页面
function files() {
  return Array.from({ length: state.count }, (_, i) => ({
    name: fileNames[i] || `src/demo/part-${i + 1}.vue`,
    kind: i % 7 === 0 ? '新增' : i % 11 === 0 ? '删除' : '修改',
  }));
}

function showFiles() {
  modal(
    '查看工作区改动（演示）',
    `<p>${state.count} 个变更文件。每格代表一个文件，不代表编辑次数。</p><div class="file-list">${
      files()
        .map(
          (file, i) =>
            `<div class="file-row">${tag(file.kind, file.kind === '删除' ? 'red' : file.kind === '新增' ? '' : 'amber')}<button class="text-button" data-file="${i}"><code>${file.name}</code></button></div>`
        )
        .join('') || '<p>　工作区干净，没有未提交文件。</p>'
    }</div>`
  );
}

function showFile(index) {
  const file = files()[index];
  if (!file) return;
  modal(
    '文件改动（演示）',
    `<p><code>${escapeHtml(file.name)}</code></p>${tag(
      file.kind
    )}<p>以下为示意差异，不是该项目的实际源码。</p><pre class="diff">${
      file.kind === '删除'
        ? '- 移除旧的演示内容'
        : '+ 增加版本状态说明\n+ 显示更清楚的操作提示'
    }</pre><button class="button" data-action="files">返回全部文件</button>`
  );
}

function demoGraph() {
  const commits = state.commits;
  let paths = '';
  for (let i = 0; i < commits.length - 1; i++) {
    const x = commits[i].lane ? 70 : 25,
      next = commits[i + 1].lane ? 70 : 25;
    paths += `<path d="M ${x} ${i * 100 + 50} C ${x} ${i * 100 + 100}, ${next} ${i * 100 + 100}, ${next} ${
      i * 100 + 150
    }" fill="none" stroke="${x === 70 || next === 70 ? '#9266c9' : '#008786'}" stroke-width="4"/>`;
    if (x === 25 && next === 70 && commits[i + 2])
      paths += `<path d="M 25 ${i * 100 + 50} V ${i * 100 + 250}" stroke="#008786" stroke-width="4"/>`;
  }
  return `<div class="graph-table"><div class="graph-head"><span>提交</span><span>图形</span><span>提交信息</span><span>时间（演示）</span><span>分支 / 标签</span><span>详情</span></div><svg class="graph-canvas" viewBox="0 0 100 ${
    commits.length * 100
  }" preserveAspectRatio="none" aria-label="分支关系：功能分支由主线分出后合并回 main" role="img">${paths}${commits
    .map((c, i) => `<circle cx="${c.lane ? 70 : 25}" cy="${i * 100 + 50}" r="8" fill="${c.lane ? '#9266c9' : '#008786'}"/>`)
    .join('')}</svg>${commits
    .map(
      (c, i) =>
        `<div class="commit-row"><code>${escapeHtml(c.id)}</code><span></span><div class="commit-message">${escapeHtml(
          c.message
        )}<small>${escapeHtml(c.note)}</small></div><time>${c.new ? '刚刚' : c.date}</time><span>${
          c.ref ? tag(c.ref, c.lane ? 'purple' : c.ref.includes('origin') ? 'blue' : '') : ''
        }</span><button class="text-button" data-commit="${i}" aria-label="查看提交 ${escapeHtml(c.id)}">···</button></div>`
    )
    .join('')}</div>`;
}

function demoSourcePage() {
  const level = state.count >= 23 ? 'red' : state.count >= 16 ? 'orange' : state.count >= 8 ? 'yellow' : 'green';
  const description =
    state.count === 0
      ? '工作区已保存'
      : state.count >= 23
      ? '改动较多，建议检查并分批提交'
      : state.count >= 16
      ? '已有一组改动，建议检查后提交'
      : '可继续工作，也可以先保存一个版本';
  return `${heading('源码工作台', '每一次改动，都有迹可循。')}
  <div class="source-top"><section class="panel"><div class="panel-header"><h2>工作区文件状态</h2><button class="text-button" data-action="files">查看全部文件 →</button></div>
  <div class="capacity"><div class="squares level-${level}">${Array.from(
    { length: 25 },
    (_, i) =>
      `<button class="square ${i < state.count ? 'filled' : ''}" ${
        i >= state.count ? 'disabled' : ''
      } data-file="${i}" aria-label="${i < state.count ? escapeHtml(files()[i].name) : '空余提醒格'}"></button>`
  ).join('')}</div><div><div class="big-number" id="change-count">${state.count}</div><div class="count-label">未提交文件</div><p class="caption">${
    state.count > 25 ? '25 格已满，实际 ' + state.count + ' 个文件' : '25 格提醒刻度 · 非容量上限'
  }</p></div></div>
  <p class="caption">${description}</p><div class="legend"><span><i class="green-key"></i>1–7 少量</span><span><i class="yellow-key"></i>8–15 留意</span><span><i class="orange-key"></i>16–22 较多</span><span><i class="red-key"></i>23+ 提醒</span></div>
  <div class="scenario"><label for="scenario">体验不同状态</label><select id="scenario"><option value="">选择演示场景</option><option value="0">0 个 · 全部保存</option><option value="5">5 个 · 少量改动</option><option value="12">12 个 · 开始积累</option><option value="18">18 个 · 建议检查</option><option value="25">25 个 · 红色提醒</option><option value="38">38 个 · 超出刻度</option></select></div></section>
  <section class="panel"><div class="panel-header"><h2>本地 / 远端同步状态</h2><button class="text-button" data-action="refresh">模拟刷新状态 ↻</button></div><div class="pipeline"><div class="stage"><div class="stage-symbol">▰</div><strong>工作区</strong><small>${
    state.count ? '当前改动尚未保存' : '改动已保存'
  }</small></div><div class="arrow"></div><div class="stage"><div class="stage-symbol">▤</div><strong>本地仓库</strong><small>main · 当前分支</small></div><div class="arrow"></div><div class="stage"><div class="stage-symbol">↑</div><strong>远端仓库</strong><small>${
    state.pending ? '有提交尚未同步' : '演示记录已同步'
  }</small></div></div><div class="sync-summary"><strong id="pending-count">${state.pending}</strong><div><b>待推送提交</b><p>${
    state.pending ? '本地已有记录，尚未推送到远端仓库。' : '当前演示提交均已同步，未提交文件不会随推送保存。'
  }</p></div></div><div class="actions"><button class="button" data-action="files">查看改动</button><button class="button primary" data-action="commit" ${
    state.count === 0 ? 'disabled' : ''
  }>模拟提交</button><button class="button primary" data-action="push" ${
    state.pending === 0 ? 'disabled' : ''
  }>模拟推送</button></div><p class="caption">${
    state.refreshed ? '刚刚模拟刷新 · 未访问网络' : '远端状态来自固定演示快照 · 非真实查询'
  }</p></section></div>
  <section class="panel graph-panel"><div class="panel-header"><h2>分支与版本记录</h2><span class="caption">点击节点详情，了解每个版本</span></div>${demoGraph()}</section>`;
}

function demoReset() {
  state = {
    view: 'source',
    count: 18,
    pending: 3,
    commits: initialCommits(),
    selectedInstaller: 'i15',
    selectedUpgrade: 'u15',
    refreshed: false,
    serial: 0,
  };
  renderDemo();
}

function renderDemo() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#page').innerHTML = state.view === 'source' ? demoSourcePage() : archivePage(state.view);
  $('#help-text').textContent =
    state.view === 'source'
      ? '提交是本地保存一个版本；推送才会把提交同步到远端。'
      : state.view === 'installer'
      ? '文件存在 ≠ 安装可用。完整性校验和安装验证是两件不同的事。'
      : '支持范围需要明确记录；不能仅凭版本号大小判断是否能升级。';
}

function demoAction(name) {
  if (name === 'files') return showFiles();
  if (name === 'refresh') {
    state.refreshed = true;
    renderDemo();
    return notify('已模拟刷新；未连接远端，也未改变源码。');
  }
  if (name === 'commit') {
    if (!state.count) return;
    modal(
      '保存一个本地版本（模拟）',
      `<p>将当前 ${state.count} 个演示文件合为一次提交。提交后，待推送数量增加 1。</p><form id="commit-form"><label class="field">这次修改了什么？<input id="commit-message" name="message" maxlength="80" placeholder="例如：完善安装包状态提示" required autocomplete="off"></label><p class="error" id="commit-error"></p><button class="button primary" type="submit">确认模拟提交</button></form><p class="caption">只修改页面内存，不会运行 git commit。</p>`
    );
    return;
  }
  if (name === 'push') {
    if (!state.pending) return;
    modal(
      '同步到远端（模拟）',
      `<p>将 ${state.pending} 次本地演示提交同步到 origin/main。</p><div class="state-notice">${
        state.count ? `还有 ${state.count} 个文件没有提交。这些改动不会包含在推送中。` : '当前演示工作区已保存。'
      }</div><div class="actions"><button class="button primary" data-action="confirm-push">确认模拟推送</button></div><p class="caption">不会联网，也不会运行 git push。</p>`
    );
    return;
  }
  if (name === 'confirm-push') {
    state.pending = 0;
    state.commits.forEach((c, i) => {
      if (c.ref === 'origin/main') c.ref = '';
      if (c.note.includes('等待推送')) c.note = '已模拟同步到远端';
      if (i === 0) c.ref = 'main · origin/main';
    });
    $('#dialog').close();
    renderDemo();
    return notify('模拟推送完成：演示提交已同步，真实仓库未改变。');
  }
  showHelpContent(name);
}

function showHelpContent(name) {
  const content = {
    'empty-help': ['目录里还没有材料', '先制作并验证材料，再由归档工具记录文件、版本和来源。这个演示页面不执行导入或制作。'],
    'verify-help': ['三个检查，三种含义', '文件存在：只说明目录有文件。完整性通过：说明文件与记录一致。安装验证通过：说明在某个明确环境中实际验证过安装；需要查看日期与环境。'],
    'material-record': ['材料演示记录', '记录来源：页面内置虚构数据。没有读取磁盘，也没有计算摘要或运行安装。来源待确认的材料，不能认定与某次源码提交精确对应。'],
    'compat-help': ['先确定当前版本，再选择升级目标', '在兼容表中找到当前版本。只有明确列为支持的版本才有直接升级声明；还要核对验证状态、系统和材料完整性。未列出、待确认或中间步骤未验证的情况，需要进一步确认。'],
    'guide': isRealMode
      ? [
          '看懂真实本地工作台状态',
          '源码：工作区统计未提交文件；本地/远端仅根据本地跟踪引用快照计算领先与落后，未联网核实。25 格仅分级提醒数量，非容量上限。安装包/升级包：只读扫描已关联材料，登记的验证结论不等于本次核验。源码查看默认只读；只有选择文件、核对预览并明确确认后才会本地提交，不会推送或联网。',
        ]
      : [
          '看懂版本与材料状态',
          '源码：未提交按变更文件统计；未推送按提交记录统计。方块颜色只提醒积累数量，不判断改动风险。安装包：有文件不等于可安装。升级包：声明支持不等于已经实测。所有本页信息都是演示数据。',
        ],
  };
  if (content[name]) modal(content[name][0], `<p>${content[name][1]}</p>`);
}

// ==========================================
// 真实模式 Git 只读工作台与 PC 接入向导
// ==========================================
let realProjects = [];
let currentProjectId = null;
let currentProjectData = null; // { source, history }
let realActiveRequestSerial = 0;
let lastInspectResult = null;
let onboardSerial = 0;
let lastRealError = null; // { source: 'list' | 'project', selectId?: string, projectId?: string }

function generateCandidateId() {
  const bytes = new Uint8Array(6);
  window.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `project-${hex}`;
}

async function apiFetch(url, options = {}) {
  const headers = { ...options.headers };
  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch {
    return {
      status: 0,
      ok: false,
      data: { error: { code: 'NETWORK_ERROR', message: '无法连接本机服务，请确认服务正在运行后重试。' } },
    };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, data: json };
}

// 初始化真实工作台
async function initRealMode() {
  state = { view: 'source', selectedInstaller: 'i15', selectedUpgrade: 'u15' };
  $('#reset').style.display = 'none';
  $('#sidebar-foot').innerHTML = `<span class="dot"></span> <span>真实本地模式</span><small>本地 Git 快照 · 零外部网络</small>`;
  $('#demo-banner').innerHTML = '<strong>真实本地工作台</strong><span>查看默认只读；本人确认后可提交选中文件，仅保存到本地。</span>';
  $('#demo-banner').classList.add('real-banner');
  $('#project-selector-wrapper').style.display = 'flex';
  $('#btn-refresh-real').style.display = 'inline-block';
  $('#recover-material-operation').hidden = false;

  await reloadProjectsList();
}

async function reloadProjectsList(selectId = null) {
  closeMaterialOperation();
  closeCommitDialog();
  const listSerial = ++realActiveRequestSerial; // 配置列表重载时废弃尚未完成的旧项目读取
  ++realActiveMaterialSerial; // 同时废弃旧材料清单请求
  currentProjectData = null;
  currentMaterialData = null;
  selectedMaterialItemId = null;
  lastMaterialError = null;
  const res = await apiFetch('/api/projects');
  if (listSerial !== realActiveRequestSerial) return;
  if (!res.ok) {
    lastRealError = { source: 'list', selectId };
    renderRealError('无法加载项目配置列表', res.data?.error?.code, res.data?.error?.message, 'list');
    return;
  }

  lastRealError = null;
  realProjects = res.data.projects || [];
  const select = $('#project-select');
  select.innerHTML = '';

  if (realProjects.length === 0) {
    select.innerHTML = '<option value="">(尚未接入项目)</option>';
    currentProjectId = null;
    currentProjectData = null;
    currentMaterialData = null;
    selectedMaterialItemId = null;
    $('#project-breadcrumb').innerHTML = `<span>未接入项目 <span class="separator">/</span> <strong>本地版本管理</strong></span>`;
    renderReal();
    return;
  }

  realProjects.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });

  // 确定选中项
  const targetId = selectId || sessionStorage.getItem('selected_project_id') || realProjects[0].id;
  const match = realProjects.find((p) => p.id === targetId) || realProjects[0];
  currentProjectId = match.id;
  select.value = currentProjectId;
  sessionStorage.setItem('selected_project_id', currentProjectId);

  updateTopbarBreadcrumb();
  if (state.view === 'source') {
    await loadRealProject(currentProjectId);
  } else {
    await loadRealMaterial(currentProjectId, state.view);
  }
}

function updateTopbarBreadcrumb() {
  const current = realProjects.find((p) => p.id === currentProjectId);
  if (current) {
    $('#project-breadcrumb').innerHTML = `<span>${escapeHtml(current.name)} <span class="separator">/</span> <strong>本地版本管理</strong></span>`;
  }
}

async function loadRealProject(projectId) {
  if (!projectId) return false;
  const reqSerial = ++realActiveRequestSerial;
  currentProjectData = null;
  $('#page').innerHTML = `<div class="empty-workspace"><p>正在读取项目 Git 状态，请稍候...</p></div>`;

  const [sourceRes, historyRes] = await Promise.all([
    apiFetch(`/api/projects/${encodeURIComponent(projectId)}/source`),
    apiFetch(`/api/projects/${encodeURIComponent(projectId)}/history`),
  ]);

  if (reqSerial !== realActiveRequestSerial) return false; // 避免旧请求覆盖新切换项目

  if (!sourceRes.ok || !historyRes.ok) {
    const err = (!sourceRes.ok ? sourceRes.data?.error : historyRes.data?.error) || {};
    lastRealError = { source: 'project', projectId };
    renderRealError('读取项目 Git 状态失败', err.code, err.message, 'project');
    return false;
  }

  lastRealError = null;
  currentProjectData = {
    source: sourceRes.data,
    history: historyRes.data,
  };

  renderReal();
  return true;
}

function renderRealError(title, code, message, errorSource = 'project') {
  $('#page').innerHTML = `
    <div class="empty-workspace real-error-workspace">
      <h2 class="real-error-title">${escapeHtml(title)}</h2>
      <div class="error-box">
        <strong>错误代码：</strong><code>${escapeHtml(code || 'UNKNOWN_ERROR')}</code><br>
        <strong>说明：</strong>${escapeHtml(message || '无法获取项目信息，可能仓库已被移动或无权限访问。')}
      </div>
      <div class="real-error-actions">
        <button id="btn-retry-project" class="button primary" data-retry-source="${escapeHtml(errorSource)}">重试读取 ↻</button>
        <button id="btn-open-onboard-from-err" class="button">接入新项目</button>
      </div>
    </div>`;
}

function renderEmptyWorkspace() {
  $('#page').innerHTML = `
    <div class="empty-workspace">
      <h2>尚未接入任何本地 Git 项目</h2>
      <p>本工具采用只读工作台模式，支持直接查看已有本地 Git 仓库的工作区变更、分支及提交历史。接入过程只读识别，不会修改被管理仓库。</p>
      <button id="btn-empty-onboard" class="button primary empty-onboard-button">+ 接入已有本地项目</button>
    </div>`;
}

function renderReal() {
  $('#recover-material-operation').hidden = state.view === 'source';
  document.querySelectorAll('[data-view]').forEach((button) => {
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  if (state.view === 'source') {
    $('#demo-banner').className = 'demo-banner real-banner';
    $('#demo-banner').innerHTML = `<strong>真实本地工作台</strong><span>查看默认只读；选择文件、预览并确认后可本地提交。本批无推送、拉取或分支写操作。</span>`;
    $('#help-text').textContent = '只读工作台展示本地真实 Git 状态；未提交按变更文件统计，上游差异按领先/落后提交统计。';
    if (!currentProjectData) {
      if (currentProjectId) {
        $('#page').innerHTML = '<div class="empty-workspace"><p>正在读取项目 Git 状态，请稍候...</p></div>';
        void loadRealProject(currentProjectId);
      } else {
        renderEmptyWorkspace();
      }
      return;
    }
    $('#page').innerHTML = realSourcePage();
    const graphCanvas = $('#page .graph-canvas');
    if (graphCanvas) {
      graphCanvas.style.width = `${graphCanvas.getAttribute('width')}px`;
      graphCanvas.style.height = `${graphCanvas.getAttribute('height')}px`;
    }
  } else {
    const isInstaller = state.view === 'installer';
    const kindText = isInstaller ? '安装包' : '升级包';
    $('#demo-banner').className = 'demo-banner real-banner';
    $('#demo-banner').innerHTML = `<strong>真实本地工作台 · ${kindText}资料库</strong><span>默认只读扫描；确认后可校验单文件或复制归档，保留源文件、不覆盖、不执行安装。</span>`;
    $('#help-text').textContent = isInstaller
      ? '文件存在 ≠ 安装可用。历史验证记录仅供参考，本次未核验当前文件。'
      : '兼容性仅基于直接支持声明；各包独立计算最低来源，不是实测结论。';

    if (!currentProjectId) {
      renderEmptyWorkspace();
      return;
    }

    if (lastMaterialError && lastMaterialError.projectId === currentProjectId && lastMaterialError.kind === state.view) {
      if (lastMaterialError.source === 'material-root') {
        $('#page').innerHTML = `
          <div class="empty-workspace real-error-workspace">
            <h2 class="real-error-title">已关联${kindText}目录不可访问</h2>
            <div class="error-box">
              <strong>错误代码：</strong><code>${escapeHtml(lastMaterialError.code || 'MATERIAL_ROOT_UNAVAILABLE')}</code><br>
              <strong>说明：</strong>${escapeHtml(lastMaterialError.message || '已关联的材料根目录已被移动、删除或无权限访问。')}
            </div>
            <div class="real-error-actions">
              <button id="btn-relink-material" class="button primary">重新关联目录</button>
              <button id="btn-retry-material" class="button">重试读取 ↻</button>
            </div>
          </div>`;
      } else {
        $('#page').innerHTML = `
          <div class="empty-workspace real-error-workspace">
            <h2 class="real-error-title">读取${kindText}清单失败</h2>
            <div class="error-box">
              <strong>错误代码：</strong><code>${escapeHtml(lastMaterialError.code || 'MATERIAL_SCAN_FAILED')}</code><br>
              <strong>说明：</strong>${escapeHtml(lastMaterialError.message || '扫描材料目录发生异常。')}
            </div>
            <div class="real-error-actions">
              <button id="btn-retry-material" class="button primary">重试读取 ↻</button>
              <button id="btn-relink-material" class="button">更换关联目录</button>
            </div>
          </div>`;
      }
      return;
    }

    if (!currentMaterialData || currentMaterialData.projectId !== currentProjectId || currentMaterialData.kind !== state.view) {
      $('#page').innerHTML = `<div class="empty-workspace"><p>正在读取${kindText}清单，请稍候...</p></div>`;
      void loadRealMaterial(currentProjectId, state.view);
      return;
    }

    if (currentMaterialData.state === 'unlinked') {
      $('#page').innerHTML = `
        <div class="material-unlinked-box">
          <h2>尚未关联${kindText}目录</h2>
          <p>为当前项目关联本地已有的${kindText}存放目录，系统将以有界只读方式扫描包文件，呈现目录树形、识别声明并计算兼容性。</p>
          <button id="btn-open-material-dialog" class="button primary empty-onboard-button">+ 关联${kindText}目录</button>
        </div>`;
      return;
    }

    $('#page').innerHTML = realMaterialPage(state.view, currentMaterialData);
  }
}

// ==========================================
// 真实模式材料库状态与页面 (P2-T03)
// ==========================================
let realActiveMaterialSerial = 0;
let currentMaterialKind = null; // 'installer' | 'upgrade'
let currentMaterialData = null; // { projectId, kind, state, scan, tree, items }
let selectedMaterialItemId = null;
let lastMaterialError = null; // { source: 'material-load' | 'material-root', projectId, kind, code, message }
let materialWizardState = null; // { kind, step: 'input'|'review', inputPath: '', inspectResult: null, error: null, isBusy: false, serial: 0 }

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(msOrIso) {
  if (!msOrIso) return '未知时间';
  const d = new Date(msOrIso);
  if (isNaN(d.getTime())) return String(msOrIso);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${y}-${m}-${day} ${h}:${min}`;
}

function formatStatusText(item) {
  if (item.physical.status === 'changed') return '属性需复核';
  if (item.physical.status === 'disappeared') return '文件已消失';
  if (item.physical.status === 'permission_denied') return '无权限读取';
  if (item.declaration.state === 'record-conflict') return '记录冲突';
  if (item.declaration.state === 'record-invalid') return '记录损坏';
  if (item.declaration.state === 'reference-missing') return '引用缺失';
  if (item.declaration.state === 'unverified') return '未核验';
  if (item.declaration.state === 'no-record') return '待识别';
  if (item.declaration.state === 'available') return '已声明';
  return '未知状态';
}

function formatPhysicalObservation(physical) {
  if (physical.status === 'unverified' || physical.exists === null) return tag('未扫描，无法确认', 'amber');
  if (physical.status === 'permission_denied') return tag('无权限确认', 'amber');
  if (physical.status === 'disappeared') return tag('扫描中消失', 'amber');
  return physical.exists ? tag('文件存在') : tag('文件缺失', 'red');
}

function formatMinimumSupportBadge(compat) {
  if (!compat) return '<span class="minimum-support muted">→ 待确认</span>';
  if (compat.state === 'available' && compat.minimumDirectSource) {
    return `<span class="minimum-support" title="声明支持直接升级的最低来源版本">→ <strong>${escapeHtml(compat.minimumDirectSource)}</strong><small>最低支持</small></span>`;
  }
  if (compat.state === 'none') {
    return `<span class="minimum-support muted" title="未声明任何直接来源">→ 未声明直接来源</span>`;
  }
  if (compat.state === 'invalid') {
    return `<span class="minimum-support muted text-amber" title="直接来源版本声明非法或无法比较">→ 需核对</span>`;
  }
  return `<span class="minimum-support muted" title="升级范围待确认">→ 待确认</span>`;
}

function formatIntegrityResult(record) {
  if (!record || record.state === 'not-recorded' || !record.result) {
    return '<span class="muted">尚未核验 / 无记录</span>';
  }
  if (record.result === 'passed') {
    return `<strong>记录称通过，本次未核验当前文件</strong><small class="muted block-caption">${escapeHtml(record.method || '')} · ${escapeHtml(record.recordedAt || '')}</small>`;
  }
  if (record.result === 'failed') {
    return `<span class="text-red">记录称未通过</span><small class="muted block-caption">${escapeHtml(record.recordedAt || '')}</small>`;
  }
  return `<span class="muted">${escapeHtml(record.result)}</span>`;
}

function formatInstallationResult(record) {
  if (!record || record.state === 'not-recorded' || !record.result) {
    return '<span class="muted">尚未验证 / 无记录</span>';
  }
  if (record.result === 'passed') {
    return `<strong>记录称通过，本次未核验当前文件</strong><small class="muted block-caption">测试环境: ${escapeHtml(record.environment || '未知')} · ${escapeHtml(record.recordedAt || '')}</small>`;
  }
  if (record.result === 'failed') {
    return `<span class="text-red">记录称未通过</span><small class="muted block-caption">${escapeHtml(record.environment || '')}</small>`;
  }
  return `<span class="muted">${escapeHtml(record.result)}</span>`;
}

async function loadRealMaterial(projectId, kind) {
  closeMaterialOperation();
  if (!projectId) return false;
  const reqSerial = ++realActiveMaterialSerial;
  currentMaterialKind = kind;
  currentMaterialData = null;
  lastMaterialError = null;

  const kindText = kind === 'installer' ? '安装包' : '升级包';
  $('#page').innerHTML = `<div class="empty-workspace"><p>正在读取${kindText}清单，请稍候...</p></div>`;

  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(kind)}`);

  // 并发防护：如果已有更新的材料请求或项目/页面已切换，废弃旧响应
  if (reqSerial !== realActiveMaterialSerial || projectId !== currentProjectId || kind !== state.view) {
    return false;
  }

  if (!res.ok) {
    const err = res.data?.error || {};
    if (res.status === 409 && err.code === 'MATERIAL_ROOT_UNAVAILABLE') {
      lastMaterialError = {
        source: 'material-root',
        projectId,
        kind,
        code: err.code,
        message: err.message || '已关联的材料根目录已被移动、删除或无权限访问。',
      };
    } else {
      lastMaterialError = {
        source: 'material-load',
        projectId,
        kind,
        code: err.code,
        message: err.message || '获取材料清单失败。',
      };
    }
    renderReal();
    return false;
  }

  lastMaterialError = null;
  currentMaterialData = res.data;

  // 保持当前选中条目，或默认选第一项
  if (currentMaterialData.items && currentMaterialData.items.length > 0) {
    if (!selectedMaterialItemId || !currentMaterialData.items.some((it) => it.id === selectedMaterialItemId)) {
      selectedMaterialItemId = currentMaterialData.items[0].id;
    }
  } else {
    selectedMaterialItemId = null;
  }

  renderReal();
  return true;
}

function realMaterialPage(kind, data) {
  const isInstaller = kind === 'installer';
  const kindText = isInstaller ? '安装包' : '升级包';
  const totalFiles = data.items.filter((it) => it.physical.exists).length;
  const totalDirs = data.tree.filter((n) => n.type === 'directory').length;

  let bannerHtml = '';
  if (data.scan && (data.scan.status === 'partial' || data.scan.truncated)) {
    const reasonsStr = (data.scan.reasons || []).join(', ') || '未完整扫描';
    bannerHtml = `<div class="truncate-banner">⚠ <strong>部分扫描结果（已截断）：</strong>${escapeHtml(reasonsStr)}（已读取 ${data.scan.entriesScanned} 项）。未完全覆盖目录中的条目标记为未核验，未断言缺失。</div>`;
  }

  // 构建左侧树列表
  let treeContentHtml = '';
  if (data.items.length === 0) {
    const incomplete = data.scan && (data.scan.status === 'partial' || data.scan.truncated);
    treeContentHtml = `
      <p class="muted tree-empty-padding">${incomplete ? '扫描未完整，暂不能确认目录为空' : '目录已关联但暂无材料'}</p>
      ${data.tree
        .filter((n) => n.type === 'directory')
        .map(
          (d) =>
            `<details class="version-folder"><summary class="muted">📁 ${escapeHtml(d.relativePath)} <small>${incomplete ? '(未确认)' : '(空子目录)'}</small></summary><div class="tree-empty-sub">${incomplete ? '扫描未完整，尚不能确认该目录为空' : '该子目录中暂无材料文件'}</div></details>`
        )
        .join('')}
    `;
  } else {
    // 1. 按目标版本分组有版本的条目
    const versionGroups = new Map();
    const noVersionItems = [];

    data.items.forEach((item) => {
      const v = item.declaration.targetVersion;
      if (v) {
        if (!versionGroups.has(v)) versionGroups.set(v, []);
        versionGroups.get(v).push(item);
      } else {
        noVersionItems.push(item);
      }
    });

    const renderedGroups = [];
    for (const [ver, itemsList] of versionGroups.entries()) {
      renderedGroups.push(`
        <details class="version-folder" open>
          <summary><strong>${escapeHtml(ver)}</strong></summary>
          ${itemsList
            .map((item) => {
              const isSelected = item.id === selectedMaterialItemId;
              const revPrefix = item.declaration.revision ? `${escapeHtml(item.declaration.revision)} · ` : '';
              return `
                <button class="tree-item ${isSelected ? 'selected' : ''}" data-material-item="${escapeHtml(item.id)}" aria-pressed="${isSelected}">
                  <span class="file-symbol">${isInstaller ? '▣' : '⇧'}</span>
                  <span>
                    <strong>${revPrefix}${escapeHtml(item.relativePath)}</strong>
                    <small>${formatStatusText(item)} · ${formatBytes(item.physical.sizeBytes)}</small>
                  </span>
                  ${!isInstaller ? formatMinimumSupportBadge(item.compatibility) : ''}
                </button>`;
            })
            .join('')}
        </details>
      `);
    }

    if (noVersionItems.length > 0) {
      renderedGroups.push(`
        <details class="version-folder" open>
          <summary><strong>待识别材料</strong></summary>
          ${noVersionItems
            .map((item) => {
              const isSelected = item.id === selectedMaterialItemId;
              const revPrefix = item.declaration.revision ? `${escapeHtml(item.declaration.revision)} · ` : '';
              return `
                <button class="tree-item ${isSelected ? 'selected' : ''}" data-material-item="${escapeHtml(item.id)}" aria-pressed="${isSelected}">
                  <span class="file-symbol">${isInstaller ? '▣' : '⇧'}</span>
                  <span>
                    <strong>${revPrefix}${escapeHtml(item.relativePath)}</strong>
                    <small>${formatStatusText(item)} · ${formatBytes(item.physical.sizeBytes)}</small>
                  </span>
                  ${!isInstaller ? formatMinimumSupportBadge(item.compatibility) : ''}
                </button>`;
            })
            .join('')}
        </details>
      `);
    }

    // 查找没有任何文件属于它们的空子目录
    const emptyDirs = data.tree.filter((node) => {
      if (node.type !== 'directory') return false;
      const prefix = `${node.relativePath}/`;
      return !data.items.some((it) => it.relativePath.startsWith(prefix));
    });

    if (emptyDirs.length > 0) {
      emptyDirs.forEach((d) => {
        renderedGroups.push(`
          <details class="version-folder">
            <summary class="muted">📁 ${escapeHtml(d.relativePath)} <small>${data.scan && (data.scan.status === 'partial' || data.scan.truncated) ? '(未确认)' : '(空子目录)'}</small></summary>
            <div class="tree-empty-sub">${data.scan && (data.scan.status === 'partial' || data.scan.truncated) ? '扫描未完整，尚不能确认该目录为空' : '该子目录中暂无材料文件'}</div>
          </details>
        `);
      });
    }

    treeContentHtml = renderedGroups.join('');
  }

  // 构建右侧详情
  let detailContentHtml = '';
  if (data.items.length === 0) {
    const incomplete = data.scan && (data.scan.status === 'partial' || data.scan.truncated);
    detailContentHtml = `
      <div class="empty">
        <div class="empty-symbol">□</div>
        <h3>${incomplete ? '扫描未完整，材料状态待确认' : '目录已关联但暂无材料'}</h3>
        <p>${incomplete ? '当前结果未覆盖全部目录，不能据此判断材料是否存在。' : '已成功扫描关联目录，未发现材料文件。'}</p>
        <p class="caption">目录存在不代表已制作或已发布材料。</p>
      </div>
      <div class="actions">
        <button id="btn-relink-material-empty" class="button">更换关联目录</button>
        <button id="btn-retry-material-empty" class="button">重新扫描 ↻</button>
      </div>
    `;
  } else {
    const selectedItem = data.items.find((it) => it.id === selectedMaterialItemId) || data.items[0];
    detailContentHtml = isInstaller ? realInstallerDetail(selectedItem) : realUpgradeDetail(selectedItem);
  }

  return `
    ${heading(
      isInstaller ? '安装包资料库' : '升级包资料库',
      isInstaller ? '找到材料，也看懂它是否已经准备好（真实只读数据）。' : '明确升级起点，让每一次更新有据可循（真实只读数据）。'
    )}
    ${bannerHtml}
    <div class="archive-layout">
      <section class="panel tree-panel">
        <div class="material-tree-header">
          <h2>${kindText}目录</h2>
          <button id="btn-relink-material-top" class="text-button" title="更换已关联的材料目录">更换关联 ⚙</button>
        </div>
        <p>${totalFiles} 份材料 · ${totalDirs} 个目录</p>
        ${!isInstaller ? '<p class="tree-hint">目标版本 → 最低支持的直接来源版本</p>' : ''}
        <div class="tree-root">${treeContentHtml}</div>
      </section>
      <section class="panel" aria-label="材料详情">
        ${detailContentHtml}
      </section>
    </div>
  `;
}

function formatReleaseStatus(status) {
  if (status === 'candidate') return '<span class="tag gray">候选包 (candidate)</span>';
  if (status === 'released') return '<span class="tag blue">已发布 (released)</span>';
  return '<span class="muted">状态未声明</span>';
}

function realInstallerDetail(item) {
  let noticeHtml = '';
  if (item.physical.status === 'changed') {
    noticeHtml = '<div class="state-notice bad">⚠ 属性与记录不一致，当前文件需复核。当前文件的物理大小或修改时间与登记值不同，不代表本次已校验通过。</div>';
  } else if (item.declaration.state === 'record-conflict') {
    noticeHtml = '<div class="state-notice bad">⚠ 记录冲突：记录中存在多份指向该文件的冲突声明，已保留物理文件。</div>';
  } else if (item.declaration.state === 'record-invalid') {
    noticeHtml = '<div class="state-notice bad">⚠ 记录损坏：记录中的声明字段格式非法或损坏。</div>';
  } else if (item.declaration.state === 'reference-missing') {
    noticeHtml = '<div class="state-notice bad">⚠ 引用缺失：记录声明了该文件，但在物理目录中未找到实际文件。</div>';
  } else if (item.declaration.state === 'unverified') {
    noticeHtml = '<div class="state-notice">ℹ 未完整扫描核验：所在目录超出扫描上限被截断，未核验其物理状态。</div>';
  } else if (item.declaration.state === 'no-record') {
    noticeHtml = '<div class="state-notice">ℹ 待识别：物理文件存在，但无记录声明。不推测版本、平台、源码或验证结论。</div>';
  }

  const decl = item.declaration;
  const declBadge =
    item.physical.status === 'changed'
      ? tag('属性需复核', 'amber')
      : decl.state === 'available'
      ? tag('已声明', '')
      : decl.state === 'no-record'
      ? tag('待识别', 'gray')
      : decl.state === 'record-conflict'
      ? tag('记录冲突', 'red')
      : decl.state === 'record-invalid'
      ? tag('记录损坏', 'red')
      : decl.state === 'reference-missing'
      ? tag('引用缺失', 'red')
      : tag('未核验', 'amber');

  const evidenceText = decl.evidenceSource ? ` · 证据来源: <code>${escapeHtml(decl.evidenceSource)}</code>` : '';
  const sourceOriginText = decl.sourceOrigin ? `${escapeHtml(decl.sourceOrigin)} (第 ${decl.recordIndex + 1} 条记录)${evidenceText}` : '无有效记录声明';

  const verTitle = decl.targetVersion ? escapeHtml(decl.targetVersion) : '未声明版本';
  const revTitle = decl.revision ? ` · ${escapeHtml(decl.revision)}` : '';

  const recordedShaRow = decl.recordedFile?.sha256
    ? `<div><dt>历史登记摘要 (SHA-256)</dt><dd><code>${escapeHtml(decl.recordedFile.sha256)}</code><small class="muted block-caption">历史登记摘要，本次未核验当前文件</small></dd></div>`
    : '';

  return `
    <div class="detail-title">
      <div>
        <h2>${verTitle}${revTitle} 安装包</h2>
        <p>相对路径: <code>${escapeHtml(item.relativePath)}</code> · 声明来源: ${sourceOriginText}</p>
      </div>
      ${declBadge}
    </div>
    ${noticeHtml}
    <dl class="metadata">
      <div><dt>发布状态 (记录声明)</dt><dd>${formatReleaseStatus(decl.releaseStatus)}</dd></div>
      <div><dt>适用系统</dt><dd>${escapeHtml(decl.platform || '未声明')}</dd></div>
      <div><dt>物理修改时间</dt><dd>${formatTimestamp(item.physical.mtimeMs)}</dd></div>
      <div><dt>源码关联 (记录声明)</dt><dd>${escapeHtml(decl.sourceCommit || '未声明')}</dd></div>
      <div><dt>物理文件大小</dt><dd>${formatBytes(item.physical.sizeBytes)}</dd></div>
      ${recordedShaRow}
    </dl>
    <h3>事实分层检查</h3>
    <ul class="checklist">
      <li>
        <span>01 本次物理文件 (只读探测)</span>
        <span>${formatPhysicalObservation(item.physical)} ${item.physical.status === 'changed' ? tag('属性需复核', 'amber') : ''}</span>
      </li>
      <li>
        <span>02 完整性记录 (历史登记)</span>
        <span>${formatIntegrityResult(item.integrityRecord)}</span>
      </li>
      <li>
        <span>03 安装验证记录 (历史登记)</span>
        <span>${formatInstallationResult(item.installationRecord)}</span>
      </li>
    </ul>
    <p class="caption"><strong>说明：</strong>历史记录称通过，本次未核验当前文件。目录扫描仅探测属性；单文件摘要校验与非覆盖归档需另行确认，不运行安装或升级。</p>
    ${materialOperationControls(item)}
    <div class="actions">
      <button id="btn-relink-from-detail" class="button">更换关联目录</button>
      <button id="btn-refresh-from-detail" class="button">重新扫描 ↻</button>
    </div>
  `;
}

function realUpgradeDetail(item) {
  let noticeHtml = '';
  if (item.physical.status === 'changed') {
    noticeHtml = '<div class="state-notice bad">⚠ 属性与记录不一致，当前文件需复核。当前文件的物理大小或修改时间与登记值不同。</div>';
  } else if (item.declaration.state === 'record-conflict') {
    noticeHtml = '<div class="state-notice bad">⚠ 记录冲突：记录中存在多份指向该文件的冲突声明。</div>';
  } else if (item.declaration.state === 'record-invalid') {
    noticeHtml = '<div class="state-notice bad">⚠ 记录损坏：记录中的声明字段格式非法或损坏。</div>';
  } else if (item.declaration.state === 'reference-missing') {
    noticeHtml = '<div class="state-notice bad">⚠ 引用缺失：记录声明了该文件，但在物理目录中未找到实际文件。</div>';
  } else if (item.declaration.state === 'no-record') {
    noticeHtml = '<div class="state-notice">ℹ 待识别：物理文件存在，但无记录声明。</div>';
  }

  const decl = item.declaration;
  const compat = item.compatibility;
  const declBadge =
    item.physical.status === 'changed'
      ? tag('属性需复核', 'amber')
      : decl.state === 'available'
      ? tag('已声明', '')
      : decl.state === 'no-record'
      ? tag('待识别', 'gray')
      : tag('异常状态', 'red');

  let compatSectionHtml = '';
  if (compat.state === 'available' && Array.isArray(compat.directFrom) && compat.directFrom.length > 0) {
    compatSectionHtml = `
      <div class="compat-stat">
        <strong>${compat.directFrom.length}</strong> 个来源版本声明支持直接升级
        <p>其中声明的最低支持来源版本为 <strong>${escapeHtml(compat.minimumDirectSource || '无')}</strong></p>
      </div>
      <h3>支持直接升级的来源版本</h3>
      <table class="compatibility">
        <thead><tr><th>来源版本</th><th>升级方式</th><th>说明</th></tr></thead>
        <tbody>
          ${compat.directFrom
            .map(
              (v) => `
            <tr>
              <td><strong>${escapeHtml(v)}</strong></td>
              <td>支持直接升级</td>
              <td>${v === compat.minimumDirectSource ? tag('声明的最低来源', '') : '<span class="muted">直接升级</span>'}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <p class="caption">兼容声明基于登记信息，不是实测结论；中间升级路径未声明，未列出的版本均为未知。</p>
    `;
  } else if (compat.state === 'none') {
    compatSectionHtml = `
      <div class="compat-stat">
        <strong>未声明直接来源</strong>
        <p>该包声明 directFrom: []，即没有声明任何支持直接升级的来源版本（通常仅适用于全新部署）。</p>
      </div>
    `;
  } else if (compat.state === 'invalid') {
    compatSectionHtml = `
      <div class="compat-stat">
        <h3 class="text-amber">需核对：版本声明无法比较</h3>
        <p>声明中的来源版本语法非法、不可比较或不早于目标版本，整份兼容声明无法计算最低直接来源版本。</p>
      </div>
    `;
  } else {
    compatSectionHtml = `
      <div class="compat-stat">
        <h3>待确认：未声明直接升级来源</h3>
        <p>未在记录中找到 directFrom 字段或声明为空，直接升级兼容范围未知。</p>
      </div>
    `;
  }

  const evidenceText = decl.evidenceSource ? ` · 证据来源: <code>${escapeHtml(decl.evidenceSource)}</code>` : '';
  const sourceOriginText = decl.sourceOrigin ? `${escapeHtml(decl.sourceOrigin)} (第 ${decl.recordIndex + 1} 条记录)${evidenceText}` : '无有效记录声明';

  const verTitle = decl.targetVersion ? escapeHtml(decl.targetVersion) : '未声明版本';
  const revTitle = decl.revision ? ` · ${escapeHtml(decl.revision)}` : '';

  const recordedShaRow = decl.recordedFile?.sha256
    ? `<div><dt>历史登记摘要 (SHA-256)</dt><dd><code>${escapeHtml(decl.recordedFile.sha256)}</code><small class="muted block-caption">历史登记摘要，本次未核验当前文件</small></dd></div>`
    : '';

  return `
    <div class="detail-title">
      <div>
        <h2>${verTitle}${revTitle} 增量升级包</h2>
        <p>相对路径: <code>${escapeHtml(item.relativePath)}</code> · 声明来源: ${sourceOriginText}</p>
      </div>
      ${declBadge}
    </div>
    ${noticeHtml}
    <dl class="metadata">
      <div><dt>发布状态 (记录声明)</dt><dd>${formatReleaseStatus(decl.releaseStatus)}</dd></div>
      <div><dt>升级目标版本</dt><dd>${escapeHtml(decl.targetVersion || '未声明')}</dd></div>
      <div><dt>物理修改时间</dt><dd>${formatTimestamp(item.physical.mtimeMs)}</dd></div>
      <div><dt>物理文件大小</dt><dd>${formatBytes(item.physical.sizeBytes)}</dd></div>
      <div><dt>最低支持来源</dt><dd>${escapeHtml(compat.minimumDirectSource || '待确认/无')}</dd></div>
      ${recordedShaRow}
    </dl>
    ${compatSectionHtml}
    <h3>事实分层检查</h3>
    <ul class="checklist">
      <li>
        <span>01 本次物理文件 (只读探测)</span>
        <span>${formatPhysicalObservation(item.physical)}</span>
      </li>
      <li>
        <span>02 完整性记录 (历史登记)</span>
        <span>${formatIntegrityResult(item.integrityRecord)}</span>
      </li>
      <li>
        <span>03 升级验证记录 (历史登记)</span>
        <span>${formatInstallationResult(item.installationRecord)}</span>
      </li>
    </ul>
    <p class="caption"><strong>说明：</strong>历史记录称通过，本次未核验当前文件。目录扫描仅探测属性；单文件摘要校验与非覆盖归档需另行确认，不运行安装或升级。</p>
    ${materialOperationControls(item)}
    <div class="actions">
      <button id="btn-relink-from-detail" class="button">更换关联目录</button>
      <button id="btn-refresh-from-detail" class="button">重新扫描 ↻</button>
    </div>
  `;
}

function openMaterialDialog(kind) {
  closeMaterialOperation();
  if (!currentProjectId) {
    notify('请先接入或选择项目！');
    return;
  }
  const dialog = $('#material-dialog');
  if (!dialog) return;

  const kindText = kind === 'installer' ? '安装包' : '升级包';
  $('#material-dialog-title').textContent = `关联${kindText}目录`;

  materialWizardState = {
    kind,
    step: 'input',
    inputPath: '',
    inspectResult: null,
    error: null,
    isBusy: false,
    serial: ++onboardSerial,
  };

  renderMaterialDialog();
  if (!dialog.open) dialog.showModal();
}

function renderMaterialDialog() {
  const body = $('#material-dialog-body');
  if (!body || !materialWizardState) return;
  const wiz = materialWizardState;
  const kindText = wiz.kind === 'installer' ? '安装包' : '升级包';
  $('#close-material-dialog').disabled = wiz.isBusy && wiz.step === 'review';

  if (wiz.step === 'input') {
    body.innerHTML = `
      <div class="onboard-help-text">
        请输入当前项目在本地计算机上的真实${kindText}绝对根目录。系统将对该目录执行只读检查与扫描，<strong>绝不修改、执行、移动或写入材料目录</strong>。仅在您确认后保存关联至本工具配置。
      </div>
      <form id="material-inspect-form">
        <div class="form-group">
          <label for="material-root-input">${kindText}绝对根目录路径</label>
          <input type="text" id="material-root-input" placeholder="例如 D:\\materials\\${wiz.kind} 或 /data/materials/${wiz.kind}" value="${escapeHtml(wiz.inputPath || '')}" required autocomplete="off" />
        </div>
        ${wiz.error ? `<div class="error-box">${escapeHtml(wiz.error)}</div>` : ''}
        <div class="onboard-actions">
          <button type="button" id="btn-cancel-material-inspect" class="button">取消</button>
          <button type="submit" id="btn-submit-material-inspect" class="button primary" ${wiz.isBusy ? 'disabled' : ''}>${wiz.isBusy ? '正在检查...' : '开始只读检查 →'}</button>
        </div>
      </form>
    `;

    $('#material-inspect-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#material-root-input')?.value.trim();
      if (!input) return;
      wiz.inputPath = input;
      wiz.isBusy = true;
      wiz.error = null;
      renderMaterialDialog();

      const requestProjectId = currentProjectId;
      const res = await apiFetch(`/api/projects/${encodeURIComponent(requestProjectId)}/materials/${encodeURIComponent(wiz.kind)}/inspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Local-Intent': 'material-linking',
        },
        body: JSON.stringify({ rootPath: input }),
      });

      if (materialWizardState !== wiz || currentProjectId !== requestProjectId || state.view !== wiz.kind) return;

      if (!res.ok) {
        wiz.isBusy = false;
        wiz.error = `${res.data?.error?.message || '检查材料目录失败'} (代码: ${res.data?.error?.code || 'INVALID_INPUT'})`;
        renderMaterialDialog();
        return;
      }

      wiz.isBusy = false;
      wiz.inspectResult = res.data;
      wiz.step = 'review';
      renderMaterialDialog();
    });
  } else if (wiz.step === 'review') {
    const res = wiz.inspectResult;
    const preview = res.preview || { summary: {}, truncated: false, reasons: [] };
    const summ = preview.summary || {};

    let noticeHtml = '';
    if (res.hasExistingAssociation) {
      noticeHtml = `
        <div class="onboard-notice">
          <strong>注意：更换已有关联目录</strong><br>
          当前项目已关联旧目录：<code>${escapeHtml(res.existingRoot || '')}</code>。确认后将替换原有关联。
        </div>
      `;
    }

    let previewHtml = `
      <div class="inspect-summary-box">
        <div class="inspect-root-highlight">
          <strong>规范化真实根路径 (仅读取此物理目录)</strong>
          <code>${escapeHtml(res.normalizedRoot)}</code>
        </div>
        <dl class="inspect-grid">
          <div><dt>用户输入路径</dt><dd><code>${escapeHtml(res.inputPath)}</code></dd></div>
          <div><dt>路径类型</dt><dd>${res.isSymlink ? '符号链接/挂载点 (已解析真实物理路径)' : '标准物理路径'}</dd></div>
          <div><dt>扫描状态</dt><dd>${preview.status === 'complete' ? tag('完整扫描') : tag('部分扫描 (截断)', 'amber')}</dd></div>
          <div><dt>已发现文件</dt><dd>${summ.totalFiles || 0} 个文件 · ${summ.totalDirectories || 0} 个目录</dd></div>
          <div><dt>已识别记录</dt><dd>${summ.recognizedRecords || 0} 份声明 · ${summ.unrecognizedFiles || 0} 份待识别</dd></div>
          <div><dt>缺失引用</dt><dd>${summ.missingReferences ? tag(`${summ.missingReferences} 项缺失`, 'red') : '无'}</dd></div>
        </dl>
      </div>
    `;

    if (preview.truncated) {
      previewHtml += `<div class="truncate-banner">⚠ <strong>扫描截断提示：</strong>${escapeHtml((preview.reasons || []).join(', '))}</div>`;
    }

    body.innerHTML = `
      <div class="onboard-help-text">
        目录检查通过！请核对以下只读扫描结果。确认后<strong>仅将关联写入本工具的本地项目配置</strong>，材料目录保持只读。
      </div>
      ${noticeHtml}
      ${previewHtml}
      ${wiz.error ? `<div class="error-box">${escapeHtml(wiz.error)}</div>` : ''}
      <div class="onboard-actions">
        <button type="button" id="btn-cancel-material-confirm" class="button" ${wiz.isBusy ? 'disabled' : ''}>取消</button>
        <button type="button" id="btn-submit-material-confirm" class="button primary" ${wiz.isBusy ? 'disabled' : ''}>${wiz.isBusy ? '正在保存...' : '确认关联并保存配置'}</button>
      </div>
    `;

    $('#btn-submit-material-confirm')?.addEventListener('click', async () => {
      wiz.isBusy = true;
      wiz.error = null;
      renderMaterialDialog();

      const requestProjectId = currentProjectId;
      const resConfirm = await apiFetch(`/api/projects/${encodeURIComponent(requestProjectId)}/materials/${encodeURIComponent(wiz.kind)}/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Local-Intent': 'material-linking',
        },
        body: JSON.stringify({
          inspectionId: res.inspectionId,
          replaceExisting: Boolean(res.hasExistingAssociation),
        }),
      });

      if (materialWizardState !== wiz || currentProjectId !== requestProjectId || state.view !== wiz.kind) return;

      if (!resConfirm.ok) {
        wiz.isBusy = false;
        const err = resConfirm.data?.error || {};
        if (err.code === 'INSPECTION_STALE') {
          wiz.error = '检查票据已过期或目录身份已改变，请重新检查。';
        } else if (err.code === 'MATERIAL_CONFLICT') {
          wiz.error = '关联配置在检查后已被其他进程更改，请重新检查并确认。';
        } else if (err.code === 'CONFIG_BUSY') {
          wiz.error = '配置文件正忙，请稍候重试。';
        } else {
          wiz.error = `${err.message || '确认关联失败'} (代码: ${err.code || 'ERROR'})`;
        }
        renderMaterialDialog();
        return;
      }

      $('#material-dialog').close();
      materialWizardState = null;
      notify(resConfirm.data.alreadyAssociated ? `该${kindText}目录此前已关联。` : `成功关联${kindText}目录！`);

      await loadRealMaterial(requestProjectId, wiz.kind);
    });
  }
}

// P4 single-file operations: explicit preview, durable identity, read-only recovery.
let materialOperationView = null;
let materialOperationSerial = 0;
const materialOperationKey = (projectId, kind) => `lvm_material_operation_v1:${projectId}:${kind}`;
function savedMaterialOperation(projectId, kind) {
  try { const id = localStorage.getItem(materialOperationKey(projectId, kind)); return /^[a-zA-Z0-9_-]{1,64}$/.test(id || '') && !['preview', 'confirm'].includes(id) ? id : null; } catch { return null; }
}
function materialOperationCurrent(view) {
  return isRealMode && materialOperationView === view && view.serial === materialOperationSerial && view.projectId === currentProjectId && view.kind === state.view && view.associationSerial === realActiveMaterialSerial;
}
function closeMaterialOperation() {
  ++materialOperationSerial;
  materialOperationView = null;
  $('#material-operation-dialog')?.close();
}
function materialOperationControls(item) {
  return `<div class="actions"><button class="button" data-material-operation="integrity" ${!item.physical.exists ? 'disabled' : ''}>校验单文件完整性</button><button class="button" data-material-operation="archive" ${!item.physical.exists ? 'disabled' : ''}>预览非覆盖归档</button></div><p class="caption">操作需单独预览并确认；保留源文件，不覆盖已有目标。不运行安装或升级。</p>`;
}
async function materialOperationRequest(view, action, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65000);
  try {
    return await apiFetch(`/api/projects/${encodeURIComponent(view.projectId)}/materials/${encodeURIComponent(view.kind)}/operations/${action}`, {
      signal: controller.signal,
      ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Intent': 'material-operations' }, body: JSON.stringify(body) } : {}),
    });
  } finally { clearTimeout(timer); }
}
function materialOperationResultHtml(result) {
  const status = { running: '正在处理', completed: '本次流程已结束', partial: '部分完成，需核对归档事实', unknown: '结果未知，请查询原操作', not_started: '查询时尚无持久记录；先前确认仍可能稍后开始，请继续查询原操作' };
  const integrity = { matched: '上次校验与明确采用的基准一致', mismatched: '摘要不匹配：与基准不同', no_baseline: '无可信基准：仅计算摘要，未验证真伪', changed: '文件或关联已变化，未验证通过', unreadable: '文件不可读，未验证通过', cancelled: '校验已取消，未验证通过', timeout: '校验超时，未验证通过', limit_exceeded: '文件超过上限，未验证通过' };
  const archive = { published: '已发布归档副本；源文件保留', duplicate: '已有相同内容，未覆盖目标', conflict: '目标内容冲突，未覆盖目标', not_published: '未发布归档副本', unavailable: '目标不可用', unknown: '归档影响未知，可能已发布，请核对目标' };
  // Defense in depth: never infer a match from a lone digest or completion status.
  const trustedMatch = result.integrity === 'matched' && /^[a-f0-9]{64}$/i.test(result.baseline?.sha256 || '') && result.sha256?.toLowerCase() === result.baseline.sha256.toLowerCase();
  const integrityText = result.integrity === 'matched' && !trustedMatch ? '校验依据不足，结果未知' : integrity[result.integrity] || '完整性结果待核对';
  return `<div class="state-notice" role="status">${escapeHtml(status[result.status] || '结果未知，请查询原操作')}</div>
    ${result.relativePath ? `<p>文件：<code>${escapeHtml(result.relativePath)}</code></p>` : ''}
    <p>${escapeHtml(integrityText)}</p>${result.sha256 ? `<p class="operation-digest">计算摘要：<code>${escapeHtml(result.sha256)}</code></p>` : ''}
    ${result.baseline ? `<p>采用基准：<code>${escapeHtml(result.baseline.sha256)}</code><br>来源：${escapeHtml(result.baseline.source)}</p>` : ''}
    ${result.archive ? `<p>${escapeHtml(archive[result.archive.state] || archive.unknown)}</p>${result.archive.stagingRetained ? '<p>暂存内容可能保留；不会自动清理。</p>' : ''}` : ''}
    <p>上次校验时间：${result.checkedAt ? escapeHtml(formatTimestamp(result.checkedAt)) : '尚无可核实时间'}。查询不会重新计算摘要，历史结果不证明当前文件未改变。</p>
    ${result.associationCurrent === false ? '<p class="error">材料关联已改变，此结果属于原关联。</p>' : ''}
    <p class="caption">安装/升级验证与完整性独立：本次没有运行安装或升级，不更改历史记录或兼容声明。</p>`;
}
function renderMaterialOperation() {
  const view = materialOperationView;
  if (!view || !materialOperationCurrent(view)) return;
  let html = `<p>项目：${escapeHtml(view.projectId)} · ${view.kind === 'installer' ? '安装包' : '升级包'}</p>`;
  if (view.phase === 'input') {
    html += `<p>单文件：<code>${escapeHtml(view.relativePath)}</code></p><label class="field">可信基准<select id="operation-baseline" ${view.busy ? 'disabled' : ''}><option value="none">无基准（默认）：仅计算摘要</option>${view.declared ? '<option value="declared">明确采用历史登记摘要</option>' : ''}<option value="manual">手动输入可信 SHA-256 与来源</option></select></label>
      ${view.declared ? `<p class="caption">可采用的历史摘要：<code>${escapeHtml(view.declared.sha256)}</code><br>来源：${escapeHtml(view.declared.source)}。只有主动选择才会采用。</p>` : ''}
      <label class="field">手动 SHA-256<input id="operation-sha" maxlength="64" autocomplete="off" ${view.busy ? 'disabled' : ''}></label><label class="field">手动基准来源<input id="operation-source" maxlength="512" autocomplete="off" ${view.busy ? 'disabled' : ''}></label>
      ${view.action === 'archive' ? '<label class="field">本机已存在的归档目录（绝对路径）<input id="operation-target" maxlength="4096" autocomplete="off"></label><p>复制到所选目录，文件名保持源文件名；保留源文件，不删除、不覆盖。</p>' : ''}
      <button id="preview-material-operation" class="button primary" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在核对预览…' : '预览操作'}</button>`;
  } else if (view.phase === 'review') {
    const p = view.preview;
    html += `<h3>${view.action === 'archive' ? '确认非覆盖归档' : '确认完整性校验'}</h3><p>源文件（已关联材料目录内）：<code>${escapeHtml(p.relativePath)}</code> · ${formatBytes(p.bytes)}</p>
      <p>${p.baseline ? `明确采用基准：<code>${escapeHtml(p.baseline.sha256)}</code><br>来源：${escapeHtml(p.baseline.source)}` : '无可信基准：仅计算摘要，不会显示已验证通过。'}</p>
      ${view.action === 'archive' ? `<p>目标目录：<code>${escapeHtml(view.targetRoot)}</code><br>目标文件名：<code>${escapeHtml(p.basename)}</code></p><p>保留源文件。相同内容视为重复，不同内容视为冲突；一律不覆盖。${p.targetExists ? '预览时目标已存在。' : '预览时目标不存在。'}</p>` : ''}
      <p class="caption">单文件上限 1 GiB，运行预算 60 秒。预览后源文件、关联或目标改变需重新预览。</p><button id="confirm-material-operation" class="button primary" ${view.busy ? 'disabled' : ''}>确认${view.action === 'archive' ? '复制归档' : '校验'}</button><button id="back-material-operation" class="button">返回修改（废弃预览）</button>`;
  } else {
    html += materialOperationResultHtml(view.result || { status: 'unknown' });
    html += `<p class="caption">操作 ID：<code>${escapeHtml(view.operationId)}</code></p><button id="query-material-operation" class="button" ${view.querying ? 'disabled' : ''}>${view.querying ? '正在查询…' : '查询原操作结果'}</button>
      <button id="cancel-material-operation" class="button" ${view.cancelling || view.result?.status === 'completed' ? 'disabled' : ''}>请求取消原操作</button>
      <p class="caption">取消为协作式请求，可能已经发布归档；以查询事实为准。关闭窗口不会取消操作。只支持进程退出后的结果核对，不保证断电恢复。</p>`;
  }
  if (view.notice) html += `<p role="status">${escapeHtml(view.notice)}</p>`;
  if (view.error) html += `<p class="error" role="alert">${escapeHtml(view.error)}</p>`;
  html += `<div class="actions"><button id="close-material-operation" class="button">${view.operationId ? '关闭（保留原操作查询）' : '取消，不执行'}</button></div>`;
  $('#material-operation-body').innerHTML = html;
}
function openMaterialOperation(action, recover = false) {
  if (!isRealMode || !currentProjectId || !['installer', 'upgrade'].includes(state.view)) return;
  const saved = savedMaterialOperation(currentProjectId, state.view);
  if (recover && !saved) { notify('当前项目和材料种类没有保存的操作 ID。'); return; }
  const item = currentMaterialData?.items?.find(it => it.id === selectedMaterialItemId) || currentMaterialData?.items?.[0];
  if (!recover && (!item?.physical.exists || currentMaterialData.projectId !== currentProjectId || currentMaterialData.kind !== state.view)) return;
  closeMaterialOperation();
  const d = item?.declaration;
  const declared = /^[a-f0-9]{64}$/i.test(d?.recordedFile?.sha256 || '') && d.state === 'available' ? { sha256: d.recordedFile.sha256, source: `历史登记 ${d.sourceOrigin || '材料记录'} 第 ${(d.recordIndex || 0) + 1} 条${d.evidenceSource ? ` · ${d.evidenceSource}` : ''}`.slice(0, 512) } : null;
  materialOperationView = { projectId: currentProjectId, kind: state.view, associationSerial: realActiveMaterialSerial, serial: ++materialOperationSerial, phase: recover ? 'result' : 'input', action, relativePath: item?.relativePath, declared, operationId: recover ? saved : null, saved };
  renderMaterialOperation();
  $('#material-operation-dialog').showModal();
  if (recover) void queryMaterialOperation(materialOperationView);
}
async function previewMaterialOperation() {
  const view = materialOperationView;
  if (!view || !materialOperationCurrent(view) || view.phase !== 'input' || view.busy) return;
  const choice = $('#operation-baseline').value;
  const baseline = choice === 'declared' ? view.declared : choice === 'manual' ? { sha256: $('#operation-sha').value.trim(), source: $('#operation-source').value.trim() } : null;
  if (choice !== 'none' && (!baseline || !/^[a-f0-9]{64}$/i.test(baseline.sha256) || !baseline.source || /[\x00-\x1f\x7f]/.test(baseline.source))) { view.error = '请输入 64 位 SHA-256 和非空来源说明。'; renderMaterialOperation(); return; }
  view.targetRoot = view.action === 'archive' ? $('#operation-target').value.trim() : undefined;
  if (view.action === 'archive' && !view.targetRoot) { view.error = '请输入本机已存在的归档目录。'; renderMaterialOperation(); return; }
  view.busy = true; view.error = null; renderMaterialOperation();
  const response = await materialOperationRequest(view, 'preview', { action: view.action, relativePath: view.relativePath, ...(baseline ? { baseline } : {}), ...(view.targetRoot ? { targetRoot: view.targetRoot } : {}) });
  if (!materialOperationCurrent(view)) return;
  view.busy = false;
  const p = response.data;
  if (!response.ok || p?.projectId !== view.projectId || p?.kind !== view.kind || p?.action !== view.action || p?.relativePath !== view.relativePath || !p?.ticketId) view.error = '无法取得安全预览，请核对文件、基准和目录后重试。';
  else { view.preview = p; view.phase = 'review'; }
  renderMaterialOperation();
}
async function queryMaterialOperation(view = materialOperationView) {
  if (!view || !materialOperationCurrent(view) || !view.operationId || view.querying) return;
  view.querying = true; view.error = null; renderMaterialOperation();
  const response = await materialOperationRequest(view, encodeURIComponent(view.operationId));
  if (!materialOperationCurrent(view)) return;
  view.querying = false;
  const r = response.data;
  if (r?.projectId === view.projectId && r?.kind === view.kind && r?.operationId === view.operationId && ['running', 'completed', 'partial', 'unknown', 'not_started'].includes(r.status)) view.result = r;
  else { view.result = { status: 'unknown' }; view.error = '无法核对结果。请恢复本机连接后查询同一操作 ID；不要重新发起复制。'; }
  renderMaterialOperation();
}
async function confirmMaterialOperation() {
  const view = materialOperationView;
  if (!view || !materialOperationCurrent(view) || view.phase !== 'review' || view.busy || view.operationId) return;
  // Never overwrite a pending identity: resolve the previous operation before starting another.
  if (view.saved) {
    view.busy = true;
    const old = await materialOperationRequest(view, encodeURIComponent(view.saved));
    if (!materialOperationCurrent(view)) return;
    view.busy = false;
    if (old.data?.projectId !== view.projectId || old.data?.kind !== view.kind || old.data?.operationId !== view.saved || old.data?.status !== 'completed') {
      view.operationId = view.saved; view.phase = 'result'; view.notice = '仍有原操作需核对，未发起新操作。'; await queryMaterialOperation(view); return;
    }
  }
  const operationId = window.crypto.randomUUID();
  try { localStorage.setItem(materialOperationKey(view.projectId, view.kind), operationId); if (savedMaterialOperation(view.projectId, view.kind) !== operationId) throw new Error(); }
  catch { view.error = '无法保存恢复用操作 ID，已阻止执行。请允许本站本地存储。'; renderMaterialOperation(); return; }
  view.operationId = operationId; view.phase = 'result'; view.result = { status: 'running' }; view.busy = true; renderMaterialOperation();
  const ticketId = view.preview.ticketId; view.preview = null;
  await materialOperationRequest(view, 'confirm', { ticketId, operationId });
  if (!materialOperationCurrent(view)) return;
  view.busy = false;
  await queryMaterialOperation(view);
}
async function cancelMaterialOperation() {
  const view = materialOperationView;
  if (!view || !materialOperationCurrent(view) || !view.operationId || view.cancelling) return;
  view.cancelling = true; view.notice = '正在请求取消；可能已经发布，必须核对最终事实。'; renderMaterialOperation();
  const response = await materialOperationRequest(view, `${encodeURIComponent(view.operationId)}/cancel`, {});
  if (!materialOperationCurrent(view)) return;
  view.cancelling = false;
  view.notice = response.data?.cancellation?.requested ? '已请求协作式取消，不保证立即停止；归档可能已发布。' : '取消请求未能确认，请查询原操作。';
  await queryMaterialOperation(view);
}
$('#material-operation-dialog')?.addEventListener('cancel', closeMaterialOperation);
window.addEventListener('popstate', closeMaterialOperation);
window.addEventListener('pagehide', closeMaterialOperation);
// End P4 single-file operations.

// Selected-files local commit. Tickets live only in this view; operation IDs survive navigation.
let commitView = null;
let commitSerial = 0;
const commitOperationKey = (projectId) => `lvm_commit_operation_v1:${projectId}`;
const commitKinds = { add: '新增', modify: '修改', delete: '删除', rename: '重命名', typechange: '类型变化' };
const commitScopes = { staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪（新增）', both: '已暂存 + 未暂存' };
const commitReasons = {
  IDENTITY_MISSING: '请先在本地 Git 配置提交者姓名和邮箱。',
  SIGNING_UNSUPPORTED: '当前提交签名配置不受支持；本工具不会自动更改配置。',
  HOOKS_UNSUPPORTED: '当前仓库 hooks 配置不受支持；本工具不会跳过或修改 hooks。',
  GIT_CONFLICT: '仓库存在未解决冲突，请先在本地 Git 解决后再预览。',
  HEAD_DETACHED: '当前未在普通分支上，暂不支持本地提交。',
  HEAD_UNBORN: '当前仓库尚无初始提交，本批暂不支持。',
  GIT_MERGING: '仓库正在合并，请先在本地 Git 完成或处理。',
  GIT_REBASING: '仓库正在变基，请先在本地 Git 完成或处理。',
  GIT_CHERRY_PICKING: '仓库正在挑选提交，请先在本地 Git 完成或处理。',
  GIT_REVERTING: '仓库正在撤销提交，请先在本地 Git 完成或处理。',
  FSMONITOR_UNSUPPORTED: '仓库文件监控配置暂不受支持，本工具不会更改配置。',
  FILTER_UNSUPPORTED: '仓库内容过滤器配置暂不受支持，本工具不会更改配置。',
  SPARSE_CHECKOUT_UNSUPPORTED: '仓库稀疏检出配置暂不受支持，本工具不会更改配置。',
  SUBMODULE_UNSUPPORTED: '本批不支持提交子模块，请在本地 Git 中处理。',
  PREVIEW_STALE: '预览已失效，请重新读取文件并预览。',
  OPERATION_NOT_FOUND: '未找到原操作记录，无法据此判断是否发生写入；请核对仓库。',
};
function savedCommitOperation(projectId) {
  try {
    const value = localStorage.getItem(commitOperationKey(projectId));
    return value && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : null;
  } catch { return null; }
}
function commitCurrent(view) {
  return commitView === view && view.serial === commitSerial && view.projectId === currentProjectId;
}
function closeCommitDialog() {
  ++commitSerial;
  commitView = null;
  $('#commit-dialog').close();
}
async function commitRequest(view, action, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await apiFetch(`/api/projects/${encodeURIComponent(view.projectId)}/commit/${action}`, {
      signal: controller.signal,
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Intent': 'git-commit' }, body: JSON.stringify(body) } : {}),
    });
  } finally { clearTimeout(timer); }
}
function commitError(response) {
  const error = response.data?.error;
  return `${commitReasons[error?.code] || error?.message || '服务响应不可用，请重新读取。'}${error?.code ? ` (${error.code})` : ''}`;
}
function commitFileList(files) {
  return `<ul class="commit-files">${files.map((file) => `<li><span>${escapeHtml(commitKinds[file.operationType] || file.operationType || '')}</span> <code>${file.oldPath ? `${escapeHtml(file.oldPath)} → ` : ''}${escapeHtml(file.path)}</code></li>`).join('')}</ul>`;
}
function renderCommitDialog() {
  const view = commitView;
  if (!view || !commitCurrent(view)) return;
  const project = realProjects.find((item) => item.id === view.projectId);
  let body = `<p><strong>${escapeHtml(project?.name || view.projectId)}</strong> · 项目 ${escapeHtml(view.projectId)}</p><p class="caption">仅本地提交，不会推送或联网。未选择的已暂存工作会保留。</p>`;
  if (view.phase === 'files') {
    body += `<p>逐项选择这次要保存的文件。已暂存表示 Git 已准备保存的改动；不会默认选中任何文件。</p>
      <div class="commit-candidates">${(view.candidates || []).map((file) => `<label class="commit-candidate"><input type="checkbox" data-commit-candidate="${escapeHtml(file.id)}" ${view.selected.has(file.id) ? 'checked' : ''} ${!file.selectable || view.busy ? 'disabled' : ''}><span><code>${file.oldPath ? `${escapeHtml(file.oldPath)} → ` : ''}${escapeHtml(file.path)}</code><small>${escapeHtml(commitKinds[file.operationType] || file.operationType)} · ${escapeHtml(commitScopes[file.stageScope] || file.stageScope)}${file.unselectableReason ? ` · ${escapeHtml(file.unselectableReason)}` : ''}</small></span></label>`).join('') || '<p>没有可提交的文件变更。</p>'}</div>
      <label class="commit-message-label" for="real-commit-message">一句话说明这次修改</label><input id="real-commit-message" type="text" maxlength="500" value="${escapeHtml(view.message)}" ${view.busy ? 'disabled' : ''} autocomplete="off">
      <p id="real-commit-validation" class="caption">已选择 ${view.selected.size} 项；提交说明需为 1–500 字单行文本。</p>
      <button id="preview-real-commit" class="button primary" ${view.busy || !view.selected.size || !validCommitMessage(view.message) ? 'disabled' : ''}>${view.busy ? '正在核实预览…' : '预览本地提交'}</button>`;
  } else if (view.phase === 'preview') {
    const preview = view.preview;
    body += `<div class="state-notice">服务器已核实项目 ${escapeHtml(preview.projectId)} · 分支 ${escapeHtml(preview.branch)}</div><p>提交说明：${escapeHtml(preview.message)}</p><h3>实际提交范围：${Number(preview.summary.fileCount)} 项</h3>${commitFileList(preview.summary.operations)}<p class="caption">以上为服务器提供的文件级摘要，不含逐行差异。重命名旧/新路径作为一项保存。预览约 ${Number(preview.expiresInSeconds)} 秒内有效；文件或配置改变后必须重新预览。</p>
      <button id="confirm-real-commit" class="button primary" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在确认并核对结果…' : '确认本地提交'}</button>`;
  } else if (view.phase === 'result') {
    const result = view.result || { status: 'unknown' };
    const completed = result.status === 'completed' && /^[a-f0-9]{40,64}$/.test(result.commitOid || '');
    const titles = { partial: '部分完成，需要核对', unknown: '结果未知，需要核对', busy: '操作处理中，需要查询', stale: '预览已失效', not_started: '已核实未开始提交' };
    body += `<div class="state-notice ${completed ? 'good' : ''}"><strong>${completed ? '本地提交已完成（服务器已核实）' : titles[result.status] || '结果未知，需要核对'}</strong></div>`;
    if (completed) body += `<p>分支：${escapeHtml(result.branch)}</p><p class="commit-oid">提交 OID：<code>${escapeHtml(result.commitOid)}</code></p>`;
    else if (result.status === 'partial') {
      body += '<p>服务器已核实当前提交指针未改变，以下仅列出本次操作已证实发生暂存变化的文件；这不是已完成提交。</p>';
      const stagedFiles = Array.isArray(result.stagedFiles) && result.stagedFiles.length > 0 && result.stagedFiles.every((file) => typeof file === 'string') ? result.stagedFiles : null;
      body += stagedFiles ? `<ul id="proven-staged-files" class="commit-files">${stagedFiles.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul>` : '<p>服务器未提供可核实的具体文件清单，请核对本地状态；不能从所选文件推断已暂存文件。</p>';
    }
    else if (result.status === 'stale') body += '<p>本次预览不能再确认。请重新读取候选文件并生成新预览。</p>';
    else if (result.status === 'not_started') body += '<p>服务器未检测到本次提交或暂存变化。若仍要提交，请重新选择并预览。</p>';
    else body += '<p>不能判断这次是否已写入。请查询原操作，必要时在本地 Git 核对；不要再次提交或另建操作重试。</p>';
    const indexFacts = { unchanged: '已核实暂存区未改变', metadata_only: '已核实暂存内容未改变，仅元数据变化', selected_only: '已核实暂存变化仅在选中范围，未选暂存内容保持', unselected_changed: '检测到未选暂存范围变化，需要核对', unknown: '暂存区变化尚未核实' };
    if (result.indexChange) body += `<p>${escapeHtml(indexFacts[result.indexChange] || indexFacts.unknown)}</p>`;
    body += `<p class="caption commit-oid">操作 ID：${escapeHtml(view.operationId || '')}</p><p class="caption">仅支持服务进程崩溃后的结果核对，不保证操作系统崩溃或断电恢复。</p>
      <button id="query-real-commit" class="button" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在查询原操作…' : '查询原操作结果'}</button>
      ${completed || ['stale', 'not_started'].includes(result.status) ? '<button id="new-real-commit" class="button">重新选择文件</button>' : ''}
      <button id="refresh-commit-source" class="button">刷新真实状态与历史</button>`;
  } else body += '<p>正在读取服务器候选文件…</p>';
  if (view.error) body += `<p class="error-box" role="alert">${escapeHtml(view.error)}</p>`;
  if (view.refreshError) body += '<p class="error-box">操作结果已保留，但状态/历史刷新失败。请点击“刷新真实状态与历史”。</p>';
  if (view.phase === 'loading' && !view.busy) body += '<button id="retry-commit-candidates" class="button">重试读取候选文件</button>';
  body += `<div class="actions"><button id="cancel-real-commit" class="button">${view.operationId ? '关闭（保留原操作查询）' : '取消，不提交'}</button></div>`;
  $('#commit-dialog-body').innerHTML = body;
}
function validCommitMessage(message) {
  return typeof message === 'string' && message.trim().length > 0 && message.length <= 500 && !/[\x00-\x1f\x7f]/.test(message);
}
async function openRealCommit({ fresh = false } = {}) {
  if (!isRealMode || !currentProjectId) return;
  const view = { projectId: currentProjectId, serial: ++commitSerial, phase: 'loading', selected: new Set(), message: '', busy: true };
  commitView = view;
  view.operationId = fresh ? null : savedCommitOperation(view.projectId);
  if (!$('#commit-dialog').open) $('#commit-dialog').showModal();
  if (view.operationId) {
    view.phase = 'result';
    view.busy = false;
    await queryRealCommit(view);
    return;
  }
  renderCommitDialog();
  const response = await commitRequest(view, 'candidates');
  if (!commitCurrent(view)) return;
  view.busy = false;
  if (!response.ok || response.data?.projectId !== view.projectId || !Array.isArray(response.data?.candidates)) view.error = commitError(response);
  else { view.phase = 'files'; view.candidates = response.data.candidates; }
  renderCommitDialog();
}
async function previewRealCommit() {
  const view = commitView;
  if (!view || view.busy || view.phase !== 'files' || !view.selected.size || !validCommitMessage(view.message)) return;
  view.busy = true; view.error = null;
  renderCommitDialog();
  const response = await commitRequest(view, 'preview', { candidateIds: [...view.selected], message: view.message });
  if (!commitCurrent(view)) return;
  view.busy = false;
  if (!response.ok || response.data?.projectId !== view.projectId || !response.data?.ticketId) view.error = commitError(response);
  else { view.phase = 'preview'; view.preview = response.data; }
  renderCommitDialog();
}
async function refreshCommitSource(view) {
  if (!commitCurrent(view)) return;
  const ok = await loadRealProject(view.projectId);
  if (!commitCurrent(view)) return;
  view.refreshError = !ok;
  renderCommitDialog();
}
async function queryRealCommit(view, confirmation = null) {
  if (!commitCurrent(view) || !view.operationId || view.busy) return;
  view.busy = true; view.phase = 'result'; view.error = null;
  renderCommitDialog();
  const response = await commitRequest(view, `operations/${encodeURIComponent(view.operationId)}`);
  if (!commitCurrent(view)) return;
  view.busy = false;
  const result = response.data;
  if (result?.projectId === view.projectId && result.operationId === view.operationId && result.status) {
    view.result = result;
  } else if (confirmation?.status === 'stale' && confirmation.operationId === view.operationId && response.data?.error?.code === 'OPERATION_NOT_FOUND') {
    view.result = { status: 'stale' };
    // Confirm explicitly rejected the ticket before a write and read found no operation.
    // Do not strand a cancelled stale ticket across navigation.
    try { if (savedCommitOperation(view.projectId) === view.operationId) localStorage.removeItem(commitOperationKey(view.projectId)); } catch {}
  } else {
    // Keep a verified completed commit, but do not present old partial paths as current facts.
    if (view.result?.status !== 'completed') view.result = { status: 'unknown' };
    view.error = commitError(response);
  }
  renderCommitDialog();
  await refreshCommitSource(view);
}
async function confirmRealCommit() {
  const view = commitView;
  if (!view || view.busy || view.phase !== 'preview') return;
  const operationId = `op_${crypto.randomUUID()}`;
  try {
    localStorage.setItem(commitOperationKey(view.projectId), operationId);
    if (savedCommitOperation(view.projectId) !== operationId) throw new Error('storage');
  } catch {
    view.error = '无法保存操作 ID，未发送提交。请允许本站本地存储后重新预览。';
    renderCommitDialog(); return;
  }
  view.operationId = operationId;
  view.busy = true;
  const ticketId = view.preview.ticketId;
  renderCommitDialog();
  const response = await commitRequest(view, 'confirm', { ticketId, operationId });
  // Even if the dialog closes, the original operation ID remains available for read-only recovery.
  if (!commitCurrent(view)) return;
  view.preview = null; view.busy = false; view.phase = 'result';
  await queryRealCommit(view, response.data);
}
$('#commit-dialog')?.addEventListener('cancel', () => { ++commitSerial; commitView = null; });
$('#commit-dialog')?.addEventListener('change', (event) => {
  const id = event.target.dataset.commitCandidate;
  if (!id || !commitView || commitView.busy || commitView.phase !== 'files') return;
  if (event.target.checked) commitView.selected.add(id); else commitView.selected.delete(id);
  renderCommitDialog();
});
$('#commit-dialog')?.addEventListener('input', (event) => {
  if (event.target.id !== 'real-commit-message' || !commitView || commitView.busy) return;
  commitView.message = event.target.value;
  $('#preview-real-commit').disabled = !commitView.selected.size || !validCommitMessage(commitView.message);
});

function realSourcePage() {
  const current = realProjects.find((p) => p.id === currentProjectId);
  const { source, history } = currentProjectData;

  const count = source.changedCount;
  const level = count >= 23 ? 'red' : count >= 16 ? 'orange' : count >= 8 ? 'yellow' : 'green';
  const description =
    count === 0
      ? '工作区干净，无未暂存或未提交变更'
      : count >= 23
      ? '改动较多，建议在本地 Git 中分批提交'
      : count >= 16
      ? '已有一组改动，建议检查后提交'
      : '本地已有改动，可继续工作或在本地保存提交';

  // 格式化上游信息（中性表述，不假定上游是远端或本地分支）
  let upstreamStage = '未配置上游';
  let syncSummaryHtml = '';
  if (source.upstream.state === 'available') {
    upstreamStage = escapeHtml(source.upstream.name);
    syncSummaryHtml = `
      <strong id="pending-count">${source.upstream.ahead}</strong>
      <div>
        <b>领先提交</b>
        <p>本地领先 ${source.upstream.ahead} 个提交；落后 ${source.upstream.behind} 个提交。<br>
        <small class="muted">上游跟踪引用：${escapeHtml(source.upstream.name)}（本机快照，未联网核实）</small></p>
      </div>`;
  } else if (source.upstream.state === 'not-configured') {
    upstreamStage = '未配置上游';
    syncSummaryHtml = `
      <strong id="pending-count">-</strong>
      <div>
        <b>未配置上游分支</b>
        <p>当前分支尚未关联上游分支，无法计算领先/落后提交。<br>
        <small class="muted">无上游分支 · 本地提交安全保留</small></p>
      </div>`;
  } else {
    upstreamStage = '上游不可用';
    syncSummaryHtml = `
      <strong id="pending-count">?</strong>
      <div>
        <b>上游跟踪引用缺失</b>
        <p>已配置上游 ${escapeHtml(source.upstream.name || '')}，但对应本地引用缺失或不可读。<br>
        <small class="muted">本地对应引用不可用或已被移除</small></p>
      </div>`;
  }

  const branchLabel =
    source.headState === 'detached'
      ? '分离头指针 (detached)'
      : source.headState === 'unborn'
      ? '未出生分支 (unborn)'
      : `${escapeHtml(source.branch)} · 当前分支`;

  return `
    ${heading(
      `${escapeHtml(current?.name || '')} · 源码工作台`,
      `本地只读扫描时间：${new Date(source.scannedAt).toLocaleTimeString()}（查看状态只读）`
    )}
    <div class="source-top">
      <section class="panel">
        <div class="panel-header">
          <h2>工作区文件状态</h2>
          <button class="text-button" data-action="real-files">查看全部文件 (${count}) →</button>
        </div>
        <div class="capacity">
          <div class="squares level-${level}">
            ${Array.from({ length: 25 }, (_, i) => {
              const file = source.changes[i];
              return `<button class="square ${i < count ? 'filled' : ''}" ${
                i >= count ? 'disabled' : ''
              } data-real-file="${i}" aria-label="${file ? escapeHtml(file.path) : '空余提醒格'}"></button>`;
            }).join('')}
          </div>
          <div>
            <div class="big-number" id="change-count">${count}</div>
            <div class="count-label">未提交变更文件</div>
            <p class="caption">${count > 25 ? `25 格已满，实际 ${count} 个变更文件` : '25 格提醒刻度 · 非容量上限'}</p>
          </div>
        </div>
        <p class="caption">${description}</p>
        <div class="legend">
          <span><i class="green-key"></i>1–7 少量</span>
          <span><i class="yellow-key"></i>8–15 留意</span>
          <span><i class="orange-key"></i>16–22 较多</span>
          <span><i class="red-key"></i>23+ 提醒</span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>本地 / 上游跟踪状态</h2>
          <button class="text-button" data-action="real-refresh">刷新本地状态 ↻</button>
        </div>
        <div class="pipeline">
          <div class="stage">
            <div class="stage-symbol">▰</div>
            <strong>工作区</strong>
            <small>${count ? `${count} 个变更待提交` : '工作区已保存'}</small>
          </div>
          <div class="arrow"></div>
          <div class="stage">
            <div class="stage-symbol">▤</div>
            <strong>本地仓库</strong>
            <small>${branchLabel}</small>
          </div>
          <div class="arrow"></div>
          <div class="stage">
            <div class="stage-symbol">↑</div>
            <strong>上游分支</strong>
            <small>${upstreamStage}</small>
          </div>
        </div>
        <div class="sync-summary">${syncSummaryHtml}</div>
        <div class="actions">
          <button id="open-real-commit" class="button primary">选择文件并本地提交</button>
          <button class="button" data-action="real-files">查看改动 (${count})</button>
          <button class="button primary" data-action="real-refresh">刷新状态 ↻</button>
        </div>
        <p class="caption">本地扫描时间：${new Date(source.scannedAt).toLocaleString()} · 本地快照未联网</p>
      </section>
    </div>

    <section class="panel graph-panel">
      <div class="panel-header">
        <h2>分支与版本记录</h2>
        <span class="caption">真实 Git 拓扑图与提交记录 · 点击详情查看完整 OID</span>
      </div>
      ${realGraph(history)}
    </section>`;
}

function realGraph(history) {
  const commits = history.commits || [];
  if (commits.length === 0) {
    return '<div class="empty real-graph-empty"><p>当前仓库尚无提交历史（空仓库或未出生分支）。</p></div>';
  }

  // 计算简单的多车道拓扑 Lane
  const activeLanes = [];
  const commitRows = commits.map((c) => {
    let lane = activeLanes.indexOf(c.oid);
    if (lane === -1) {
      lane = activeLanes.indexOf(null);
      if (lane === -1) {
        lane = activeLanes.length;
        activeLanes.push(null);
      }
    }
    activeLanes[lane] = c.parents && c.parents.length > 0 ? c.parents[0] : null;

    // 为其余 parent 分配通道
    if (c.parents && c.parents.length > 1) {
      for (let pIdx = 1; pIdx < c.parents.length; pIdx++) {
        const parentOid = c.parents[pIdx];
        if (!activeLanes.includes(parentOid)) {
          const emptyIdx = activeLanes.indexOf(null);
          if (emptyIdx !== -1) activeLanes[emptyIdx] = parentOid;
          else activeLanes.push(parentOid);
        }
      }
    }

    return { ...c, lane };
  });

  const maxLane = Math.max(0, ...commitRows.map((c) => c.lane));
  const svgWidth = Math.max(70, 25 + maxLane * 30 + 25);
  const laneColors = ['#008786', '#9266c9', '#207f98', '#ecaa32', '#d95656'];

  // 绘制连线
  let paths = '';
  commitRows.forEach((c, idx) => {
    const x1 = 25 + c.lane * 30;
    const y1 = idx * 66 + 33;
    if (c.parents && c.parents.length > 0) {
      c.parents.forEach((parentOid) => {
        const parentIdx = commitRows.findIndex((p) => p.oid === parentOid);
        if (parentIdx !== -1) {
          const pLane = commitRows[parentIdx].lane;
          const x2 = 25 + pLane * 30;
          const y2 = parentIdx * 66 + 33;
          const stroke = laneColors[Math.min(c.lane, pLane) % laneColors.length];
          paths += `<path d="M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="3"/>`;
        } else {
          // 窗口外父提交
          paths += `<path d="M ${x1} ${y1} L ${x1} ${y1 + 22}" fill="none" stroke="#a0b3c2" stroke-width="2" stroke-dasharray="3,3"/>`;
        }
      });
    }
  });

  const circles = commitRows
    .map((c, idx) => {
      const cx = 25 + c.lane * 30;
      const cy = idx * 66 + 33;
      const fill = laneColors[c.lane % laneColors.length];
      return `<circle cx="${cx}" cy="${cy}" r="6" fill="${fill}" stroke="white" stroke-width="2"/>`;
    })
    .join('');

  const truncateHtml = history.truncated
    ? `<div class="truncate-banner">仅展示最近 100 条可达提交（历史已截断）</div>`
    : '';

  return `
    ${truncateHtml}
    <div class="graph-table">
      <div class="graph-head">
        <span>提交</span>
        <span>图形</span>
        <span>提交信息</span>
        <span>时间</span>
        <span>分支 / 标签</span>
        <span>详情</span>
      </div>
      <svg class="graph-canvas" width="${svgWidth}" height="${commitRows.length * 66}" viewBox="0 0 ${svgWidth} ${commitRows.length * 66}" preserveAspectRatio="none">
        ${paths}
        ${circles}
      </svg>
      ${commitRows
        .map((c, i) => {
          // 匹配属于该提交的引用
          const refsForCommit = (history.refs || []).filter((r) => r.oid === c.oid);
          const refsBadgeHtml = refsForCommit
            .map((r) => {
              if (r.kind === 'head') return '<span class="tag purple">HEAD</span>';
              if (r.kind === 'local-branch') return `<span class="tag">${escapeHtml(r.name)}</span>`;
              if (r.kind === 'remote-tracking') return `<span class="tag blue">${escapeHtml(r.name)}</span>`;
              if (r.kind === 'tag') return `<span class="tag amber">${escapeHtml(r.name)}</span>`;
              return `<span class="tag gray">${escapeHtml(r.name)}</span>`;
            })
            .join(' ');

          const isMerge = c.parents && c.parents.length > 1;
          const hasOutParent = c.parents && c.parents.some((p) => !commitRows.some((row) => row.oid === p));
          const extraHint = [
            isMerge ? '<small class="muted merge-hint">(合并提交)</small>' : '',
            hasOutParent ? '<span class="commit-parent-tag">窗口外父提交</span>' : '',
          ].join('');

          return `
            <div class="commit-row">
              <code>${escapeHtml(c.oid.slice(0, 7))}</code>
              <span></span>
              <div class="commit-message">
                ${escapeHtml(c.subject || '（无提交说明）')}
                ${extraHint}
              </div>
              <time>${formatCommitDate(c.committedAt)}</time>
              <span>${refsBadgeHtml}</span>
              <button class="text-button" data-real-commit="${i}" aria-label="查看提交详情">···</button>
            </div>`;
        })
        .join('')}
    </div>`;
}

function showRealFiles() {
  if (!currentProjectData?.source) return;
  const changes = currentProjectData.source.changes || [];
  modal(
    `工作区改动清单 (${changes.length})`,
    `<p>以下为本地仓库当前文件变更状态（只读清单，不执行 diff 或修改）：</p>
    <div class="file-list">
      ${
        changes
          .map((c) => {
            let statusTag = '';
            if (c.conflicted) {
              statusTag = tag('冲突', 'red');
            } else if (c.indexStatus === '?' && c.worktreeStatus === '?') {
              statusTag = tag('未跟踪', 'gray');
            } else if (c.indexStatus === 'A' || c.worktreeStatus === 'A') {
              statusTag = tag('新增', 'green');
            } else if (c.indexStatus === 'D' || c.worktreeStatus === 'D') {
              statusTag = tag('删除', 'red');
            } else if (c.indexStatus === 'R' || c.worktreeStatus === 'R') {
              statusTag = tag('重命名', 'purple');
            } else {
              statusTag = tag('修改', 'amber');
            }
            const renameInfo = c.oldPath ? `<small class="muted">（原路径：${escapeHtml(c.oldPath)}）</small>` : '';
            return `<div class="file-row">${statusTag} <code>${escapeHtml(c.path)}</code> ${renameInfo}</div>`;
          })
          .join('') || '<p class="clean-worktree-note">工作区干净，无未暂存或未提交改动。</p>'
      }
    </div>`
  );
}

function showRealCommit(index) {
  if (!currentProjectData?.history?.commits) return;
  const c = currentProjectData.history.commits[index];
  if (!c) return;

  const refs = (currentProjectData.history.refs || []).filter((r) => r.oid === c.oid);
  const parentsHtml = (c.parents || []).map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join('') || '<li>无父提交 (根提交)</li>';

  modal(
    `提交详情 · ${c.oid.slice(0, 7)}`,
    `<div class="form-group"><label>提交说明：</label><p class="real-commit-subject">${escapeHtml(c.subject)}</p></div>
    <dl class="metadata real-commit-metadata">
      <div><dt>完整 OID</dt><dd><code>${escapeHtml(c.oid)}</code></dd></div>
      <div><dt>提交时间</dt><dd>${new Date(c.committedAt).toLocaleString()}</dd></div>
      <div><dt>关联分支/标签</dt><dd>${refs.map((r) => tag(r.name)).join(' ') || '无直接引用'}</dd></div>
    </dl>
    <div class="form-group"><label>父提交 OID：</label><ul class="real-parent-list">${parentsHtml}</ul></div>
    <p class="caption">只读展示 · 本工作台不执行 checkout 或 reset 操作。</p>`
  );
}

// ------------------------------------------
// PC 接入向导逻辑
// ------------------------------------------
function openOnboardingDialog() {
  ++onboardSerial;
  lastInspectResult = null;
  renderOnboardStep1();
  const dlg = $('#onboard-dialog');
  if (!dlg.open) dlg.showModal();
}

function renderOnboardStep1(errorMsg = null, prefillPath = '', prefillName = '') {
  const candidateId = generateCandidateId();
  $('#onboard-dialog-title').textContent = '接入已有本地项目';
  $('#onboard-dialog-body').innerHTML = `
    <div class="onboard-step">
      <p class="onboard-help-text">请输入或粘贴当前主机上的本地 Git 仓库绝对目录。接入过程只读识别，不会修改被管理仓库，仅在您确认后保存到本工具配置中。</p>
      ${errorMsg ? `<div class="error-box">${escapeHtml(errorMsg)}</div>` : ''}
      <form id="onboard-inspect-form">
        <div class="form-group">
          <label for="onboard-path">本地仓库绝对路径：</label>
          <input id="onboard-path" name="path" type="text" placeholder="例如：D:\\projects\\my-repo" value="${escapeHtml(prefillPath)}" required autocomplete="off">
          <small class="muted">支持仓库根目录或其任意子目录（会自动归一化到根目录）。不支持裸仓库或远端 URL。</small>
        </div>
        <div class="form-group">
          <label for="onboard-name">项目显示名称（可选，默认为目录名）：</label>
          <input id="onboard-name" name="name" type="text" placeholder="项目名称（1-80字符）" maxlength="80" value="${escapeHtml(prefillName)}" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="onboard-id">项目内部 ID（小写字母开头，最长32位）：</label>
          <div class="id-input-row">
          <input id="onboard-id" name="id" type="text" value="${escapeHtml(candidateId)}" maxlength="32" required pattern="^[a-z][a-z0-9_\\-]{0,31}$">
            <button type="button" id="btn-regen-id" class="button" title="重新生成候选 ID">换一个 ID</button>
          </div>
        </div>
        <div class="onboard-actions">
          <button type="button" id="btn-cancel-onboard" class="button">取消</button>
          <button type="submit" id="btn-inspect-submit" class="button primary">检查目录 →</button>
        </div>
      </form>
    </div>`;

  $('#btn-regen-id')?.addEventListener('click', () => {
    $('#onboard-id').value = generateCandidateId();
  });
  $('#btn-cancel-onboard')?.addEventListener('click', () => {
    ++onboardSerial;
    $('#onboard-dialog').close();
  });
  $('#onboard-inspect-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawPath = $('#onboard-path').value.trim();
    const name = $('#onboard-name').value.trim();
    const id = $('#onboard-id').value.trim();
    const requestSerial = ++onboardSerial;

    if (!rawPath) return;

    const submitBtn = $('#btn-inspect-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = '正在检查...';

    const res = await apiFetch('/api/projects/inspect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Local-Intent': 'project-onboarding',
      },
      body: JSON.stringify({ repositoryPath: rawPath }),
    });

    if (requestSerial !== onboardSerial) return;

    submitBtn.disabled = false;
    submitBtn.textContent = '检查目录 →';

    if (!res.ok) {
      const err = res.data?.error || {};
      let msg = err.message || '目录检查失败';
      if (err.code === 'NOT_REPOSITORY') {
        msg = '指定目录不是有效的非裸 Git 仓库。若需要在该目录使用版本管理，后续可主动初始化，但本阶段不支持自动 git init。不支持接入裸仓库或远端 URL。';
      }
      renderOnboardStep1(`[${err.code || 'INSPECT_FAILED'}] ${msg}`, rawPath, name);
      return;
    }

    lastInspectResult = res.data;
    renderOnboardStep2(rawPath, name || lastInspectResult.repositoryRoot.split(/[\\/]/).filter(Boolean).pop() || '未命名项目', id);
  });
}

function renderOnboardStep2(inputPath, projectName, projectId, errorMsg = null) {
  const result = lastInspectResult;
  $('#onboard-dialog-title').textContent = '核对接入摘要与登记信息';

  const isSubdir = inputPath.replace(/[\\/]+$/, '').toLowerCase() !== result.repositoryRoot.replace(/[\\/]+$/, '').toLowerCase();
  const rootNotice = isSubdir
    ? `<div class="inspect-root-highlight">
        <strong>提示：您输入的子目录已成功归一化为仓库根目录（仅登记根目录）：</strong>
        <code>${escapeHtml(result.repositoryRoot)}</code>
       </div>`
    : `<div class="inspect-root-highlight">
        <strong>识别到的 Git 工作树根目录：</strong>
        <code>${escapeHtml(result.repositoryRoot)}</code>
       </div>`;

  const headDesc =
    result.headState === 'detached'
      ? '分离头指针 (detached)'
      : result.headState === 'unborn'
      ? '未出生分支 (尚无提交)'
      : `${escapeHtml(result.branch || 'HEAD')} · 当前分支`;

  const commitDesc = result.latestCommit
    ? `${escapeHtml(result.latestCommit.oid.slice(0, 7))} · ${escapeHtml(result.latestCommit.subject)}`
    : '尚无提交历史';

  let upstreamDesc = '未配置上游跟踪分支';
  if (result.upstream.state === 'available') {
    upstreamDesc = `领先 ${result.upstream.ahead}，落后 ${result.upstream.behind} (${escapeHtml(result.upstream.name)})`;
  } else if (result.upstream.state === 'unavailable') {
    upstreamDesc = `${escapeHtml(result.upstream.name || '上游')} (跟踪引用不可用)`;
  }

  $('#onboard-dialog-body').innerHTML = `
    <div class="onboard-step">
      ${errorMsg ? `<div class="error-box">${escapeHtml(errorMsg)}</div>` : ''}
      ${rootNotice}
      <div class="inspect-summary-box">
        <dl class="inspect-grid">
          <div><dt>当前分支 / HEAD</dt><dd>${headDesc}</dd></div>
          <div><dt>最新提交</dt><dd>${commitDesc}</dd></div>
          <div><dt>未提交变更</dt><dd>${result.changedCount} 个变更文件</dd></div>
          <div><dt>本地上游状态</dt><dd>${upstreamDesc} <small class="muted">（本地跟踪快照，未联网核实）</small></dd></div>
        </dl>
      </div>

      <div class="onboard-notice">
        <strong>安全承诺：</strong>已有提交历史、尚未提交与尚未推送的工作均会完整保留在本地，绝不会用远端覆盖本地代码。接入后可为当前项目分别关联安装包与升级包目录，材料始终只读。
      </div>

      <form id="onboard-confirm-form">
        <div class="form-group">
          <label for="confirm-name">确认项目名称：</label>
          <input id="confirm-name" name="name" type="text" value="${escapeHtml(projectName)}" maxlength="80" required autocomplete="off">
        </div>
        <div class="form-group">
          <label for="confirm-id">确认项目 ID：</label>
          <input id="confirm-id" name="id" type="text" value="${escapeHtml(projectId)}" maxlength="32" required pattern="^[a-z][a-z0-9_\\-]{0,31}$">
        </div>
        <div class="onboard-actions">
          <button type="button" id="btn-back-step1" class="button">返回修改</button>
          <button type="button" id="btn-cancel-step2" class="button">取消</button>
          <button type="submit" id="btn-confirm-submit" class="button primary">确认接入</button>
        </div>
      </form>
    </div>`;

  $('#btn-back-step1')?.addEventListener('click', () => {
    ++onboardSerial;
    renderOnboardStep1(null, inputPath, projectName);
  });
  $('#btn-cancel-step2')?.addEventListener('click', () => {
    ++onboardSerial;
    $('#onboard-dialog').close();
  });
  $('#onboard-confirm-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const finalName = $('#confirm-name').value.trim();
    const finalId = $('#confirm-id').value.trim();
    const requestSerial = ++onboardSerial;
    const submitBtn = $('#btn-confirm-submit');

    submitBtn.disabled = true;
    submitBtn.textContent = '正在登记...';

    const res = await apiFetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Local-Intent': 'project-onboarding',
      },
      body: JSON.stringify({
        inspectionId: result.inspectionId,
        id: finalId,
        name: finalName,
      }),
    });

    if (requestSerial !== onboardSerial) return;

    submitBtn.disabled = false;
    submitBtn.textContent = '确认接入';

    if (!res.ok) {
      const err = res.data?.error || {};
      if (err.code === 'ID_CONFLICT') {
        const newCandidate = generateCandidateId();
        renderOnboardStep2(inputPath, finalName, newCandidate, `项目 ID "${finalId}" 已被其他项目占用，已为您生成新 ID "${newCandidate}"，请再次确认。`);
      } else if (err.code === 'INSPECTION_STALE') {
        renderOnboardStep1(`检查票据已失效或底层仓库状态改变，请重新检查目录。`, inputPath, finalName);
      } else {
        renderOnboardStep2(inputPath, finalName, finalId, `[${err.code || 'CONFIG_SAVE_FAILED'}] ${err.message || '保存项目配置失败'}`);
      }
      return;
    }

    // 成功登记！
    $('#onboard-dialog').close();
    ++onboardSerial;
    const isAlready = res.data.alreadyRegistered;
    const proj = res.data.project;
    notify(isAlready ? `该仓库此前已登记，已为您切换至 "${proj.name}"` : `成功接入项目 "${proj.name}"！`);

    await reloadProjectsList(proj.id);
  });
}

// ==========================================
// 全局事件绑定
// ==========================================
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;

  // 视图切换
  if (button.dataset.view) {
    if (isRealMode) { closeCommitDialog(); closeMaterialOperation(); }
    state.view = button.dataset.view;
    if (isRealMode) renderReal();
    else renderDemo();
    return;
  }

  // 演示模式专属操作
  if (!isRealMode) {
    if (button.dataset.action) {
      demoAction(button.dataset.action);
      return;
    }
    if (button.dataset.file !== undefined) {
      showFile(Number(button.dataset.file));
      return;
    }
    if (button.dataset.commit !== undefined) {
      const c = state.commits[Number(button.dataset.commit)];
      modal(
        '版本记录（演示）',
        `<h3>${escapeHtml(c.message)}</h3><p>演示提交：${escapeHtml(c.id)}</p><p>${escapeHtml(c.note)}</p><p>分支 / 标签：${escapeHtml(
          c.ref || '无独立标签'
        )}</p><p class="caption">只查看信息，不会切换分支或恢复源码。</p>`
      );
      return;
    }
  }

  // 真实模式专属操作
  if (isRealMode) {
    if (button.dataset.materialOperation) { openMaterialOperation(button.dataset.materialOperation); return; }
    if (button.id === 'recover-material-operation') { openMaterialOperation(null, true); return; }
    if (button.id === 'preview-material-operation') { void previewMaterialOperation(); return; }
    if (button.id === 'confirm-material-operation') { void confirmMaterialOperation(); return; }
    if (button.id === 'query-material-operation') { void queryMaterialOperation(); return; }
    if (button.id === 'cancel-material-operation') { void cancelMaterialOperation(); return; }
    if (button.id === 'close-material-operation') { closeMaterialOperation(); return; }
    if (button.id === 'back-material-operation' && materialOperationView && !materialOperationView.busy) { materialOperationView.preview = null; materialOperationView.phase = 'input'; renderMaterialOperation(); return; }
    if (button.id === 'open-real-commit' || button.id === 'retry-commit-candidates') { void openRealCommit(); return; }
    if (button.id === 'preview-real-commit') { void previewRealCommit(); return; }
    if (button.id === 'confirm-real-commit') { void confirmRealCommit(); return; }
    if (button.id === 'cancel-real-commit') { closeCommitDialog(); return; }
    if (button.id === 'query-real-commit') { void queryRealCommit(commitView); return; }
    if (button.id === 'refresh-commit-source') { void refreshCommitSource(commitView); return; }
    if (button.id === 'new-real-commit' && !commitView?.busy && ['completed', 'stale', 'not_started'].includes(commitView?.result?.status)) { void openRealCommit({ fresh: true }); return; }
    // 材料条目选择
    if (button.dataset.materialItem !== undefined) {
      closeMaterialOperation();
      selectedMaterialItemId = button.dataset.materialItem;
      renderReal();
      return;
    }

    // 打开材料关联向导
    if (
      button.id === 'btn-open-material-dialog' ||
      button.id === 'btn-relink-material' ||
      button.id === 'btn-relink-material-top' ||
      button.id === 'btn-relink-material-empty' ||
      button.id === 'btn-relink-from-detail'
    ) {
      openMaterialDialog(state.view);
      return;
    }

    // 材料重试 / 重新扫描
    if (
      button.id === 'btn-retry-material' ||
      button.id === 'btn-retry-material-empty' ||
      button.id === 'btn-refresh-from-detail'
    ) {
      if (currentProjectId && (state.view === 'installer' || state.view === 'upgrade')) {
        loadRealMaterial(currentProjectId, state.view).then((ok) => {
          if (ok) notify('已重新扫描材料目录。');
        });
      }
      return;
    }

    // 材料向导取消
    if (button.id === 'btn-cancel-material-inspect' || button.id === 'btn-cancel-material-confirm') {
      materialWizardState = null;
      $('#material-dialog')?.close();
      return;
    }

    if (button.dataset.action === 'real-files') {
      showRealFiles();
      return;
    }
    if (button.dataset.action === 'real-refresh' || button.id === 'btn-refresh-real' || button.id === 'btn-retry-project') {
      if (state.view !== 'source' && currentProjectId) {
        loadRealMaterial(currentProjectId, state.view).then((ok) => {
          if (ok) notify('已重新扫描材料目录。');
        });
        return;
      }
      const retrySource = button.dataset.retrySource || lastRealError?.source || (currentProjectId ? 'project' : 'list');
      if (retrySource === 'list') {
        const targetId = lastRealError?.selectId || currentProjectId;
        reloadProjectsList(targetId).then(() => {
          if (!lastRealError) notify('已刷新项目配置列表。');
        });
      } else if (currentProjectId) {
        loadRealProject(currentProjectId).then((ok) => {
          if (ok) notify('已刷新本地 Git 只读状态。');
        });
      } else {
        reloadProjectsList();
      }
      return;
    }
    if (button.dataset.realFile !== undefined) {
      showRealFiles();
      return;
    }
    if (button.dataset.realCommit !== undefined) {
      showRealCommit(Number(button.dataset.realCommit));
      return;
    }
    if (button.id === 'btn-open-onboard' || button.id === 'btn-empty-onboard' || button.id === 'btn-open-onboard-from-err') {
      openOnboardingDialog();
      return;
    }
  }

  // 公共材料包选择（演示模式下）
  if (button.dataset.package) {
    if (state.view === 'installer') state.selectedInstaller = button.dataset.package;
    else state.selectedUpgrade = button.dataset.package;
    if (isRealMode) renderReal();
    else renderDemo();
  }
});

// 项目选择下拉框变更
$('#project-select')?.addEventListener('change', (e) => {
  const newId = e.target.value;
  if (!newId || newId === currentProjectId) return;
  closeCommitDialog();
  ++realActiveRequestSerial;
  ++realActiveMaterialSerial;
  closeMaterialOperation();
  currentProjectId = newId;
  sessionStorage.setItem('selected_project_id', currentProjectId);
  updateTopbarBreadcrumb();
  currentProjectData = null;
  currentMaterialData = null;
  selectedMaterialItemId = null;
  renderReal();
});

// 场景切换仅在演示模式有效
document.addEventListener('change', (event) => {
  if (isRealMode) return; // 真实模式严禁触发演示场景切换
  if (event.target.id === 'scenario' && event.target.value !== '') {
    state.count = Number(event.target.value);
    renderDemo();
    notify('已切换演示文件数量；提交记录保持不变。');
  }
});

// 模拟提交表单仅在演示模式有效
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'commit-form') return;
  event.preventDefault();
  if (isRealMode) return; // 真实模式严禁触发模拟提交
  const message = $('#commit-message').value.trim();
  if (!message) {
    $('#commit-error').textContent = '请填写一句修改说明。';
    return;
  }
  state.serial++;
  state.commits[0].ref = state.pending === 0 ? 'origin/main' : '';
  state.commits.unshift({
    id: 'demo' + String(state.serial).padStart(3, '0'),
    message,
    note: '本地提交 · 等待推送',
    ref: 'main · 当前',
    lane: 0,
    new: true,
  });
  state.count = 0;
  state.pending++;
  $('#dialog').close();
  renderDemo();
  notify('模拟提交完成：已保存到页面中的本地记录，尚未推送。');
});

$('#close-dialog').addEventListener('click', () => $('#dialog').close());
$('#close-onboard-dialog')?.addEventListener('click', () => {
  ++onboardSerial;
  $('#onboard-dialog').close();
});
$('#close-material-dialog')?.addEventListener('click', () => {
  materialWizardState = null;
  $('#material-dialog').close();
});
$('#material-dialog')?.addEventListener('cancel', (event) => {
  if (materialWizardState?.isBusy && materialWizardState.step === 'review') {
    event.preventDefault();
  } else {
    materialWizardState = null;
  }
});

$('#reset').addEventListener('click', () => {
  if (isRealMode) return; // 真实模式严禁重置
  if ($('#dialog').open) $('#dialog').close();
  demoReset();
  notify('已恢复初始演示数据。');
});

$('#guide').addEventListener('click', () => showHelpContent('guide'));

// 页面初始化
if (isRealMode) {
  initRealMode();
} else {
  demoReset();
}
