.PHONY: help install build typecheck test clean lint all

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

build: ## Compile TypeScript to dist/
	npm run build

typecheck: ## TypeScript check without emitting
	npm run typecheck

test: ## Run test suite
	npm test

lint: ## typecheck + test
	make typecheck && make test

clean: ## Remove build artifacts
	rm -rf dist node_modules/.cache coverage

all: install lint build ## Full pipeline
