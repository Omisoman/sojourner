# Tier-2 ops agent — SAME sandbox image as tier-1 (one lineage, one
# environment), plus the A2A server and its tools. Build tier1 first
# (make demo2-build). The staging app runs this image too.
FROM sojourner-tier:latest

USER root
COPY --chown=root:root tier2 /opt/sojourner/tier2
COPY --chown=root:root tier2/core.json /opt/sojourner/core.json
# the operator console's own .opencode is bind-mounted by compose
RUN rm -rf /opt/sojourner/tier2/.opencode /opt/sojourner/tier2/Dockerfile \
    && chmod -R a+rX /opt/sojourner

USER agent
# The server imports the BAKED baseline (a patch can change the app, never the
# gate); the tools run the patched checkout with their own PYTHONPATH.
ENV PYTHONPATH=/opt/sojourner/horizons/src:/opt/sojourner/tier2 \
    PROJECT_DIR=/workspace/project \
    BASELINE_DIR=/opt/sojourner/horizons \
    BUILD_OUT=/tmp/sojourner-build \
    HORIZONS_DATA=/workspace/farm/data
WORKDIR /opt/sojourner/tier2
CMD ["/opt/venv/bin/python", "/opt/sojourner/tier2/server.py"]
