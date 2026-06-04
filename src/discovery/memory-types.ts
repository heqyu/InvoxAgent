// 记忆系统的类型定义。
//
// 设计目标：把"塞给 LLM 的静态记忆"抽象成可拓展的来源（provider）。
// 当前内置只有一个：CLAUDE.md（user + project 两级）。未来可加：
//   - 会话级笔记（session-notes）
//   - 长程记忆（longterm，跨会话索引）
//   - RAG 检索（rag，按 query 动态拉取）
//
// 抽象边界：
//   - MemoryProvider —— 一个记忆来源的实现，向 discovery 提供 collect()
//   - MemorySection  —— provider 产出的单条记忆条目，多 provider 的输出由
//     discoverDirs() 合并 + 排序后塞进 DiscoveryResult.memories
//
// 一律放在 discovery 子系统下：因为 memories 与 plugins/skills/hooks 一样
// 是「讲给 LLM 听的项目知识」的一部分，源头与寻找方式都属于 discovery 关心
// 的范畴 —— 调用方拿一份 DiscoveryResult 就拿到全部，不必再各自扫盘。

/**
 * 一条记忆条目 —— provider 的产出物，最终拼到 system message。
 *
 * 字段语义：
 *   provider —— 来源 provider 标识（"claude-md" / "session-notes" / ...）
 *   source   —— 在该 provider 内的二级来源（"user" / "project" / ...）
 *   origin   —— 调试用的来源标识（通常是文件绝对路径）
 *   content  —— 已渲染的纯文本（如已展开 @reference）
 *   priority —— 拼装顺序权重，**越小越靠前**。约定：
 *     10 = user-level（个人偏好）
 *     20 = project-level（项目规则）
 *     50 = session-level（短期记忆）
 *     90 = retrieved（动态检索结果，最贴近当前 query）
 */
export interface MemorySection {
  provider: string;
  source: string;
  origin: string;
  content: string;
  priority: number;
}

/**
 * 记忆来源的 provider 接口。
 *
 * 当前 v1：只支持 collect() —— 静态全量收集，每次 discoverDirs(cwd) 调用一次。
 * 后续 v2 计划加 retrieve(query) —— 按当前 user 输入动态检索的钩子，
 * 在每个 user turn 前由 prompt-loop 调用并以 ephemeral 形式注入。
 */
export interface MemoryProvider {
  /** provider 唯一标识，用于过滤、调试、配置开关。 */
  name: string;

  /**
   * 同步收集本 provider 提供的全部静态记忆。
   *
   * 入参 ctx 提供已解析好的 user/project 目录路径，避免每个 provider
   * 各自再去算一遍 ~/.claude 与 <cwd>/.claude。
   *
   * 异常应自行 catch + 记日志后返回 []，不要把整个 discovery 流程拖崩。
   */
  collect(ctx: MemoryProviderContext): MemorySection[];
}

/** collect() 的入参 —— 已经解析好的目录上下文。 */
export interface MemoryProviderContext {
  /** 当前工作区根目录（与 discoverDirs 入参一致）。 */
  cwd: string;
  /** ~/.claude 绝对路径（无论是否存在）。 */
  userDir: string;
  /** <cwd>/.claude 绝对路径（无论是否存在）。 */
  projectDir: string;
}
