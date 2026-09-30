/**
 * 真实材料根独立只读盘点与草稿核对脚本
 * 
 * 仅供显式只读检查使用，不作为 npm test 常规自动化单元测试回归。
 * 绝不向真实物理目录写入任何文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  console.log('=== P2 真实材料目录只读盘点与草稿核对 ===');
  const realInstallerRoot = 'D:\\王凯歌工作文件\\软件代码管理\\进销存\\安装包区';
  const realUpgradeRoot = 'D:\\王凯歌工作文件\\软件代码管理\\进销存\\升级包区';

  // 1. 验证目标文件当前不存在
  const installerTarget = path.join(realInstallerRoot, 'material-records.json');
  const upgradeTarget = path.join(realUpgradeRoot, 'material-records.json');

  let installerTargetExists = true;
  try {
    await fs.access(installerTarget);
  } catch {
    installerTargetExists = false;
  }
  console.log(`[目标文件检查] 安装包区目标文件是否存在: ${installerTargetExists} (预期: false)`);

  let upgradeTargetExists = true;
  try {
    await fs.access(upgradeTarget);
  } catch {
    upgradeTargetExists = false;
  }
  console.log(`[目标文件检查] 升级包区目标文件是否存在: ${upgradeTargetExists} (预期: false)`);

  // 2. 检查引用的物理文件大小与存在性
  const checks = [
    {
      root: realInstallerRoot,
      rel: 'install-v0.2.6-r2-fix1/inventory-ai-v0.2.6-installer-r2-fix1.zip',
      expectedSize: 827978577,
      expectedSha: 'f6a65fb6b81845d61a2dfdf1b1f2888bfb4ab5448f00d8cbc5a6bf4691c88acc',
    },
    {
      root: realInstallerRoot,
      rel: 'install-0.2.6-c4-20260926-r2/inventory-ai-v0.2.6-installer-r2.zip',
      expectedSize: 827962406,
      expectedSha: '3729c4eaf73e82a7f6591b7b4bd155b18f82a9b2a1e6de190adbbcf08f0c2d11',
    },
    {
      root: realUpgradeRoot,
      rel: 'upgrade-rc9-to-c4-20260924-d/inventory-ai-v0.2.6-upgrade-rc9-to-c4-d.zip',
      expectedSize: 5779379,
      expectedSha: '35798a02b314cac9b7049a7b71d9b39a968117f5931788ae4b71db92598a0291',
    },
  ];

  for (const item of checks) {
    const fullPath = path.join(item.root, item.rel);
    try {
      const st = await fs.stat(fullPath);
      const sizeMatch = st.size === item.expectedSize;
      console.log(`[物理ZIP核对] ${item.rel}`);
      console.log(`  - 存在: true`);
      console.log(`  - 实际大小: ${st.size}, 草稿预期大小: ${item.expectedSize}, 匹配: ${sizeMatch}`);
      if (!sizeMatch) {
        console.error(`  [ERROR] 文件大小不匹配！`);
      }
    } catch (err) {
      console.error(`[物理ZIP核对] 无法读取 ${fullPath}: ${err.message}`);
    }
  }

  console.log('=== 盘点完成 (只读，未产生任何写入) ===');
}

main().catch(console.error);
