# 容器化

Pi 默认以全部权限运行，但在某些情况下，你希望更精细地控制 Pi 可以写入哪些目录以及它有哪些访问能力。

有两个通用选项。你可以：
1. 将整个 `pi` 进程运行在隔离环境中，或
2. 在宿主机运行 `pi`，并将工具执行路由到隔离环境中。

## 选择模式

| 模式 | 隔离对象 | 最适合 | 备注 |
| --- | --- | --- | --- |
| Gondolin 扩展 | 内置工具和 `!` 命令 | 本地 micro-VM 隔离，同时认证保留在宿主机 | 见 [`examples/extensions/gondolin/`](../examples/extensions/gondolin/)。 |
| 普通 Docker | 整个 `pi` 进程运行在本地容器中 | 简单的本地隔离 | Provider API key 会进入容器。 |
| OpenShell | 整个 `pi` 进程运行在策略控制的沙箱中 | 本地或远程托管沙箱 | 需要 OpenShell gateway |

扩展在 `pi` 进程运行的任何地方运行。如果你在宿主机运行 `pi` 并使用工具路由扩展，其他自定义扩展工具仍然在宿主机上运行，除非它们也委托了自己的操作。

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) 是一个本地 Linux micro-VM。
当你想在宿主机运行 `pi` 但把所有内置工具路由到虚拟机时，使用[示例扩展](../examples/extensions/gondolin)。

设置：

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
```

从你要挂载的项目运行：

```bash
cd /path/to/project
pi -e ~/.pi/agent/extensions/gondolin
```

该扩展把宿主机 cwd 挂载到虚拟机的 `/workspace`，并覆盖 `read`、`write`、`edit`、`bash`、`grep`、`find` 和 `ls`。
用户 `!` 命令也会路由到虚拟机。
`/workspace` 下的文件变更会写穿（write through）到宿主机。

要求：`@earendil-works/gondolin` 需要 Node.js >= 23.6.0，外加 QEMU（需要通过包管理器安装）。

## 普通 Docker

当你想要最简单的本地容器边界时，把整个 `pi` 进程运行在 Docker 中。

`Dockerfile.pi`：

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

构建并运行：

```bash
docker build -t pi-sandbox -f Dockerfile.pi .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

`-v "$PWD:/workspace"` 把当前目录挂载到容器的 /workspace，使 Docker 内 `/workspace` 中的读写直接影响宿主文件，与 Gondolin 示例类似。

如果你想要容器本地的设置和会话，为 `/root/.pi/agent` 使用命名卷。挂载宿主机 `~/.pi/agent` 会把宿主机认证和会话文件暴露给容器。

## OpenShell

当你想要带文件系统、进程、网络、凭据和推理控制的策略控制沙箱时，使用 [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview)。
OpenShell 可以通过由 Docker、Podman 或虚拟机运行时支撑的本地 gateway 运行沙箱，也可以通过远程 Kubernetes gateway 运行。

每个沙箱都需要一个活跃的 gateway。
创建沙箱前先注册并选择一个：

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

在 OpenShell 沙箱内启动 `pi`：

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

在这种模式中，整个 `pi` 进程运行在沙箱内。
内置工具、`!` 命令和扩展工具都在 OpenShell 边界内执行。

如果 gateway 是远程的，项目文件不会从宿主机绑定挂载，意味着沙箱内的写入不会反映到你的机器上。
在沙箱内克隆仓库或使用 OpenShell 文件传输命令：

```bash
openshell sandbox upload pi-sandbox ./repo /workspace
openshell sandbox download pi-sandbox /workspace/repo ./repo-out
```

OpenShell provider 可以把原始模型 API key 保留在沙箱之外。
配置推理路由后，沙箱内的代码可以调用 `https://inference.local`，gateway 会在上游注入配置的 provider 凭据。
如果你希望模型流量走这条路由，把 Pi 配置为使用对应的 OpenAI 兼容或 Anthropic 兼容端点。
