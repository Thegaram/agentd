FROM agentd-base:latest

USER root

# Create Codex config directory
RUN mkdir -p /home/agent/.codex \
  && chown -R agent:agent /home/agent/.codex

# Install Codex CLI
RUN npm install -g @openai/codex

# Codex configuration: full access inside the hardened container
COPY --chown=agent:agent config.toml /home/agent/.codex/config.toml

# Auth check script for tmux status bar
COPY --chown=agent:agent check-auth.sh /agentd/check-auth.sh
RUN chmod +x /agentd/check-auth.sh

# Append Codex-specific credential cleanup to .bashrc
RUN printf '%s\n' \
    '# When auth.json credential file is mounted, unset env vars that would shadow it.' \
    '# See agents/codex.ts credentialShadowVars for the authoritative list.' \
    'if [ -f /home/agent/.codex/auth.json ]; then unset CODEX_API_KEY OPENAI_API_KEY 2>/dev/null; fi' \
    >> /home/agent/.bashrc

USER agent
ENTRYPOINT ["bash"]
