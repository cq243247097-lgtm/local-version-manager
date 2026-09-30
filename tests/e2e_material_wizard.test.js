import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createAppServer } from '../server/app.js';

// 动态引用已安装的 playwright-core / chromium
const playwrightPath = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
let chromium;
try {
  const pw = await import(`file://${playwrightPath}/index.mjs`);
  chromium = pw.chromium;
} catch {
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    // 若找不到则跳过浏览器图形测试
  }
}

describe('P2-T03: 端到端浏览器验证与向导交互', { skip: !chromium ? 'playwright 未就绪' : false }, () => {
  let tempBase;
  let server;
  let port;
  let browser;
  let context;
  let testRepoDir;
  let testInstallerDir;
  let testUpgradeDir;
  const evidenceDir = path.resolve('.local/p2-evidence');

  before(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'p2-e2e-'));
    const tempConfig = path.join(tempBase, 'projects.json');
    await fs.mkdir(evidenceDir, { recursive: true });

    // 1. 初始化一个测试 git 仓库
    testRepoDir = path.join(tempBase, 'repo');
    await fs.mkdir(testRepoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: testRepoDir });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: testRepoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepoDir });
    await fs.writeFile(path.join(testRepoDir, 'file.txt'), 'hello world');
    execFileSync('git', ['add', '.'], { cwd: testRepoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: testRepoDir });

    // 2. 初始化安装包夹具目录
    testInstallerDir = path.join(tempBase, 'installers');
    await fs.mkdir(testInstallerDir, { recursive: true });
    const instFile1 = path.join(testInstallerDir, 'App-1.0.0-win.exe');
    await fs.writeFile(instFile1, 'mock binary content 1.0.0');
    const instStat1 = await fs.stat(instFile1);

    const instFile2 = path.join(testInstallerDir, 'App-unknown.bin');
    await fs.writeFile(instFile2, 'mock unidentified file');

    const installerRecords = {
      schemaVersion: 1,
      records: [
        {
          kind: 'installer',
          file: 'App-1.0.0-win.exe',
          targetVersion: '1.0.0',
          revision: 'rev-1',
          platform: 'Windows-x64',
          sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
          releaseStatus: 'candidate',
          evidenceSource: 'notes/release-record.json',
          recordedFile: {
            sizeBytes: instStat1.size,
            mtimeMs: instStat1.mtimeMs,
            sha256: 'a'.repeat(64),
          },
          integrityRecord: { result: 'passed', method: 'sha256', recordedAt: new Date().toISOString() },
          installationRecord: { result: 'passed', environment: 'win11-x64', recordedAt: new Date().toISOString() }
        }
      ]
    };
    await fs.writeFile(path.join(testInstallerDir, 'material-records.json'), JSON.stringify(installerRecords, null, 2));

    // 3. 初始化升级包夹具目录
    testUpgradeDir = path.join(tempBase, 'upgrades');
    await fs.mkdir(testUpgradeDir, { recursive: true });
    const upgFile1 = path.join(testUpgradeDir, 'Patch-2.0.0.upd');
    await fs.writeFile(upgFile1, 'mock upgrade binary 2.0.0');

    const upgradeRecords = {
      schemaVersion: 1,
      records: [
        {
          kind: 'upgrade',
          file: 'Patch-2.0.0.upd',
          targetVersion: '2.0.0',
          revision: 'r1',
          directFrom: ['1.0.0', '1.1.0'],
          integrityRecord: { result: 'passed', recordedAt: new Date().toISOString() },
          installationRecord: { result: 'passed', environment: 'win11-x64', recordedAt: new Date().toISOString() }
        }
      ]
    };
    await fs.writeFile(path.join(testUpgradeDir, 'material-records.json'), JSON.stringify(upgradeRecords, null, 2));

    // 4. 创建只读服务端
    const app = createAppServer({
      port: 0,
      configPath: tempConfig,
      evidenceDir,
    });
    server = app.server;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        app.setListeningPort(port);
        resolve();
      });
    });

    // 5. 启动无头浏览器
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tempBase) {
      try {
        await fs.rm(tempBase, { recursive: true, force: true });
      } catch {}
    }
  });

  test('端到端向导流程：接入项目 -> 未关联状态 -> 关联安装包向导 -> 事实分层详情 -> 关联升级包向导 -> 最低直接来源', async () => {
    const fingerprint = async (filePath) => createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
    const installerFileHash = await fingerprint(path.join(testInstallerDir, 'App-1.0.0-win.exe'));
    const installerRecordHash = await fingerprint(path.join(testInstallerDir, 'material-records.json'));
    const upgradeFileHash = await fingerprint(path.join(testUpgradeDir, 'Patch-2.0.0.upd'));
    const upgradeRecordHash = await fingerprint(path.join(testUpgradeDir, 'material-records.json'));
    const repoStatusBefore = execFileSync('git', ['status', '--porcelain=v1'], { cwd: testRepoDir, encoding: 'utf8' });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    const appUrl = `http://127.0.0.1:${port}/`;
    await page.goto(appUrl);

    // 1. 验证真实模式标记
    const appMode = await page.getAttribute('meta[name="app-mode"]', 'content');
    assert.equal(appMode, 'real');

    // 2. 登记测试仓库
    await page.click('#btn-open-onboard');
    await page.waitForSelector('#onboard-dialog[open]');
    await page.fill('#onboard-path', testRepoDir);
    await page.fill('#onboard-name', 'E2E测试项目');
    await page.click('#btn-inspect-submit');

    await page.waitForSelector('#onboard-confirm-form');
    await page.click('#btn-confirm-submit');
    await page.waitForSelector('#onboard-dialog', { state: 'hidden' });

    // 截图 1：项目接入完成
    await page.screenshot({ path: path.join(evidenceDir, '01_project_onboarded.png') });

    // 3. 切换至“安装包”视图
    await page.click('button[data-view="installer"]');
    await page.waitForSelector('.material-unlinked-box');
    assert.ok(await page.textContent('.material-unlinked-box'), '应提示尚未关联安装包物理目录');

    // 截图 2：未关联状态
    await page.screenshot({ path: path.join(evidenceDir, '02_installer_unlinked.png') });

    // 4. 打开关联安装包向导
    await page.click('#btn-open-material-dialog');
    await page.waitForSelector('#material-dialog[open]');
    assert.ok((await page.textContent('#material-dialog-title')).includes('关联安装包目录'));

    // 输入安装包根目录并检查
    await page.fill('#material-root-input', testInstallerDir);
    await page.click('#btn-submit-material-inspect');

    // 等待审查页渲染
    await page.waitForSelector('#btn-submit-material-confirm');
    const reviewContent = await page.textContent('#material-dialog-body');
    assert.ok(reviewContent.includes('规范化真实根路径'));
    assert.ok(reviewContent.includes('已发现文件'));

    // 截图 3：向导 Review 阶段
    await page.screenshot({ path: path.join(evidenceDir, '03_installer_wizard_review.png') });

    // 确认关联
    await page.click('#btn-submit-material-confirm');
    await page.waitForSelector('#material-dialog', { state: 'hidden' });

    // 等待材料树加载
    await page.waitForSelector('.archive-layout');
    const treeText = await page.textContent('.archive-layout');
    assert.ok(treeText.includes('App-1.0.0-win.exe'));
    assert.ok(treeText.includes('待识别材料') || treeText.includes('App-unknown.bin'));
    assert.ok(treeText.includes('已声明'), '有效记录必须出现在已声明分组');

    // 截图 4：安装包资料库已关联树形图
    await page.screenshot({ path: path.join(evidenceDir, '04_installer_library_tree.png') });

    // 5. 验证事实分层文案审查
    const detailText = await page.textContent('[aria-label="材料详情"]');
    assert.ok(detailText.includes('记录称通过，本次未核验当前文件'), '必须包含免责声明');
    assert.ok(detailText.includes('01 本次物理文件 (只读探测)'));
    assert.ok(detailText.includes('02 完整性记录 (历史登记)'));
    assert.ok(detailText.includes('03 安装验证记录 (历史登记)'));
    assert.ok(detailText.includes('material-records.json'));
    assert.ok(detailText.includes('Windows-x64'));
    assert.ok(detailText.includes('win11-x64'));
    assert.ok(!detailText.includes('记录损坏'), '有效记录不能误报损坏');

    // 6. 切换至“升级包”视图并关联升级包目录
    await page.click('button[data-view="upgrade"]');
    await page.waitForSelector('.material-unlinked-box');

    await page.click('#btn-open-material-dialog');
    await page.waitForSelector('#material-dialog[open]');
    await page.fill('#material-root-input', testUpgradeDir);
    await page.click('#btn-submit-material-inspect');
    await page.waitForSelector('#btn-submit-material-confirm');
    await page.click('#btn-submit-material-confirm');
    await page.waitForSelector('#material-dialog', { state: 'hidden' });

    // 等待升级包树形加载
    await page.waitForSelector('.archive-layout');
    const upgTreeText = await page.textContent('.archive-layout');
    assert.ok(upgTreeText.includes('Patch-2.0.0.upd'));
    assert.ok(upgTreeText.includes('最低 1.0.0') || upgTreeText.includes('1.0.0'), '树上应包含最低直接来源');

    // 验证升级包详情展示
    const upgDetail = await page.textContent('[aria-label="材料详情"]');
    assert.ok(upgDetail.includes('1.0.0'));
    assert.ok(upgDetail.includes('直接升级'));
    assert.ok(upgDetail.includes('最低支持来源'));
    assert.ok(upgDetail.includes('03 升级验证记录 (历史登记)'));
    assert.ok(upgDetail.includes('win11-x64'));

    // 截图 5：升级包资料库
    await page.screenshot({ path: path.join(evidenceDir, '05_upgrade_library.png') });

    // 7. 根目录失效与错误恢复验证 (409 MATERIAL_ROOT_UNAVAILABLE)
    // 模拟安装包目录被移走
    const renamedInstallerDir = path.join(tempBase, 'installers_moved');
    await fs.rename(testInstallerDir, renamedInstallerDir);

    // 切换回安装包视图，将自动扫描并探测到根目录不可用 (409)
    await page.click('button[data-view="installer"]');

    // 页面应显示错误状态与重新关联入口
    await page.waitForSelector('.real-error-workspace');
    const errWorkspaceText = await page.textContent('.real-error-workspace');
    assert.ok(errWorkspaceText.includes('MATERIAL_ROOT_UNAVAILABLE'));
    assert.ok(errWorkspaceText.includes('重新关联目录'));
    assert.ok(errWorkspaceText.includes('重试读取'));

    // 截图 6：材料根不可访问错误态
    await page.screenshot({ path: path.join(evidenceDir, '06_material_root_unavailable.png') });

    // 根仍失效时重试应保留错误卡片，且浏览器不能抛出异步异常。
    await page.click('#btn-retry-material');
    await page.waitForSelector('.real-error-workspace');
    assert.ok((await page.textContent('.real-error-workspace')).includes('MATERIAL_ROOT_UNAVAILABLE'));

    // 点击“重新关联目录”，验证能够唤起关联向导并填入新目录
    await page.click('#btn-relink-material');
    await page.waitForSelector('#material-dialog[open]');
    await page.fill('#material-root-input', renamedInstallerDir);
    await page.click('#btn-submit-material-inspect');
    await page.waitForSelector('#btn-submit-material-confirm');
    await page.click('#btn-submit-material-confirm');
    await page.waitForSelector('#material-dialog', { state: 'hidden' });

    // 恢复正常
    await page.waitForSelector('.archive-layout');

    assert.deepEqual(pageErrors, [], '真实模式不能有未捕获的浏览器异常');
    assert.deepEqual(consoleErrors.filter((message) => !message.includes('409 (Conflict)')), [], '真实模式控制台不能有意外错误');
    assert.equal(await fingerprint(path.join(renamedInstallerDir, 'App-1.0.0-win.exe')), installerFileHash);
    assert.equal(await fingerprint(path.join(renamedInstallerDir, 'material-records.json')), installerRecordHash);
    assert.equal(await fingerprint(path.join(testUpgradeDir, 'Patch-2.0.0.upd')), upgradeFileHash);
    assert.equal(await fingerprint(path.join(testUpgradeDir, 'material-records.json')), upgradeRecordHash);
    assert.equal(execFileSync('git', ['status', '--porcelain=v1'], { cwd: testRepoDir, encoding: 'utf8' }), repoStatusBefore);

    await page.close();
  });

  test('部分扫描不误报缺失，切换材料页后旧响应不能覆盖新页面', async () => {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.querySelector('#project-select')?.value);
    const projectId = await page.inputValue('#project-select');
    const partialResponse = {
      projectId,
      kind: 'installer',
      state: 'linked',
      scan: { status: 'partial', truncated: true, reasons: ['limit_directory_entries'], entriesScanned: 1001 },
      tree: [{ type: 'directory', relativePath: 'unscanned' }],
      items: [{
        id: 'unverified-item',
        relativePath: 'unscanned/present.bin',
        physical: { exists: null, status: 'unverified', type: 'file', sizeBytes: null, mtimeMs: null },
        declaration: { state: 'unverified', targetVersion: null, revision: null },
        integrityRecord: { state: 'not-recorded', result: null },
        installationRecord: { state: 'not-recorded', result: null },
        compatibility: { state: 'not-applicable', minimumDirectSource: null },
      }],
    };
    const installerUrl = `**/api/projects/${projectId}/materials/installer`;
    await page.route(installerUrl, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(partialResponse) }));
    await page.click('button[data-view="installer"]');
    await page.waitForSelector('.archive-layout');
    const partialText = await page.textContent('#page');
    assert.ok(partialText.includes('部分扫描结果'));
    assert.ok(partialText.includes('未扫描，无法确认'));
    assert.ok(!partialText.includes('文件缺失'));
    assert.ok(!partialText.includes('空子目录'));

    await page.unroute(installerUrl);
    let releaseOldResponse;
    let markRequestStarted;
    const oldResponseStarted = new Promise((resolve) => { markRequestStarted = resolve; });
    const oldResponseReleased = new Promise((resolve) => { releaseOldResponse = resolve; });
    await page.route(installerUrl, async (route) => {
      markRequestStarted();
      await oldResponseReleased;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(partialResponse) });
    });
    await page.click('#btn-refresh-from-detail');
    await oldResponseStarted;
    await page.click('button[data-view="upgrade"]');
    await page.waitForSelector('.archive-layout');
    releaseOldResponse();
    await page.waitForTimeout(100);
    assert.ok((await page.textContent('.archive-layout')).includes('Patch-2.0.0.upd'));
    assert.ok(!(await page.textContent('.archive-layout')).includes('unscanned/present.bin'));
    assert.deepEqual(pageErrors, []);
    await page.close();
  });

  test('演示模式严格隔离：preview 模式下不调用真实 API，保持虚构演示数组', async () => {
    const page = await context.newPage();

    let apiCallsCount = 0;
    page.on('request', (req) => {
      if (req.url().includes('/api/projects')) {
        apiCallsCount++;
      }
    });

    // 拦截 index.html 模拟 npm run preview 纯静态服务行为（保留 content="preview"）
    await page.route(`http://127.0.0.1:${port}/`, async (route) => {
      const originalHtml = await fs.readFile(path.resolve('frontend/index.html'), 'utf-8');
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: originalHtml, // 磁盘源码保持 content="preview"
      });
    });

    await page.goto(`http://127.0.0.1:${port}/`);

    // 验证演示模式标记
    const appMode = await page.getAttribute('meta[name="app-mode"]', 'content');
    assert.equal(appMode, 'preview');

    // 点击安装包
    await page.click('button[data-view="installer"]');
    await page.waitForSelector('.archive-layout');
    const demoInstText = await page.textContent('.archive-layout');
    assert.ok(demoInstText.includes('虚构材料，仅用于交互体验'), '演示模式必须展示虚构材料标示');
    assert.ok(demoInstText.includes('安装包目录'));
    assert.ok(!demoInstText.includes('尚未关联安装包物理目录'));

    // 验证没有发起任何真实 API 请求
    assert.equal(apiCallsCount, 0, '演示模式绝不能调用真实后端 API');

    // 截图 7：纯演示模式保留
    await page.screenshot({ path: path.join(evidenceDir, '07_demo_mode_preserved.png') });

    await page.close();
  });

  test('P2-T04: 端到端浏览器验证候选包状态、证据来源、历史摘要本次未核验、未验收与 directFrom:null 待确认', async () => {
    // 准备 P2-T04 专属临时夹具
    const t04Base = await fs.mkdtemp(path.join(os.tmpdir(), 'p2-t04-e2e-'));
    const t04InstDir = path.join(t04Base, 'installer_repo');
    const t04UpgDir = path.join(t04Base, 'upgrade_repo');
    await fs.mkdir(t04InstDir, { recursive: true });
    await fs.mkdir(t04UpgDir, { recursive: true });

    // 1. 安装包文件与无 platform、仅 sizeBytes、sha256 历史摘要记录
    const dummyApp = path.join(t04InstDir, 'mock-candidate-app.zip');
    const appContent = 'candidate app binary content';
    await fs.writeFile(dummyApp, appContent);
    const appStat = await fs.stat(dummyApp);

    const instRecords = {
      schemaVersion: 1,
      records: [
        {
          kind: 'installer',
          file: 'mock-candidate-app.zip',
          targetVersion: '0.2.6',
          revision: 'r2-fix1',
          releaseStatus: 'candidate',
          evidenceSource: 'notes/release-record.json',
          recordedFile: {
            sizeBytes: appStat.size,
            sha256: 'f6a65fb6b81845d61a2dfdf1b1f2888bfb4ab5448f00d8cbc5a6bf4691c88acc',
          },
          // 省略 integrityRecord 和 installationRecord，由解析器填充 not-recorded
        },
      ],
    };
    await fs.writeFile(path.join(t04InstDir, 'material-records.json'), JSON.stringify(instRecords, null, 2));

    // 2. 升级包文件与 directFrom: null、revision: null 记录
    const dummyPatch = path.join(t04UpgDir, 'mock-candidate-patch.zip');
    const patchContent = 'candidate patch binary content';
    await fs.writeFile(dummyPatch, patchContent);
    const patchStat = await fs.stat(dummyPatch);

    const upgRecords = {
      schemaVersion: 1,
      records: [
        {
          kind: 'upgrade',
          file: 'mock-candidate-patch.zip',
          targetVersion: '0.2.6',
          revision: null,
          releaseStatus: 'candidate',
          evidenceSource: 'upgrade-notes/release-record.json',
          directFrom: null,
          recordedFile: {
            sizeBytes: patchStat.size,
            sha256: '35798a02b314cac9b7049a7b71d9b39a968117f5931788ae4b71db92598a0291',
          },
        },
      ],
    };
    await fs.writeFile(path.join(t04UpgDir, 'material-records.json'), JSON.stringify(upgRecords, null, 2));

    // 3. 为 T04 创建专门的测试 Git 仓库，确保初次接入材料处于 unlinked 干净态
    const t04RepoDir = path.join(t04Base, 't04_repo');
    await fs.mkdir(t04RepoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: t04RepoDir });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: t04RepoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: t04RepoDir });
    await fs.writeFile(path.join(t04RepoDir, 'readme.txt'), 'repo for t04');
    execFileSync('git', ['add', '.'], { cwd: t04RepoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: t04RepoDir });

    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      
      // 接入新测试项目
      await page.click('#btn-open-onboard');
      await page.waitForSelector('#onboard-dialog[open]');
      await page.fill('#onboard-path', t04RepoDir);
      await page.fill('#onboard-name', 'T04事实层测试项目');
      await page.click('#btn-inspect-submit');
      await page.waitForSelector('#onboard-confirm-form');
      await page.click('#btn-confirm-submit');
      await page.waitForSelector('#onboard-dialog', { state: 'hidden' });

      // 切换至安装包视图（新项目初始处于 unlinked 态）
      await page.click('button[data-view="installer"]');
      await page.waitForSelector('.material-unlinked-box');
      await page.click('#btn-open-material-dialog');
      await page.waitForSelector('#material-dialog[open]');
      await page.fill('#material-root-input', t04InstDir);
      await page.click('#btn-submit-material-inspect');
      await page.waitForSelector('#btn-submit-material-confirm');
      await page.click('#btn-submit-material-confirm');
      await page.waitForSelector('#material-dialog', { state: 'hidden' });

      // 等待安装包树渲染并选中条目
      await page.waitForSelector('.archive-layout');
      const instTreeText = await page.textContent('.archive-layout');
      assert.ok(instTreeText.includes('mock-candidate-app.zip'));

      const instDetailText = await page.textContent('[aria-label="材料详情"]');
      // 检查 T04 关键事实分层
      assert.ok(instDetailText.includes('候选包 (candidate)'), '必须中性展示候选包状态');
      assert.ok(instDetailText.includes('notes/release-record.json'), '必须展示证据来源相对路径');
      assert.ok(instDetailText.includes('历史登记摘要，本次未核验当前文件'), '必须声明历史登记哈希摘要且本次未核验');
      assert.ok(instDetailText.includes('尚未核验 / 无记录'), '未登记完整性记录时必须显示尚未核验/无记录');
      assert.ok(instDetailText.includes('尚未验证 / 无记录'), '未登记安装验证时必须显示尚未验证/无记录');

      // 关联 T04 升级包目录
      await page.click('button[data-view="upgrade"]');
      await page.waitForSelector('.material-unlinked-box');
      await page.click('#btn-open-material-dialog');
      await page.waitForSelector('#material-dialog[open]');
      await page.fill('#material-root-input', t04UpgDir);
      await page.click('#btn-submit-material-inspect');
      await page.waitForSelector('#btn-submit-material-confirm');
      await page.click('#btn-submit-material-confirm');
      await page.waitForSelector('#material-dialog', { state: 'hidden' });

      // 等待升级包树渲染
      await page.waitForSelector('.archive-layout');
      const upgTreeText = await page.textContent('.archive-layout');
      assert.ok(upgTreeText.includes('mock-candidate-patch.zip'));
      assert.ok(upgTreeText.includes('待确认'), 'directFrom 为 null 时树上必须展示待确认');

      const upgDetailText = await page.textContent('[aria-label="材料详情"]');
      assert.ok(upgDetailText.includes('待确认：未声明直接升级来源'), '详情中必须展示待确认未声明直接升级来源');
      assert.ok(upgDetailText.includes('候选包 (candidate)'));
      assert.ok(upgDetailText.includes('upgrade-notes/release-record.json'));
      assert.ok(upgDetailText.includes('历史登记摘要，本次未核验当前文件'));
      assert.ok(upgDetailText.includes('尚未验证 / 无记录'));

      // 截图 8：T04 事实层端到端交互
      await page.screenshot({ path: path.join(evidenceDir, '08_t04_facts_layer.png') });

      assert.deepEqual(pageErrors, [], 'T04 事实层浏览器测试不能抛出未捕获脚本错误');
      assert.deepEqual(consoleErrors, [], 'T04 事实层控制台不能有错误');
    } finally {
      await page.close();
      await fs.rm(t04Base, { recursive: true, force: true });
    }
  });
});


