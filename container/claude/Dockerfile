FROM agentd-base:latest

USER root

# Create Claude Code config directory
RUN mkdir -p /home/agent/.claude \
  && chown -R agent:agent /home/agent/.claude

# Install Claude Code CLI: npm to bootstrap, then native install, then remove npm version
RUN npm install -g @anthropic-ai/claude-code
USER agent
RUN echo | claude install
USER root
RUN npm uninstall -g @anthropic-ai/claude-code

# Pre-configure Claude Code to skip first-run and trust prompts
RUN echo '{"hasCompletedOnboarding":true,"autoCompactEnabled":false,"spinnerTipsEnabled":false,"autoConnectIde":true,"remoteControlAtStartup":false,"projects":{"/workspace":{"hasTrustDialogAccepted":true},"/agentd":{"hasTrustDialogAccepted":true}}}' \
    > /home/agent/.claude.json \
  && chown agent:agent /home/agent/.claude.json

# Settings: permissions, hooks, deny rules, telemetry, statusline
COPY --chown=agent:agent settings.json /home/agent/.claude/settings.json

# Statusline and notification scripts
COPY --chown=agent:agent statusline.sh /home/agent/.claude/statusline.sh
COPY --chown=agent:agent notify.sh /home/agent/.claude/notify.sh
RUN chmod +x /home/agent/.claude/statusline.sh /home/agent/.claude/notify.sh

# LSP plugins for code intelligence
USER agent
RUN claude plugin install typescript-lsp 2>/dev/null || true \
  && claude plugin install pyright-lsp 2>/dev/null || true \
  && claude plugin install rust-lsp 2>/dev/null || true
USER root

# MCP: Context7 for up-to-date library docs
RUN echo '{"mcpServers":{"context7":{"command":"context7-mcp","args":[]}}}' \
    > /home/agent/.claude/mcp.json \
  && chown agent:agent /home/agent/.claude/mcp.json

# Auth check script for tmux status bar
COPY --chown=agent:agent check-auth.sh /agentd/check-auth.sh
RUN chmod +x /agentd/check-auth.sh

# Append Claude-specific credential cleanup to .bashrc
RUN printf '%s\n' \
    '# When OAuth credential file is mounted, unset env vars that would shadow it.' \
    '# See agents/claude.ts credentialShadowVars for the authoritative list.' \
    'if [ -f /home/agent/.claude/.credentials.json ]; then unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY 2>/dev/null; fi' \
    >> /home/agent/.bashrc

USER agent
ENTRYPOINT ["bash"]
