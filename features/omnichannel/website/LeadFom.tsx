'use client';

import Script from 'next/script';
import { useRef, useState } from 'react';
import styles from './lead.module.css';

declare global {
    interface Window {
        turnstile?: {
            render: (
                target: HTMLElement,
                options: Record<string, unknown>,
            ) => string;
            reset: (id: string) => void;
        };
    }
}

export default function LeadForm({
                                     siteKey,
                                 }: {
    siteKey: string;
}) {
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState('');

    const captcha = useRef<HTMLDivElement>(null);
    const token = useRef('');
    const widget = useRef<string | null>(null);
    const requestId = useRef('');
    const fingerprint = useRef('');

    function loadCaptcha() {
        if (captcha.current && window.turnstile && !widget.current) {
            widget.current = window.turnstile.render(
                captcha.current,
                {
                    sitekey: siteKey,
                    action: 'lead',
                    callback: (value: string) => {
                        token.current = value;
                    },
                    'expired-callback': () => {
                        token.current = '';
                    },
                    'error-callback': () => {
                        token.current = '';
                    },
                },
            );
        }
    }

    async function submit(
        event: React.FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();

        if (busy) return;

        const form = event.currentTarget;
        const values = new FormData(form);

        setBusy(true);
        setError('');

        const currentFingerprint = JSON.stringify([
            values.get('name'),
            values.get('phone'),
            values.get('need'),
        ]);

        if (fingerprint.current !== currentFingerprint) {
            requestId.current = crypto.randomUUID();
            fingerprint.current = currentFingerprint;
        }

        requestId.current ||= crypto.randomUUID();

        try {
            const response = await fetch('/api/website/leads', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    request_id: requestId.current,
                    name: values.get('name'),
                    phone: values.get('phone'),
                    need: values.get('need'),
                    website: values.get('website'),
                    consent: values.get('consent') === 'on',
                    captcha_token: token.current,
                }),
            });

            if (!response.ok) {
                const result = await response.json();

                const messages: Record<string, string> = {
                    INVALID_PHONE:
                        'Số điện thoại chưa hợp lệ. Vui lòng kiểm tra lại.',
                    RATE_LIMITED:
                        'Bạn đã gửi nhiều yêu cầu. Vui lòng thử lại sau 15 phút.',
                    CAPTCHA_REQUIRED:
                        'Vui lòng hoàn tất xác minh trước khi gửi.',
                    CAPTCHA_FAILED:
                        'Xác minh hết hạn. Vui lòng thử lại.',
                    CONSENT_REQUIRED:
                        'Vui lòng đồng ý để chúng tôi liên hệ tư vấn.',
                };

                setError(
                    messages[result.error] ||
                    'Chưa gửi được yêu cầu. Vui lòng thử lại sau.',
                );
            } else {
                setDone(true);
                form.reset();
            }
        } catch {
            setError(
                'Không kết nối được máy chủ. Bạn có thể thử gửi lại.',
            );
        } finally {
            setBusy(false);
            token.current = '';

            if (widget.current) {
                window.turnstile?.reset(widget.current);
            }
        }
    }

    if (done) {
        return (
            <section className={styles.success} role="status">
                <span className={styles.check}>✓</span>
                <h2>Đã nhận yêu cầu của bạn</h2>
                <p>
                    Chúng tôi sẽ liên hệ để tìm hiểu nhu cầu và hỗ trợ
                    tư vấn cửa chống ngập.
                </p>

                <button
                    onClick={() => {
                        requestId.current = '';
                        widget.current = null;
                        setDone(false);
                    }}
                >
                    Gửi yêu cầu khác
                </button>
            </section>
        );
    }

    return (
        <form className={styles.form} onSubmit={submit}>
            <div className={styles.formHeading}>
        <span className={styles.step}>
          01 / THÔNG TIN LIÊN HỆ
        </span>
                <h2>Bạn cần chúng tôi hỗ trợ gì?</h2>
                <p>
                    Để lại thông tin, đội ngũ tư vấn sẽ liên hệ với bạn.
                </p>
            </div>

            <div className={styles.row}>
                <label>
                    Họ và tên <span>*</span>
                    <input
                        name="name"
                        autoComplete="name"
                        placeholder="Nhập họ và tên"
                        minLength={2}
                        maxLength={100}
                        required
                        disabled={busy}
                    />
                </label>

                <label>
                    Số điện thoại <span>*</span>
                    <input
                        name="phone"
                        type="tel"
                        autoComplete="tel"
                        placeholder="Ví dụ: 0912 345 678"
                        maxLength={40}
                        required
                        disabled={busy}
                    />
                </label>
            </div>

            <label>
                Nhu cầu của bạn <span>*</span>
                <textarea
                    name="need"
                    rows={5}
                    placeholder="Bạn muốn lắp cửa ở đâu? Có thể mô tả kích thước và tình trạng ngập nếu đã biết."
                    minLength={5}
                    maxLength={2000}
                    required
                    disabled={busy}
                />
            </label>

            <div className={styles.trap} aria-hidden="true">
                <label>
                    Website
                    <input
                        name="website"
                        tabIndex={-1}
                        autoComplete="off"
                    />
                </label>
            </div>

            <label className={styles.consent}>
                <input
                    name="consent"
                    type="checkbox"
                    required
                    disabled={busy}
                />
                <span>
          Tôi đồng ý để doanh nghiệp sử dụng thông tin trên
          nhằm liên hệ và tư vấn về yêu cầu này.
        </span>
            </label>

            {siteKey && (
                <>
                    <Script
                        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
                        onReady={loadCaptcha}
                    />
                    <div ref={captcha} />
                </>
            )}

            {error && (
                <p className={styles.error} role="alert">
                    {error}
                </p>
            )}

            <button type="submit" disabled={busy}>
                {busy ? 'Đang gửi yêu cầu…' : 'Gửi yêu cầu tư vấn'}
                <span aria-hidden="true">↗</span>
            </button>

            <p className={styles.note}>
                Thông tin của bạn chỉ được sử dụng cho việc tiếp nhận
                và tư vấn.
            </p>
        </form>
    );
}