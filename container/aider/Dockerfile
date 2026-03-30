FROM agentd-base:latest

# Auth check script (verifies Ollama reachability)
COPY --chown=agent:agent check-auth.sh /agentd/check-auth.sh
RUN chmod +x /agentd/check-auth.sh

USER agent

# Install aider with Python 3.12 (aider's pydub dependency uses audioop, removed in 3.13)
RUN uv tool install --python 3.12 aider-chat

ENTRYPOINT ["bash"]
