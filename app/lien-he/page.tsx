import type { Metadata } from 'next';

import LeadForm from '@/features/omnichannel/website/LeadForm';
import styles from '@/features/omnichannel/website/lead.module.css';

export const metadata: Metadata = {
    title: 'Tư vấn cửa chống ngập',
    description:
        'Gửi yêu cầu tư vấn giải pháp cửa chống ngập cho ngôi nhà của bạn.',
};

export default function ContactPage() {
    return (
        <main className={styles.page} lang="vi">
            <nav className={styles.nav}>
                <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            ≈
          </span>
                    CỬA CHỐNG NGẬP
                </div>
                <span>Tiếp nhận & tư vấn</span>
            </nav>

            <div className={styles.layout}>
                <section className={styles.hero}>
          <span className={styles.eyebrow}>
            GIẢI PHÁP CHO NGÔI NHÀ CỦA BẠN
          </span>

                    <h1>
                        Chủ động trước
                        <br />
                        mùa mưa.
                        <br />
                        <em>An tâm hơn.</em>
                    </h1>

                    <p>
                        Chia sẻ nhu cầu để được tư vấn giải pháp cửa
                        chống ngập phù hợp với không gian của bạn.
                    </p>

                    <div
                        className={styles.illustration}
                        aria-hidden="true"
                    >
                        <div className={styles.house}>
                            <div className={styles.door} />
                        </div>
                        <div className={styles.water} />
                    </div>

                    <div className={styles.benefits}>
                        <div>
                            <strong>01. Tìm hiểu</strong>
                            Tiếp nhận nhu cầu
                        </div>

                        <div>
                            <strong>02. Tư vấn</strong>
                            Giải pháp phù hợp
                        </div>

                        <div>
                            <strong>03. Khảo sát</strong>
                            Khi cần đo thực tế
                        </div>
                    </div>
                </section>

                <LeadForm
                    siteKey={
                        process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''
                    }
                />
            </div>

            <footer className={styles.footer}>
                Cửa chống ngập · Kết nối để được hỗ trợ
            </footer>
        </main>
    );
}