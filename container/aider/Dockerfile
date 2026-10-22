FROM agentd-base:latest

# Auth check script (verifies Ollama reachability)
COPY --chown=agent:agent check-auth.sh /agentd/check-auth.sh
RUN chmod +x /agentd/check-auth.sh

USER agent

# Session-log dir (agentd redirects aider's chat/input history here and mounts a
# host bucket over it). Pre-created so the --*-history-file flags work even when
# transcript persistence is disabled and nothing is mounted.
# Keep this path in sync with SESSIONS_DIR in src/agents/aider.ts.
RUN mkdir -p /home/agent/.aider/sessions

# Install aider with Python 3.12 (aider's pydub dependency uses audioop, removed in 3.13).
# aider-chat pins certifi==2026.1.4, which still trusts the compromised eMudhra CAs;
# override it with a certifi release that drops them.
RUN printf 'certifi>=2026.10.19\n' > /tmp/aider-overrides.txt \
  && uv tool install --python 3.12 --overrides /tmp/aider-overrides.txt aider-chat \
  && rm /tmp/aider-overrides.txt

ENTRYPOINT ["bash"]
