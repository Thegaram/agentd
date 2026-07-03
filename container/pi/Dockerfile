FROM agentd-base:latest

USER root

# Create pi config/state directory. agentd mounts nothing here: pi owns
# auth.json (written by /login, rewritten on refresh) and persists it, plus
# sessions and settings, in the container's writable layer across stop/resume.
RUN mkdir -p /home/agent/.pi/agent \
  && chown -R agent:agent /home/agent/.pi

# Install the pi coding agent CLI. Pinned per supply-chain policy; --ignore-scripts
# is safe because the package ships a plain Node bin (dist/cli.js), no native build.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.3

# Default global settings: telemetry off, no auto-compaction, and defaultProjectTrust
# "ask" — pi prompts before loading a repo's .pi/ config/extensions, so an untrusted
# workspace can't auto-run code that reads the mounted credentials. pi may rewrite
# this file; it lives in the writable layer so edits and /login persist together.
COPY --chown=agent:agent settings.json /home/agent/.pi/agent/settings.json

# Auth check script for tmux status bar
COPY --chown=agent:agent check-auth.sh /agentd/check-auth.sh
RUN chmod +x /agentd/check-auth.sh

USER agent
ENTRYPOINT ["bash"]
