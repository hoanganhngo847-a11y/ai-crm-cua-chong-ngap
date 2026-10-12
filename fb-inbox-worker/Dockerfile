# syntax=docker/dockerfile:1
# ==============================================================================
# Meta Business Suite Inbox Worker - Production Dockerfile
# Pinned to exact Playwright version 1.64.0 on Ubuntu Noble (Requirement 8)
# ==============================================================================
FROM mcr.microsoft.com/playwright:v1.64.0-noble

# Set working directory inside container
WORKDIR /app

# Non-interactive apt installation
ENV DEBIAN_FRONTEND=noninteractive

# Install Xvfb, fluxbox, internal localhost VNC/websockify, noVNC, and fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    fluxbox \
    x11vnc \
    websockify \
    novnc \
    fonts-noto-color-emoji \
    fonts-liberation \
    procps \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Setup noVNC default index symlink
RUN if [ -f /usr/share/novnc/vnc.html ] && [ ! -f /usr/share/novnc/index.html ]; then \
      ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html; \
    fi

# Copy package dependency manifests first for layer caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code and deployment scripts
COPY src ./src
COPY deploy ./deploy

# Ensure persistent disk mount path exists
RUN mkdir -p /var/data/fb-user-data

# Set executable permission for container entrypoint
RUN chmod +x deploy/entrypoint.sh

# Production default environment variables
ENV NODE_ENV=production \
    PORT=3099 \
    FB_PROFILE_DIR=/var/data/fb-user-data \
    HEADLESS=true \
    ENABLE_SETUP_UI=false

# Expose Node Gateway port (Only Node Gateway listens on 0.0.0.0:$PORT)
EXPOSE 3099

# Start through orchestration entrypoint
ENTRYPOINT ["./deploy/entrypoint.sh"]
