// 项目级配置加载：读 .invox/invox.env 并合并到 process.env。
//
// .env 格式（零依赖原生支持）：
//   KEY=value          ← 设置
//   # 注释             ← 整行注释
//   KEY=               ← 空值（视为未设置，跳过）
//   KEY="带空格的值"   ← 支持引号包裹
//
// 优先级（高 → 低）：
//   1. 操作系统 / 宿主进程的环境变量（如 Zed settings.json 的 env 块）
//   2. .invox/invox.env
//   3. 代码中的硬编码默认值（各模块的 ?? "xxx"）
//
// 只有 process.env 中未设置的键才会被注入，不会覆盖用户显式设置的值。
// 配置文件缺失或解析失败仅 warn，不阻断启动。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 从 .invox/invox.env 加载项目级默认配置。
 * @param cwd 工作目录，通常是 process.cwd()
 */
export function loadProjectSettings(cwd: string): void {
  const file = join(cwd, ".invox", "invox.env");
  if (!existsSync(file)) return;

  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    process.stderr.write(
      `[settings] cannot read ${file}: ${(err as Error).message}\n`,
    );
    return;
  }

  let count = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith("#")) continue;
    // 解析 KEY=VALUE（支持 KEY="value with spaces"）
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue; // 无 = 或 key 为空 → 跳过

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // 去掉引号包裹
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 空值视为未设置，跳过
    if (value === "") continue;

    // 已有的 env 不覆盖（宿主进程设置的优先级更高）
    if (key in process.env) continue;

    process.env[key] = value;
    count++;
  }

  if (count > 0) {
    process.stderr.write(
      `[settings] loaded ${count} setting(s) from ${file}\n`,
    );
  }
}
