import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateAndParseProjects, loadProjectsConfig, confirmAndSaveMaterialAssociation, ConfigError } from '../server/config.js';

describe('配置读取与解析模块测试', () => {
  test('空数组配置视为未配置', () => {
    const result = validateAndParseProjects({ projects: [] });
    assert.equal(result.configured, false);
    assert.deepEqual(result.projects, []);
    assert.equal(result.projectMap.size, 0);
  });

  test('根节点非对象抛出 ConfigError', () => {
    assert.throws(() => validateAndParseProjects(null), ConfigError);
    assert.throws(() => validateAndParseProjects([]), ConfigError);
    assert.throws(() => validateAndParseProjects('string'), ConfigError);
  });

  test('缺少 projects 字段或 projects 非数组抛出 ConfigError', () => {
    assert.throws(() => validateAndParseProjects({}), ConfigError);
    assert.throws(() => validateAndParseProjects({ projects: 'invalid' }), ConfigError);
  });

  test('合法配置解析并脱敏，项目列表不泄露绝对路径', () => {
    const absPath = path.resolve('dummy/repo');
    const result = validateAndParseProjects({
      projects: [
        { id: 'proj_1', name: '  示例项目1  ', repositoryPath: absPath },
        { id: 'proj-2', name: '示例项目2', repositoryPath: absPath },
      ],
    });

    assert.equal(result.configured, true);
    assert.equal(result.projects.length, 2);
    // 对外项目列表只暴露 id 和 name (且去空格)
    assert.deepEqual(result.projects[0], { id: 'proj_1', name: '示例项目1' });
    assert.deepEqual(result.projects[1], { id: 'proj-2', name: '示例项目2' });
    assert.equal(result.projects[0].repositoryPath, undefined);

    // 服务端映射保留绝对路径
    const mapped = result.projectMap.get('proj_1');
    assert.ok(mapped);
    assert.equal(mapped.repositoryPath, path.normalize(absPath));
  });

  test('重复 ID 抛出 ConfigError', () => {
    const absPath = path.resolve('dummy/repo');
    assert.throws(() => {
      validateAndParseProjects({
        projects: [
          { id: 'sample', name: '项目1', repositoryPath: absPath },
          { id: 'sample', name: '项目2', repositoryPath: absPath },
        ],
      });
    }, (err) => err instanceof ConfigError && err.message.includes('重复'));
  });

  test('非法 ID 格式抛出 ConfigError', () => {
    const absPath = path.resolve('dummy/repo');
    const invalidIds = [
      'Sample', // 大写
      '1project', // 数字开头
      '_project', // 下划线开头
      '-project', // 中划线开头
      'proj space', // 空格
      'a'.repeat(33), // 超过32位
      '',
    ];

    for (const id of invalidIds) {
      assert.throws(() => {
        validateAndParseProjects({
          projects: [{ id, name: '测试', repositoryPath: absPath }],
        });
      }, ConfigError, `ID "${id}" 应当被判定为非法`);
    }
  });

  test('非法 Name 格式抛出 ConfigError', () => {
    const absPath = path.resolve('dummy/repo');
    const invalidNames = [
      '',
      '   ',
      'a'.repeat(81), // 超过 80 字符
      123,
    ];

    for (const name of invalidNames) {
      assert.throws(() => {
        validateAndParseProjects({
          projects: [{ id: 'sample', name, repositoryPath: absPath }],
        });
      }, ConfigError);
    }
  });

  test('非绝对路径抛出 ConfigError', () => {
    const relativePaths = [
      'relative/path',
      './sub/repo',
      '../parent/repo',
    ];

    for (const repositoryPath of relativePaths) {
      assert.throws(() => {
        validateAndParseProjects({
          projects: [{ id: 'sample', name: '测试', repositoryPath }],
        });
      }, (err) => err instanceof ConfigError && err.message.includes('绝对路径'));
    }
  });

  test('空路径或非字符串路径抛出 ConfigError', () => {
    const invalidPaths = ['', '   ', null, 123];
    for (const repositoryPath of invalidPaths) {
      assert.throws(() => {
        validateAndParseProjects({
          projects: [{ id: 'sample', name: '测试', repositoryPath }],
        });
      }, ConfigError);
    }
  });

  test('loadProjectsConfig 文件不存在时返回未配置', async () => {
    const nonExistent = path.join(os.tmpdir(), `non_existent_config_${Date.now()}.json`);
    const result = await loadProjectsConfig(nonExistent);
    assert.equal(result.configured, false);
    assert.deepEqual(result.projects, []);
  });

  test('loadProjectsConfig 文件损坏时抛出 ConfigError', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-test-'));
    const badFile = path.join(tempDir, 'broken.json');
    await fs.writeFile(badFile, 'INVALID JSON {]');
    try {
      await assert.rejects(async () => {
        await loadProjectsConfig(badFile);
      }, ConfigError);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('acquireConfigLock 与 releaseConfigLock 互斥生效', async () => {
    const { acquireConfigLock, releaseConfigLock } = await import('../server/config.js');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
    const lockPath = path.join(tempDir, 'projects.lock');
    try {
      await acquireConfigLock(lockPath);
      // 试图再次获取同一个锁应超时抛出 CONFIG_BUSY
      await assert.rejects(async () => {
        await acquireConfigLock(lockPath);
      }, (err) => err instanceof ConfigError && err.code === 'CONFIG_BUSY');

      await releaseConfigLock(lockPath);
      // 释放后应能再次获取
      await acquireConfigLock(lockPath);
      await releaseConfigLock(lockPath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('acquireConfigLock 初始化刷新失败时不留孤儿锁', async () => {
    const { acquireConfigLock, releaseConfigLock } = await import('../server/config.js');
    const fsPromises = await import('node:fs/promises');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-orphan-test-'));
    const lockPath = path.join(tempDir, 'projects.lock');

    const origOpen = fsPromises.default.open;
    // 注入 sync 失败
    fsPromises.default.open = async function (...args) {
      const handle = await origOpen.apply(this, args);
      handle.sync = async function () {
        throw new Error('injected sync failure');
      };
      return handle;
    };

    try {
      await assert.rejects(async () => {
        await acquireConfigLock(lockPath);
      }, (err) => err instanceof ConfigError && err.code === 'CONFIG_SAVE_FAILED');

      // 验证锁文件未留在磁盘上
      let lockExists = false;
      try {
        await fs.stat(lockPath);
        lockExists = true;
      } catch {}
      assert.equal(lockExists, false, '初始化失败时不应遗留孤儿锁文件');

      // 恢复 open 后，后续请求能够立即成功获锁，不受阻塞
      fsPromises.default.open = origOpen;
      await acquireConfigLock(lockPath);
      await releaseConfigLock(lockPath);
    } finally {
      fsPromises.default.open = origOpen;
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  describe('P2-T01: 材料目录配置与保存测试', () => {
    test('合法 materials 配置解析成功且项目列表脱敏，projectMap 保留 materials 与未知键', () => {
      const absRepo = path.resolve('dummy/repo');
      const absInstaller = path.resolve('dummy/installer');
      const absUpgrade = path.resolve('dummy/upgrade');

      const raw = {
        metaVersion: 1,
        projects: [
          {
            id: 'proj_materials',
            name: '材料测试项目',
            repositoryPath: absRepo,
            customField: 'preserved_data',
            materials: {
              installer: { root: absInstaller },
              upgrade: { root: absUpgrade },
            },
          },
        ],
      };

      const result = validateAndParseProjects(raw);
      assert.equal(result.configured, true);
      assert.equal(result.projects.length, 1);
      assert.deepEqual(result.projects[0], { id: 'proj_materials', name: '材料测试项目' });
      assert.equal(result.projects[0].materials, undefined);

      const mapped = result.projectMap.get('proj_materials');
      assert.ok(mapped);
      assert.equal(mapped.customField, 'preserved_data');
      assert.deepEqual(mapped.materials, {
        installer: { root: path.normalize(absInstaller) },
        upgrade: { root: path.normalize(absUpgrade) },
      });
    });

    test('解析后的规范化材料根真实生效（如 a/../b 归一），绝不被原始 extra 覆盖，且保留原始未知键', () => {
      const absRepo = path.resolve('dummy/repo');
      const unnormalizedRoot = path.resolve('dummy') + path.sep + 'sub' + path.sep + '..' + path.sep + 'installer_norm';
      assert.ok(unnormalizedRoot.includes('..'), '测试输入必须保留未归一化的路径段');
      const raw = {
        projects: [
          {
            id: 'proj_norm',
            name: '规范化测试项目',
            repositoryPath: absRepo,
            unknownProp: 'keep_me',
            materials: {
              installer: { root: unnormalizedRoot },
            },
          },
        ],
      };

      const result = validateAndParseProjects(raw);
      const mapped = result.projectMap.get('proj_norm');
      assert.ok(mapped);
      assert.equal(mapped.unknownProp, 'keep_me', '未知原始键必须完整保留');
      assert.equal(mapped.materials.installer.root.includes('..'), false, '根路径不应包含 ..');
      assert.equal(mapped.materials.installer.root, path.normalize(unnormalizedRoot));
    });

    test('损坏或不合规的 materials 字段抛出 ConfigError', () => {
      const absRepo = path.resolve('dummy/repo');
      const invalidCases = [
        { materials: 'not_an_object' },
        { materials: [] },
        { materials: null },
        { materials: { unknown_kind: { root: absRepo } } },
        { materials: { installer: 'not_an_object' } },
        { materials: { installer: { root: 'relative/path' } } },
        { materials: { installer: { root: '' } } },
        { materials: { installer: { root: absRepo, extraKey: 1 } } },
        { materials: { upgrade: { root: null } } },
      ];

      for (const invalid of invalidCases) {
        assert.throws(() => {
          validateAndParseProjects({
            projects: [
              {
                id: 'bad_materials',
                name: '测试项目',
                repositoryPath: absRepo,
                ...invalid,
              },
            ],
          });
        }, ConfigError);
      }
    });

    test('confirmAndSaveMaterialAssociation 成功保存、幂等确认、并发冲突与故障保护', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mat-cfg-test-'));
      const configPath = path.join(tempDir, 'projects.json');
      const absRepo = path.resolve('dummy/repo');
      const absMat1 = path.resolve('dummy/installer_v1');
      const absMat2 = path.resolve('dummy/installer_v2');

      const initialConfig = {
        unknownRootKey: 'preserved_root_meta',
        projects: [
          {
            id: 'proj_test',
            name: '测试项目',
            repositoryPath: absRepo,
            extraProjKey: 'preserved_proj_meta',
          },
        ],
      };
      await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), 'utf-8');

      try {
        // 1. 首次关联
        const ticket1 = {
          projectId: 'proj_test',
          kind: 'installer',
          normRoot: absMat1,
          existingRootAtInspection: null,
        };
        const res1 = await confirmAndSaveMaterialAssociation({ configPath, ticket: ticket1 });
        assert.equal(res1.alreadyAssociated, false);
        assert.deepEqual(res1.association, { projectId: 'proj_test', kind: 'installer', linked: true });

        // 验证磁盘文件保留了原有未知键与 Git 路径
        const content1 = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        assert.equal(content1.unknownRootKey, 'preserved_root_meta');
        assert.equal(content1.projects[0].extraProjKey, 'preserved_proj_meta');
        assert.equal(content1.projects[0].materials.installer.root, absMat1);

        // 2. 幂等确认：同一根再次确认，不重复落盘且返回 alreadyAssociated: true
        const statBefore = await fs.stat(configPath);
        const resIdempotent = await confirmAndSaveMaterialAssociation({ configPath, ticket: ticket1 });
        assert.equal(resIdempotent.alreadyAssociated, true);
        const statAfter = await fs.stat(configPath);
        assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);

        // 3. 更换关联但未显式指定 replaceExisting: true，拒绝 409 MATERIAL_CONFLICT
        const ticket2 = {
          projectId: 'proj_test',
          kind: 'installer',
          normRoot: absMat2,
          existingRootAtInspection: absMat1,
        };
        await assert.rejects(async () => {
          await confirmAndSaveMaterialAssociation({ configPath, ticket: ticket2, replaceExisting: false });
        }, (err) => err instanceof ConfigError && err.code === 'MATERIAL_CONFLICT');

        // 4. 更换关联并显式指定 replaceExisting: true，成功替换
        const resReplace = await confirmAndSaveMaterialAssociation({ configPath, ticket: ticket2, replaceExisting: true });
        assert.equal(resReplace.alreadyAssociated, false);
        const content2 = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        assert.equal(content2.projects[0].materials.installer.root, absMat2);

        // 5. 并发冲突：检查时的旧关联与当前磁盘不一致时，拒绝 409 MATERIAL_CONFLICT
        const staleTicket = {
          projectId: 'proj_test',
          kind: 'installer',
          normRoot: absMat1,
          existingRootAtInspection: absMat1, // 但磁盘上现在是 absMat2
        };
        await assert.rejects(async () => {
          await confirmAndSaveMaterialAssociation({ configPath, ticket: staleTicket, replaceExisting: true });
        }, (err) => err instanceof ConfigError && err.code === 'MATERIAL_CONFLICT');

        // 6. 模拟写入故障：旧内容完整保留且临时文件与锁无残留
        const filesBefore = await fs.readdir(tempDir);
        await assert.rejects(async () => {
          await confirmAndSaveMaterialAssociation({
            configPath,
            ticket: {
              projectId: 'proj_test',
              kind: 'upgrade',
              normRoot: absMat1,
              existingRootAtInspection: null,
            },
            _simulateWriteFailure: true,
          });
        }, (err) => err instanceof ConfigError && err.code === 'CONFIG_SAVE_FAILED');

        const filesAfter = await fs.readdir(tempDir);
        assert.deepEqual(filesAfter.sort(), filesBefore.sort(), '不应遗留临时文件或锁文件');
        const contentUnchanged = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        assert.equal(contentUnchanged.projects[0].materials.upgrade, undefined, '失败时不应产生部分写入');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
  });
});



