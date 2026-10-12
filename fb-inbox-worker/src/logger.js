// Terminal Logger with ANSI colors and formatted banners

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const BG_BLUE = '\x1b[44m\x1b[37m';

function getTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString('vi-VN', { hour12: false });
}

export const log = {
  info(message) {
    console.log(`${GRAY}[${getTimestamp()}]${RESET} ${CYAN}ℹ️  INFO:${RESET} ${message}`);
  },

  success(message) {
    console.log(`${GRAY}[${getTimestamp()}]${RESET} ${GREEN}✅ SUCCESS:${RESET} ${message}`);
  },

  warn(message) {
    console.log(`${GRAY}[${getTimestamp()}]${RESET} ${YELLOW}⚠️  WARN:${RESET} ${message}`);
  },

  error(message, error = null) {
    console.error(`${GRAY}[${getTimestamp()}]${RESET} ${RED}❌ ERROR:${RESET} ${message}`);
    if (error && error.stack) {
      console.error(`${GRAY}${error.stack}${RESET}`);
    }
  },

  auth(message) {
    console.log(`${GRAY}[${getTimestamp()}]${RESET} ${YELLOW}${BOLD}🔐 XÁC THỰC:${RESET} ${message}`);
  },

  messageBox({ pageName, customerName, text, timestamp, isUnread }) {
    const divider = '─'.repeat(55);
    console.log(`\n${CYAN}┌${divider}┐${RESET}`);
    console.log(`${CYAN}│${RESET}  ${BOLD}📩 TIN NHẮN MỚI TỪ META BUSINESS SUITE${RESET} ${isUnread ? `${YELLOW}(Chưa đọc)${RESET}` : ''}`);
    console.log(`${CYAN}├${divider}┤${RESET}`);
    console.log(`${CYAN}│${RESET}  🏷️  ${BOLD}Trang:${RESET}       ${GREEN}${pageName || 'Không xác định'}${RESET}`);
    console.log(`${CYAN}│${RESET}  👤  ${BOLD}Khách hàng:${RESET}  ${BOLD}${CYAN}${customerName || 'Ẩn danh'}${RESET}`);
    console.log(`${CYAN}│${RESET}  🕒  ${BOLD}Thời gian:${RESET}   ${GRAY}${timestamp || 'Vừa xong'}${RESET}`);
    console.log(`${CYAN}├${divider}┤${RESET}`);
    console.log(`${CYAN}│${RESET}  💬  ${BOLD}Nội dung:${RESET}`);
    
    // Wrap text nicely if long
    const lines = (text || '(Không có nội dung văn bản)').split('\n');
    for (const line of lines) {
      console.log(`${CYAN}│${RESET}      ${line}`);
    }
    console.log(`${CYAN}└${divider}┘\n${RESET}`);
  },

  banner(text) {
    console.log(`\n${BG_BLUE}  ${text}  ${RESET}\n`);
  }
};
