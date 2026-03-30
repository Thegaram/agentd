.PHONY: build build-base build-claude build-codex build-aider install

DOCKER_BUILD_FLAGS ?=
AGENTD_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

build-base:
	docker build $(DOCKER_BUILD_FLAGS) --build-arg AGENTD_COMMIT=$(AGENTD_COMMIT) -t agentd-base:latest -f container/Dockerfile.base container/

build-claude: build-base
	docker build $(DOCKER_BUILD_FLAGS) -t agentd-claude:latest -f container/claude/Dockerfile container/claude/

build-codex: build-base
	docker build $(DOCKER_BUILD_FLAGS) -t agentd-codex:latest -f container/codex/Dockerfile container/codex/

build-aider: build-base
	docker build $(DOCKER_BUILD_FLAGS) -t agentd-aider:latest -f container/aider/Dockerfile container/aider/

build:
	npm install
	npm run build
	$(MAKE) build-base build-claude build-codex build-aider

install: build
	npm link
