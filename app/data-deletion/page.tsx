import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
    title: 'User Data Deletion Instructions / Hướng dẫn xóa dữ liệu người dùng | AI CRM',
    description:
        'Instructions on how users can request deletion of their Facebook Messenger and platform data from AI CRM.',
};

const Section = ({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) => (
    <section className="space-y-3">
        <h2 className="text-xl font-semibold text-slate-100">{title}</h2>
        <div className="space-y-3 leading-7 text-slate-300">{children}</div>
    </section>
);

export default async function DataDeletionPage(props: {
    searchParams?: Promise<{ code?: string }>;
}) {
    const searchParams = props.searchParams ? await props.searchParams : {};
    const code = searchParams.code?.trim();

    return (
        <main className="min-h-screen bg-slate-950 text-slate-100">
            <div className="mx-auto max-w-4xl px-6 py-12 sm:px-8 lg:py-16">
                <header className="mb-10 border-b border-slate-800 pb-8">
                    <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-blue-400">
                        AI CRM · Facebook Messenger Integration
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                        User Data Deletion Instructions
                    </h1>
                    <p className="mt-2 text-xl text-slate-300">
                        Hướng dẫn xóa dữ liệu người dùng Facebook
                    </p>
                    <p className="mt-4 text-slate-400">
                        Last updated / Cập nhật lần cuối: 16 October 2026
                    </p>
                </header>

                {code && (
                    <div className="mb-10 rounded-xl border border-blue-500/30 bg-blue-950/40 p-6 text-slate-200">
                        <div className="flex items-center gap-3">
                            <span className="flex h-3 w-3 rounded-full bg-blue-400 animate-pulse" />
                            <h2 className="text-lg font-semibold text-blue-300">
                                Trạng thái yêu cầu xóa dữ liệu / Request Status
                            </h2>
                        </div>
                        <div className="mt-4 space-y-2 text-sm text-slate-300">
                            <p>
                                <strong className="text-slate-100">Mã yêu cầu (Confirmation Code):</strong>{' '}
                                <code className="rounded bg-slate-800 px-2 py-0.5 text-blue-400 font-mono">
                                    {code}
                                </code>
                            </p>
                            <p>
                                <strong className="text-slate-100">Trạng thái (Status):</strong>{' '}
                                <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-2 py-0.5 text-emerald-400 font-medium">
                                    Đã tiếp nhận (RECEIVED / PENDING_PURGE)
                                </span>
                            </p>
                            <p className="text-xs text-slate-400">
                                Yêu cầu xóa dữ liệu của bạn đã được ghi nhận. Dữ liệu liên quan đến tài khoản Facebook của bạn sẽ được rà soát và xóa khỏi hệ thống CRM trong vòng tối đa 30 ngày theo quy định bảo mật của Meta Platform.
                            </p>
                        </div>
                    </div>
                )}

                <div className="space-y-10">
                    <Section title="1. Overview / Tổng quan">
                        <p>
                            Pursuant to Meta Platform Terms and Privacy requirements, users of our application
                            (CRM Messenger Production) have the right to request deletion of their personal
                            information and Facebook Messenger platform data processed by the CRM.
                        </p>
                        <p>
                            Theo Điều khoản Nền tảng Meta và các quy định bảo mật, người dùng tương tác với ứng dụng
                            (CRM Messenger Production) và Trang Facebook được kết nối có quyền yêu cầu xóa thông tin
                            cá nhân và dữ liệu cuộc hội thoại Messenger đã lưu trên hệ thống CRM.
                        </p>
                    </Section>

                    <Section title="2. Method 1: Delete App Permissions via Facebook / Gỡ bỏ ứng dụng qua Facebook">
                        <p>
                            To remove the CRM app&apos;s access to your Facebook account:
                        </p>
                        <ol className="list-decimal space-y-2 pl-6">
                            <li>
                                Go to your Facebook profile&apos;s <strong>Settings & Privacy</strong> &gt; <strong>Settings</strong>.
                            </li>
                            <li>
                                In the left navigation menu, select <strong>Apps and Websites</strong>.
                            </li>
                            <li>
                                Locate <strong>CRM Messenger Production</strong> (or the connected CRM application).
                            </li>
                            <li>
                                Click <strong>Remove</strong> to revoke the app&apos;s permissions.
                            </li>
                            <li>
                                Facebook will automatically send a signed data deletion request to our callback endpoint,
                                generating a tracking confirmation code.
                            </li>
                        </ol>
                        <p className="text-sm text-slate-400">
                            (Tiếng Việt: Truy cập Cài đặt & quyền riêng tư &gt; Cài đặt &gt; Ứng dụng và trang web &gt; Tìm CRM Messenger Production &gt; Chọn Gỡ để xóa quyền truy cập).
                        </p>
                    </Section>

                    <Section title="3. Method 2: Request Deletion of Conversation Records / Yêu cầu xóa dữ liệu hội thoại trong CRM">
                        <p>
                            If you have messaged our connected Facebook Page (ví dụ: Trang &ldquo;Du học Đức và Học Tiếng Đức CHD&rdquo;)
                            and would like your messages, contact details, or CRM profile permanently deleted:
                        </p>
                        <ul className="list-disc space-y-2 pl-6">
                            <li>
                                <strong>Direct Messenger request:</strong> Send a message containing &ldquo;Yêu cầu xóa dữ liệu cá nhân&rdquo;
                                or &ldquo;Data deletion request&rdquo; directly to the connected Facebook Page.
                            </li>
                            <li>
                                <strong>Email request:</strong> Send an email to our Data Protection Administrator at{' '}
                                <a href="mailto:privacy@chd.edu.vn" className="text-blue-400 underline">
                                    privacy@chd.edu.vn
                                </a>{' '}
                                or{' '}
                                <a href="mailto:contact@cuachongngap.com" className="text-blue-400 underline">
                                    contact@cuachongngap.com
                                </a>{' '}
                                specifying your Facebook display name or profile link.
                            </li>
                        </ul>
                    </Section>

                    <Section title="4. Processing Timeline & Data Scope / Phạm vi và thời hạn xử lý">
                        <p>
                            Upon receiving a valid deletion request:
                        </p>
                        <ul className="list-disc space-y-2 pl-6">
                            <li>
                                Your Facebook Page-scoped identifier (PSID), display name, and stored conversation history
                                will be permanently purged from active customer records.
                            </li>
                            <li>
                                Any associated phone numbers or contact records voluntarily provided will be removed.
                            </li>
                            <li>
                                Processing is completed within <strong>30 calendar days</strong>, in compliance with applicable law
                                and Meta Platform specifications.
                            </li>
                        </ul>
                    </Section>

                    <Section title="5. Status Check / Tra cứu trạng thái yêu cầu">
                        <p>
                            If you already received a confirmation code from Meta&apos;s data deletion callback, you can check its status by adding{' '}
                            <code className="rounded bg-slate-800 px-2 py-0.5 text-blue-400 font-mono text-xs">
                                ?code=YOUR_CODE
                            </code>{' '}
                            to this URL, or visiting{' '}
                            <Link href="/data-deletion?code=del_status_inquiry" className="text-blue-400 underline">
                                trang tra cứu trạng thái
                            </Link>.
                        </p>
                    </Section>
                </div>

                <footer className="mt-12 flex flex-col sm:flex-row items-center justify-between border-t border-slate-800 pt-6 text-sm text-slate-500 gap-4">
                    <span>AI CRM · Public Data Deletion Instructions</span>
                    <Link href="/privacy-policy" className="text-blue-400 hover:text-blue-300 transition">
                        Xem Chính sách bảo mật (Privacy Policy) &rarr;
                    </Link>
                </footer>
            </div>
        </main>
    );
}
