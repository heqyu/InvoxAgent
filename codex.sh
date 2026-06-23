#!/usr/bin/env bash
# 将 Codex CLI 指向远程 LM Studio
# 注意：新版 Codex（>=0.123）已移除 wire_api="chat"，强制走 Responses API。
# LM Studio 已原生支持 Responses API（端点 /v1/responses），所以 base_url 写到 /v1 即可，
# Codex 会按 wire_api 自动拼 /responses 后缀。
export OPENAI_BASE_URL=http://30.29.152.55:1234/v1
export OPENAI_API_KEY=sk-dummy   # LM Studio 不校验 key，但变量不能为空

# 关键点：
# 1. Codex 默认 model_provider="openai" 会走官方鉴权流程，忽略 OPENAI_BASE_URL，必须切到自定义 provider。
# 2. "lmstudio" 是 Codex 内置 provider 名（写死 http://localhost:1234/v1），不能覆盖，所以这里用 "lmstudio-remote"。
codex \
  --config model_provider=lmstudio-remote \
  --config model_providers.lmstudio-remote.name=LMStudioRemote \
  --config model_providers.lmstudio-remote.base_url="$OPENAI_BASE_URL" \
  --config model_providers.lmstudio-remote.env_key=OPENAI_API_KEY \
  --config model_providers.lmstudio-remote.wire_api=responses \
  "$@"
