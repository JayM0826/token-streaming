# Token Streaming: Codex Development Brief

## 1. 一句话定位

Token Streaming 是一个 CLI-first 的 Agentic Coding Runtime。它不训练大模型，而是把商业模型、仓库结构、工具执行、补丁、安全权限、测试反馈、检查点和多 Agent 协作编排成一个可控、可验证、可扩展的软件工程系统。

它的核心价值不是“又做一个聊天壳”，而是让不同商业模型在真实代码仓库里被用到最优：

- 知道每个模型适合做什么、不适合做什么。
- 在成本优先和效果优先之间显式切换。
- 让 Agent 理解项目结构、业务流程和修改边界。
- 所有代码改动都经过权限、补丁、测试、审查、回滚闭环。
- 先做 CLI，但核心能力不绑定 CLI，未来可复用到 Desktop App、Web Console、CI Bot。

## 2. 为什么这件事有价值

商业大模型越来越强，但真实软件工程的瓶颈不只是“模型会不会写代码”，而是：

- 模型不知道仓库里的隐含关系。
- 模型不知道哪些文件危险、哪些命令危险。
- 模型不知道项目团队的架构约束和命名习惯。
- 模型不知道一个需求会横跨哪些模块和业务流程。
- 模型不知道什么时候该省钱、什么时候该用强模型。
- 模型执行过程不可审计，失败后难以复盘。

Token Streaming 要解决的是“模型能力到工程结果”的最后一公里。

一句话：

> AI 不怕代码多，怕上下文关系隐含。

我们的产品把隐含关系显式化，把模型调用工程化，把代码修改流程产品化。

## 3. 产品护城河

### 3.1 模型能力边界知识

我们不把所有任务都丢给最贵模型，而是沉淀模型使用策略：

- 低风险理解、搜索、总结任务走便宜模型。
- 架构决策、复杂补丁、失败修复、最终审查走强模型。
- 通过 telemetry 统计每个模型在不同任务上的成功率、成本代理、响应规模和失败率，并沉淀为可审计的 `prefer` / `watch` / `avoid` recommendation。
- 模型路由可以在有任务文本时推断任务类型，并把匹配的 recommendation 作为有界反馈接入评分；CLI 显式 `--model` 仍保持最高优先级。

这会形成一个持续积累的 model-operation layer。

### 3.2 Agent-Native Repository 标准

我们定义一层标准中间层，让 Agent 能理解任意项目：

```text
.ai/
  project.md
  conventions.md
  architecture.md
  commands.yaml
  tests.yaml
  safety.yaml
  ownership.yaml
  glossary.md
  playbooks/
    add-api-endpoint.md
    fix-failing-test.md
```

对我们自己生成的项目，严格遵守这个标准。

对外部接手的项目，通过 scanner 和 generator 生成映射层：

```text
.ai/generated/
  architecture.md
  commands.yaml
  tests.yaml
```

这个标准既服务 AI，也服务新人 onboarding。

### 3.3 模块和工作流双视角

传统代码结构通常按模块聚合：

```text
src/modules/auth/
src/modules/payment/
src/modules/order/
```

但真实需求通常按业务任务出现：

```text
修复 checkout 支付失败时库存没有释放的问题
```

所以 Token Streaming 同时支持：

- `module.yaml`: 描述模块职责、公共接口、依赖、测试入口、修改规则。
- `flow.yaml`: 描述业务流程、涉及模块、步骤、测试入口、风险点。

推荐结构：

```text
src/
  modules/
    payment/
      README.md
      module.yaml
      api.ts
      service.ts
      tests/

  workflows/
    checkout/
      README.md
      flow.yaml
      checkout.service.ts
      tests/
```

Agent 接任务时不是只看文件，而是先理解“这个需求属于哪个模块、哪个业务流程、哪些测试能验证”。

### 3.4 安全可控的执行闭环

Token Streaming 的修改流程必须是可控的：

```text
任务
-> 构建上下文
-> 生成执行计划
-> 模型输出结构化补丁
-> 权限检查
-> 创建 checkpoint
-> 应用 patch
-> 运行测试
-> 失败修复
-> reviewer 总结
-> 生成报告
```

每次运行都要有：

- session event log
- patch proposal
- permission decision
- checkpoint id
- verification result
- review summary
- final report

这使系统可以审计、复盘、回滚，也使未来 Desktop App 可以直接展示执行过程。

## 4. 技术方案

### 4.1 技术栈

推荐从第一天使用 TypeScript monorepo：

- Runtime: Node.js 22 LTS
- Package manager: pnpm workspace
- Language: TypeScript
- Test: Node test runner or Vitest
- CLI: 自研轻量 parser 或 Commander
- Schema: Zod 或轻量自定义 validator
- Storage: JSONL event log + 本地文件 checkpoint
- Provider: OpenAI / Anthropic / Google 等商业模型适配器

先不要引入复杂数据库、队列、向量库和桌面 UI。

### 4.2 目录结构

```text
apps/
  cli/

packages/
  core/
    session/
    strategy/
    context/
    permissions/
    runtime/

  protocol/
    types.ts
    events.ts

  providers/
    openai-provider.ts
    stub-provider.ts
    model-policy.ts

  tools/
    repo-scanner.ts
    filesystem.ts
    search.ts
    shell.ts
    git.ts
    patch-engine.ts
    test-runner.ts
    catalog.ts

  storage/
    event-log.ts
    checkpoint-store.ts
    run-report-store.ts
    session-history-store.ts
    telemetry-store.ts

  ai-manifest/
    loader.ts
    generator.ts
    validator.ts
    commands.ts
    playbooks.ts

src/
  workflows/
    agent-run/
      README.md
      flow.yaml

docs/
  architecture.md
  implementation-plan.md
```

### 4.3 Headless Core

CLI 只是第一个 host。核心 runtime 不应该依赖终端交互。

核心对外暴露：

- `runTask(input): RunTaskResult`
- `planTask(input): ExecutionPlan`
- `inspectContext(input): ContextBundle`
- `validateManifest(repo): ManifestValidationResult`
- `listTools(): ToolDefinition[]`
- `runTool(input): ToolRunResult`
- `rollback(checkpointId): RollbackResult`

未来 Desktop App 只需要复用这些 API 和事件流。

## 5. Agent 编排设计

### 5.1 不要一启动就初始化所有 Agent

V1 不做永久 swarm。

推荐模式：

```text
Primary Orchestrator 常驻
Specialized Agents 按需激活
```

原因：

- 启动快。
- 成本低。
- 状态简单。
- 容易审计。
- 不会一开始就陷入复杂 agent 通信协议。

### 5.2 V1 的多 Agent 形式

V1 中的多 Agent 可以先是“角色阶段”，不一定是独立进程：

- `orchestrator`: 任务拆解、策略选择、上下文预算。
- `researcher`: 仓库扫描、模块/工作流定位、证据收集。
- `coder`: 输出结构化 patch proposal。
- `tester`: 选择并执行验证命令。
- `reviewer`: 审查 diff、风险、测试结果、是否建议继续。

执行计划中要显式记录 handoff：

```text
researcher -> coder: context brief
coder -> tester: patch summary and touched files
tester -> reviewer: verification result
reviewer -> orchestrator: final recommendation
```

这样今天可以用单进程实现，明天可以替换成真正多 worker。

## 6. 策略层和产品模式

### 6.1 Strategy 是编排方式

策略决定“怎么组织工作”：

- `default`: 通用编码任务。
- `debug`: 未来用于失败测试和线上 bug。
- `review`: 未来用于 PR review。
- `refactor`: 未来用于大规模重构。
- `manifest`: 未来用于生成和修复 `.ai/` 元信息。

V1 只实现 `default`，但接口必须保留：

```ts
export interface OrchestrationStrategy {
  id: string;
  createPlan(input: StrategyInput): Promise<ExecutionPlan>;
}
```

CLI 应支持：

```bash
token-streaming --strategy default "fix failing checkout test"
token-streaming strategies list --json
```

### 6.2 Mode 是成本/效果姿态

产品模式决定“用多强的模型、多重的验证”：

- `economy`: 小模型优先，适合日常轻任务。
- `max`: 强模型规划和审查，适合复杂任务。
- `auto`: 根据风险自动切换，未来默认模式。

V1 可以只做接口和最小行为差异，不要过早复杂化。

```bash
token-streaming --mode economy "explain this module"
token-streaming --mode max "refactor payment provider"
```

### 6.3 Strategy 和 Mode 的区别

```text
strategy = 工作流怎么编排
mode = 资源怎么投入
```

例如：

- `default + economy`: 普通任务，少量上下文，低成本模型。
- `default + max`: 普通任务，但使用强模型和更严格验证。
- `debug + max`: 未来复杂调试专用流程。

## 7. V1 范围

### 7.1 必须实现

- CLI host。
- Headless core。
- Session Manager。
- Repo Scanner。
- `.ai/` manifest loader。
- 外部项目 fallback manifest generator。
- Context Builder。
- Default Strategy。
- Tool Runtime。
- Permission System。
- Patch Engine。
- Command Runner。
- Test Feedback。
- Checkpoint / Rollback。
- Event Log。
- Run Report。
- Model Provider interface。
- Stub provider for tests。
- OpenAI provider adapter。
- Strategy extension point。
- Mode extension point。
- Module manifest and workflow manifest support。

### 7.2 暂不实现

- 完整 Desktop App。
- 多策略生产级实现。
- 真正分布式多 Agent。
- 向量数据库。
- 企业权限后台。
- 插件市场。
- 云端同步。

这些都留接口，不进入第一阶段复杂度。

## 8. CLI 命令建议

```bash
token-streaming "summarize this repo"
token-streaming --json "summarize this repo"
token-streaming --provider openai --model <model> "fix failing test"
token-streaming --strategy default --mode economy "explain auth module"
token-streaming --strategy default --mode max "refactor payment provider"

token-streaming plan "fix checkout payment failure"
token-streaming context inspect "fix checkout payment failure"
token-streaming manifest init
token-streaming manifest generate
token-streaming manifest inspect
token-streaming manifest validate

token-streaming tools list
token-streaming tools run repo.scan --json
token-streaming tools run repo.search --json --input-file input.json

token-streaming verify
token-streaming diff
token-streaming sessions list
token-streaming sessions show latest
token-streaming reports show latest
token-streaming checkpoints list
token-streaming rollback latest --dry-run
token-streaming doctor repo
token-streaming doctor models
token-streaming stats models
```

## 9. 验收标准

V1 完成时，应该满足：

- 新仓库可以 `manifest init` 生成 `.ai/` 标准。
- 外部仓库可以 `manifest generate` 生成 fallback 映射。
- `plan` 可以展示任务阶段、需要的 role、上下文和测试命令。
- `context inspect` 可以解释为什么选中这些模块/文件/流程。
- 模型输出不能直接写盘，必须经过 structured patch proposal。
- 写盘前必须 checkpoint。
- 敏感文件和危险命令必须触发 permission policy。
- 应用 patch 后可以运行测试。
- 测试失败可以进入一次 repair。
- 每次运行都有 session log 和 report。
- 可以 rollback 到 patch 前状态。
- 所有核心命令支持 `--json`，给未来 Desktop App 使用。
- 测试覆盖 runtime、manifest、tools、storage、CLI JSON surfaces。

## 10. 给 Codex 的完整开发 Prompt

下面这段可以直接作为 Codex 开发任务 Prompt 使用。

```text
你是 Codex，一个资深 TypeScript/Node.js 工程 Agent。请在当前仓库中从零或在现有基础上实现一个 CLI-first 的 Agentic Coding Runtime，项目名为 Token Streaming。

产品定位：
Token Streaming 不训练大模型，而是通过工程化编排商业模型、仓库上下文、工具执行、补丁、安全权限、测试反馈、检查点和回滚，让商业模型在真实软件工程任务里达到更高效果和更好性价比。

核心原则：
1. 先做 CLI，但核心必须 headless，未来 Desktop App 可以复用。
2. V1 只实现 default strategy，但要留下 strategy registry 和扩展接口。
3. V1 支持 economy/max/auto mode 的类型和最小行为差异，但不要实现复杂策略。
4. 多 Agent 协作先用 role phase + handoff artifact 实现，不做永久 swarm；CLI 可通过显式 `--parallel-agents` 启动非 orchestrator 角色的并发 advisory agent。
5. AI 不怕代码多，怕上下文关系隐含，所以必须支持 AI Manifest、module.yaml、flow.yaml。
6. 所有写文件操作必须经过 structured patch proposal、permission check、checkpoint，再 apply。
7. 所有命令执行必须经过安全策略检查。
8. 每次运行必须可审计：event log、run report、model telemetry、verification result、review summary。
9. 优先实现稳定、可测试、可扩展的核心，不要过度做 UI、数据库、云同步或插件市场。

推荐技术栈：
- TypeScript
- Node.js 22 LTS
- pnpm workspace
- CLI app under apps/cli
- Core runtime under packages/core
- Shared types under packages/protocol
- Manifest loader/generator/validator under packages/ai-manifest
- Tool runtime under packages/tools
- Event/checkpoint/report storage under packages/storage
- Model providers under packages/providers
- Behavior tests using compiled dist output

目标目录：
apps/
  cli/

packages/
  core/
  protocol/
  ai-manifest/
  tools/
  storage/
  providers/

docs/
  architecture.md
  implementation-plan.md

.ai/
  project.md
  architecture.md
  conventions.md
  commands.yaml
  tests.yaml
  safety.yaml
  ownership.yaml
  glossary.md
  playbooks/

src/
  workflows/

必须实现的核心模块：

1. CLI Host
- 支持主命令：token-streaming "task"
- 支持 --json
- 支持 --provider
- 支持 --model
- 支持 --strategy default
- 支持 --mode economy|max|auto
- 支持 --dry-run
- 支持 --patch-file
- 支持 --apply
- 支持 --repair
- 支持 --allow-sensitive
- 支持 --approval deny|allow|prompt

2. Read-only commands
- plan "task"
- context inspect "task"
- config inspect
- doctor repo
- doctor models
- models select
- strategies list
- tools list
- commands list
- manifest inspect
- manifest validate
- playbooks list/show
- workflows list/show
- history summary
- stats models
- diff
- search

这些命令都要支持 --json。

3. Manifest System
实现 .ai/ 标准：
- project.md
- architecture.md
- conventions.md
- commands.yaml
- tests.yaml
- safety.yaml
- ownership.yaml
- glossary.md
- playbooks/*.md

实现 module.yaml：
- name
- description
- owners
- public_api
- depends_on
- used_by
- test_commands
- rules

实现 flow.yaml：
- name
- description
- steps
- touches
- test_commands
- risks

命令：
- manifest init
- manifest generate
- manifest inspect
- manifest validate

manifest generate 用于接手外部项目，生成 .ai/generated/* fallback，不要覆盖人工维护文件，除非显式 force。

4. Repo Scanner and Context Builder
- 扫描文件树、package scripts、测试文件、模块 manifest、workflow manifest。
- 优先使用显式 .ai/、module.yaml、flow.yaml。
- 对任务进行关键词匹配，选择相关模块、工作流、公共 API 文件和测试命令。
- context inspect 要能解释选中依据。
- 控制上下文大小，避免无限读文件。

5. Strategy Layer
- 定义 OrchestrationStrategy 接口。
- 实现 StrategyRegistry。
- 只实现 default strategy。
- default strategy 根据任务类型生成 ExecutionPlan。
- ExecutionPlan 包含 phases、requiredAgents、handoffs、context、verificationCommands、risk。

6. Agent Role Phases
不要一开始创建多个长期 Agent。实现以下 role phase：
- orchestrator
- researcher
- coder
- tester
- reviewer

这些可以先是同一 runtime 内的逻辑阶段，但事件和计划中必须显式记录 handoff。并发 agent 只产出 advisory artifact，不直接改文件、不跑命令、不绕过权限；最终仍由主 runtime 统一走 patch/checkpoint/verification。

7. Tool Runtime
实现稳定工具目录：
- repo.scan
- repo.search
- file.read
- git.status
- git.diff
- command.run
- test.run
- patch.apply

tools list 展示工具 schema、风险等级 read|write|execute。
tools run 只允许安全的 read-only 工具直接执行。
test.run 只有在命令声明于 .ai/tests.yaml、module.yaml、flow.yaml 时才允许执行。
write/execute 工具必须走 runtime permission boundary。

8. Permission System
读取 .ai/safety.yaml：
- sensitive paths
- forbidden commands
- protected patterns

patch 涉及 sensitive path 时：
- 默认 deny 或请求 approval
- --allow-sensitive 可以允许
- --approval prompt 可以交互确认

命令涉及 forbidden command 时：
- 必须阻止
- 记录 permission.checked 和 run.failed

9. Patch Engine
模型或 patch-file 必须输出 structured patch proposal：

{
  "summary": "...",
  "files": [
    {
      "path": "relative/path.ts",
      "content": "full file content"
    }
  ]
}

默认只预览，不写盘。
只有 --apply 才写文件。
写盘前必须创建 checkpoint。
写盘后记录 patch.applied。

10. Verification and Repair
- 根据 plan 中 verificationCommands 执行测试。
- 每个测试命令走 test.run tool。
- 记录 tests.finished。
- 失败时如果 --repair 和 --apply 开启，允许一次 repair model call。
- repair 也必须输出 structured patch proposal 并走同样安全流程。

11. Checkpoint and Rollback
- patch apply 前保存 checkpoint。
- checkpoint 包含被修改文件的原始内容和存在状态。
- 支持 checkpoints list/show。
- 支持 rollback <checkpoint-id>。
- 支持 rollback --dry-run。
- 支持 --json。

12. Event Log and Reports
使用 .token-streaming/ 存本地运行数据：
- sessions/*.jsonl
- reports/*.md
- checkpoints/*

事件至少包含：
- run.started
- context.built
- plan.created
- model.called
- patch.proposed
- permission.checked
- approval.requested
- approval.resolved
- checkpoint.created
- patch.applied
- tool.started
- tool.finished
- tests.finished
- review.completed
- run.completed
- run.failed

每次成功或失败都尽量记录 run.completed 或 run.failed。
报告里要包含：
- plan summary
- selected context
- model calls
- tool calls
- permission decisions
- changes
- verification
- review
- rollback/checkpoint info

13. Model Providers
实现 Provider interface：
- Stub provider for deterministic tests。
- OpenAI provider adapter。
- model policy 支持 .ai/models.yaml：
  - economy_model
  - auto_model
  - max_model
  - default_model

CLI --model 优先级最高。
models select 和 doctor models 不应默认发网络请求，除非显式 --probe。

14. Review Summary
每次 run 结束前生成 reviewer summary：
- riskLevel
- verificationStatus
- hasRepositoryChanges
- appliedFiles
- permissionChecks
- approvals
- findings
- recommendation

review.completed 要写入 event log。
run JSON 和 report 中要展示 review。

15. Tests
必须写行为测试，覆盖：
- manifest init/generate/inspect/validate
- module.yaml and flow.yaml loading
- strategy registry
- default strategy plan
- context inspect
- tools list/run
- permission policy
- patch apply creates checkpoint
- rollback dry-run and actual rollback
- verification command allow/deny
- failed permission writes run.failed
- denied sensitive patch writes run.failed
- review.completed exists
- provider model selection
- CLI --json surfaces

完成后运行：
- pnpm build
- pnpm test
- manifest validate --json
- 至少一个 stub provider smoke run

交付要求：
- 不要只写方案，要直接实现代码。
- 每次编辑前先理解现有结构。
- 不要破坏用户已有改动。
- 不要使用 git reset --hard 或 destructive checkout。
- 用小步提交式的实现方式，每完成一组功能就跑测试。
- 文档和 README 必须同步更新。

最终输出：
1. 简短说明实现了什么。
2. 列出关键命令。
3. 说明测试结果。
4. 说明当前未实现但已预留接口的能力。
```

## 11. 建议启动方式

第一轮不要让 Codex 一口气做所有高级功能。建议按这个顺序推进：

1. 建 monorepo、协议类型、CLI 骨架。
2. 做 repo scanner、manifest loader、validator。
3. 做 context builder 和 default strategy。
4. 做 tools catalog 和 read-only tools。
5. 做 patch/checkpoint/rollback。
6. 做 permission/test feedback。
7. 接入 provider interface 和 stub provider。
8. 接 OpenAI provider。
9. 做 event log、report、history、doctor。
10. 补齐 JSON surfaces 和行为测试。

如果 Codex 已经在一个已有代码库里继续开发，就要求它先运行：

```bash
rg --files
pnpm test
pnpm build
```

然后基于现状补缺口，不要重复造已经存在的模块。
