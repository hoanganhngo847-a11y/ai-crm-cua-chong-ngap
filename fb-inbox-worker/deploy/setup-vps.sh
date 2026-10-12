#!/usr/bin/env bash
# ==============================================================================
# Setup Script: Ubuntu VPS Provisioning for fb-inbox-worker
# Operating System: Ubuntu 22.04 LTS / 24.04 LTS
# ==============================================================================

set -euo pipefail

echo "=========================================================="
echo "  PROVISIONING UBUNTU VPS FOR FB-INBOX-WORKER (PLAYWRIGHT) "
echo "=========================================================="

if [[ $EUID -ne 0 ]]; then
   echo "❌ Script này cần quyền root. Vui lòng chạy với sudo."
   exit 1
fi

# 1. Update OS & Essential Utilities
echo "▶ 1. Cập nhật hệ thống và cài đặt tiện ích cơ bản..."
apt-get update -y
apt-get install -y curl wget git gnupg ca-certificates lsb-release htop logrotate xvfb

# 2. Install Node.js LTS (v20)
if ! command -v node &> /dev/null; then
  echo "▶ 2. Cài đặt Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "✔ Node.js $(node -v) đã được cài đặt."
fi

# 3. Create dedicated system user for worker isolation
WORKER_USER="fbworker"
if ! id "$WORKER_USER" &>/dev/null; then
  echo "▶ 3. Tạo system user '$WORKER_USER'..."
  useradd -r -m -d /var/lib/fb-inbox-worker -s /bin/bash "$WORKER_USER"
else
  echo "✔ User '$WORKER_USER' đã tồn tại."
fi

# 4. Create persistent data & log directories
echo "▶ 4. Tạo thư mục dữ liệu persistent và thư mục logs..."
PERSISTENT_DIR="/var/lib/fb-inbox-worker/user_data"
LOG_DIR="/var/log/fb-inbox-worker"
CONF_DIR="/etc/fb-inbox-worker"

mkdir -p "$PERSISTENT_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$CONF_DIR"

chown -R "$WORKER_USER:$WORKER_USER" /var/lib/fb-inbox-worker
chown -R "$WORKER_USER:$WORKER_USER" "$LOG_DIR"
chmod 750 /var/lib/fb-inbox-worker
chmod 750 "$LOG_DIR"

# 5. Install Playwright Chromium & OS Dependencies
echo "▶ 5. Cài đặt thư viện hệ thống cho Playwright Chromium..."
# Install playwright dependencies
npx -y playwright install-deps chromium || apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2

# 6. Setup Configuration Template if not present
if [ ! -f "$CONF_DIR/worker.env" ]; then
  echo "▶ 6. Khởi tạo template cấu hình /etc/fb-inbox-worker/worker.env..."
  cp deploy/worker.env.example "$CONF_DIR/worker.env"
  chown "$WORKER_USER:$WORKER_USER" "$CONF_DIR/worker.env"
  chmod 600 "$CONF_DIR/worker.env"
  echo "⚠️ Vui lòng cập nhật FB_WORKER_SECRET trong $CONF_DIR/worker.env trước khi khởi động!"
fi

# 7. Setup Logrotate
echo "▶ 7. Cài đặt logrotate..."
cp deploy/logrotate/fb-inbox-worker /etc/logrotate.d/fb-inbox-worker
chmod 644 /etc/logrotate.d/fb-inbox-worker

# 8. Setup Systemd Service
echo "▶ 8. Cài đặt systemd service..."
cp deploy/systemd/fb-inbox-worker.service /etc/systemd/system/fb-inbox-worker.service
systemctl daemon-reload
systemctl enable fb-inbox-worker.service

echo ""
echo "=========================================================="
echo "✅ PROVISIONING HOÀN TẤT!"
echo "Các bước tiếp theo:"
echo "1. Chỉnh sửa bí mật trong: nano /etc/fb-inbox-worker/worker.env"
echo "2. Copy/symlink session user_data ban đầu vào: $PERSISTENT_DIR"
echo "3. Khởi động worker: systemctl start fb-inbox-worker"
echo "4. Kiểm tra logs: tail -f /var/log/fb-inbox-worker/worker.log"
echo "5. Kiểm tra health: curl http://localhost:3099/health"
echo "=========================================================="
