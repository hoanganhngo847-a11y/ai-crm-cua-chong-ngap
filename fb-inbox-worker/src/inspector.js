import { log } from './logger.js';

/**
 * Inspects live Meta Business Suite DOM structure
 * Dumps interactive and semantic elements to assist in fine-tuning selectors.
 */
export async function inspectInboxDOM(page) {
  log.info('Đang phân tích cấu trúc DOM thực tế của Meta Business Suite...');

  try {
    const analysis = await page.evaluate(() => {
      const report = {
        url: window.location.href,
        title: document.title,
        roles: {},
        ariaLabels: [],
        headings: [],
        listsCount: 0,
        listItemsCount: 0,
        buttonsCount: 0
      };

      // Collect roles
      document.querySelectorAll('[role]').forEach(el => {
        const role = el.getAttribute('role');
        report.roles[role] = (report.roles[role] || 0) + 1;
      });

      // Collect prominent aria-labels (containing Inbox, message, chat, etc.)
      document.querySelectorAll('[aria-label]').forEach(el => {
        const label = el.getAttribute('aria-label');
        if (label && label.length > 2 && label.length < 100) {
          if (/hộp thư|inbox|tin nhắn|message|chưa đọc|unread|trang|page/i.test(label)) {
            report.ariaLabels.push({
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || 'none',
              label
            });
          }
        }
      });

      // Collect headings
      document.querySelectorAll('h1, h2, h3, [role="heading"]').forEach(el => {
        const text = (el.innerText || '').trim();
        if (text) {
          report.headings.push({ tag: el.tagName.toLowerCase(), text });
        }
      });

      // Sample preview elements from list/navigation
      const previewRows = [];
      const rows = document.querySelectorAll('[role="listitem"], [role="row"], [role="gridcell"]');
      rows.forEach((r, idx) => {
        if (idx < 5) {
          previewRows.push({
            role: r.getAttribute('role'),
            ariaLabel: r.getAttribute('aria-label') || '',
            innerTextSnippet: (r.innerText || '').slice(0, 150).replace(/\n+/g, ' | ')
          });
        }
      });

      report.sampleRows = previewRows;
      return report;
    });

    log.info(`URL hiện tại: ${analysis.url}`);
    log.info(`Tiêu đề trang: ${analysis.title}`);
    log.info(`Các vai trò ARIA tìm thấy: ${JSON.stringify(analysis.roles)}`);
    log.info(`Mẫu hàng/hội thoại phát hiện (${analysis.sampleRows.length} mẫu):`);
    for (const r of analysis.sampleRows) {
      console.log(`   - [${r.role}] "${r.innerTextSnippet}" (aria-label: "${r.ariaLabel}")`);
    }

    if (analysis.ariaLabels.length > 0) {
      log.info(`Các aria-label liên quan (${analysis.ariaLabels.length}):`);
      for (const a of analysis.ariaLabels.slice(0, 8)) {
        console.log(`   - <${a.tag} role="${a.role}" aria-label="${a.label}">`);
      }
    }

    return analysis;
  } catch (error) {
    log.warn(`Không thể inspect DOM: ${error.message}`);
    return null;
  }
}
