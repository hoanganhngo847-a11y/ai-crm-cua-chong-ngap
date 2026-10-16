import type { Metadata } from 'next';
import Link from 'next/link';

import { rpc } from '@/features/omnichannel/facebook/server';

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

type DeletionRecord = {
    confirmation_code: string;
    status: 'RECEIVED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED';
    resolution_strategy: string;
    created_at: string;
    processed_at: string | null;
};

async function lookupDeletionStatus(code: string): Promise<DeletionRecord | null> {
    if (!code || !/^del_[a-f0-9]{8,64}$/.test(code)) return null;
    try {
        const result = await rpc('han_get_data_deletion_status', {
            p_confirmation_code: code,
        });
        return result as DeletionRecord | null;
    } catch {
        return null;
    }
}

export default async function DataDeletionPage(props: {
    searchParams?: Promise<{ code?: string }>;
}) {
    const searchParams = props.searchParams ? await props.searchParams : {};
    const code = searchParams.code?.trim();
    const record = code ? await lookupDeletionStatus(code) : null;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-100">
            <div className="mx-auto max-w-4xl px-6 py-12 sm:px-8 lg:py-16">
                <header className="mb-10 border-b border-slate-800 pb-8">
                    <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-blue-400">
                        Facebook Messenger Platform Integration
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
                            <span className={`flex h-3 w-3 rounded-full ${
                                record?.status === 'COMPLETED'
                                    ? 'bg-emerald-400'
                                    : record
                                      ? 'bg-blue-400 animate-pulse'
                                      : 'bg-rose-400'
                            }`} />
                            <h2 className="text-lg font-semibold text-blue-300">
                                Tra cứu trạng thái yêu cầu / Request Status Lookup
                            </h2>
                        </div>
                        <div className="mt-4 space-y-3 text-sm text-slate-300">
                            <p>
                                <strong className="text-slate-100">Mã xác nhận (Confirmation Code):</strong>{' '}
                                <code className="rounded bg-slate-800 px-2 py-0.5 text-blue-400 font-mono">
                                    {code}
                                </code>
                            </p>

                            {record ? (
                                <>
                                    <p>
                                        <strong className="text-slate-100">Trạng thái (Status):</strong>{' '}
                                        {record.status === 'COMPLETED' && (
                                            <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-2.5 py-0.5 text-emerald-400 font-semibold">
                                                ĐÃ XÓA DỮ LIỆU (COMPLETED)
                                            </span>
                                        )}
                                        {record.status === 'PROCESSING' && (
                                            <span className="inline-flex items-center rounded-md bg-amber-500/10 px-2.5 py-0.5 text-amber-400 font-semibold">
                                                ĐANG XỬ LÝ (PROCESSING)
                                            </span>
                                        )}
                                        {record.status === 'RECEIVED' && (
                                            <span className="inline-flex items-center rounded-md bg-blue-500/10 px-2.5 py-0.5 text-blue-400 font-semibold">
                                                ĐÃ TIẾP NHẬN - CHỜ XÁC MINH (RECEIVED)
                                            </span>
                                        )}
                                        {record.status === 'REJECTED' && (
                                            <span className="inline-flex items-center rounded-md bg-rose-500/10 px-2.5 py-0.5 text-rose-400 font-semibold">
                                                TỪ CHỐI (REJECTED)
                                            </span>
                                        )}
                                    </p>
                                    <p className="text-xs text-slate-400">
                                        Thời điểm tiếp nhận (Created At): {new Date(record.created_at).toLocaleString('vi-VN')}
                                        {record.processed_at && ` · Xử lý xong (Processed At): ${new Date(record.processed_at).toLocaleString('vi-VN')}`}
                                    </p>
                                    <p className="text-xs text-slate-300">
                                        {record.status === 'COMPLETED'
                                            ? 'Dữ liệu cá nhân và liên kết tài khoản Facebook của bạn đã được xóa/ẩn danh hoàn toàn khỏi CRM.'
                                            : 'Yêu cầu của bạn đã được ghi nhận thực sự trên máy chủ và đang được tiến hành rà soát theo đúng quy định.'}
                                    </p>
                                </>
                            ) : (
                                <div className="rounded-md bg-rose-950/40 border border-rose-500/30 p-3 text-rose-300 text-xs">
                                    Không tìm thấy yêu cầu xóa dữ liệu với mã này trên hệ thống. Vui lòng kiểm tra lại mã hoặc liên hệ trực tiếp qua Trang Facebook đã kết nối.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div className="space-y-10">
                    <Section title="1. Overview / Tổng quan">
                        <p>
                            Pursuant to Meta Platform Terms and Privacy requirements, users who interact with our
                            Facebook Messenger integration have the right to request deletion of their personal
                            information and Messenger conversation data.
                        </p>
                        <p>
                            Theo Điều khoản Nền tảng Meta và các quy chuẩn bảo vệ quyền riêng tư, người dùng tương tác
                            qua kênh Facebook Messenger có quyền yêu cầu xóa thông tin cá nhân và dữ liệu liên quan
                            được lưu trữ trên hệ thống CRM.
                        </p>
                    </Section>

                    <Section title="2. Method 1: Remove App Permissions via Facebook / Gỡ bỏ ứng dụng qua Facebook">
                        <p>
                            To remove the application&apos;s permissions from your Facebook account:
                        </p>
                        <ol className="list-decimal space-y-2 pl-6">
                            <li>
                                Go to your Facebook profile&apos;s <strong>Settings & Privacy</strong> &gt; <strong>Settings</strong>.
                            </li>
                            <li>
                                In the left navigation menu, select <strong>Apps and Websites</strong>.
                            </li>
                            <li>
                                Locate the application (CRM Messenger Production) and click <strong>Remove</strong>.
                            </li>
                            <li>
                                Meta will send an authenticated data deletion callback to our server, generating a tracking
                                confirmation code.
                            </li>
                        </ol>
                        <p className="text-sm text-slate-400">
                            (Tiếng Việt: Truy cập Cài đặt & quyền riêng tư &gt; Cài đặt &gt; Ứng dụng và trang web &gt; Tìm ứng dụng CRM &gt; Chọn Gỡ).
                        </p>
                    </Section>

                    <Section title="3. Method 2: Direct Request to Connected Page / Yêu cầu trực tiếp qua Trang Facebook">
                        <p>
                            To request deletion of your conversation records, contact numbers, or profile information:
                        </p>
                        <ul className="list-disc space-y-2 pl-6">
                            <li>
                                <strong>Direct Messenger request:</strong> Send a message containing &ldquo;Yêu cầu xóa dữ liệu cá nhân&rdquo;
                                or &ldquo;Data deletion request&rdquo; directly to the connected Facebook Page.
                            </li>
                            <li>
                                <strong>Authorized administrator contact:</strong> Contact the authorized business administrator
                                of the connected Facebook Page to request verification and data purging.
                            </li>
                        </ul>
                    </Section>

                    <Section title="4. Processing Workflow & Data Scope / Quy trình và phạm vi xử lý">
                        <p>
                            When a data deletion request is received:
                        </p>
                        <ul className="list-disc space-y-2 pl-6">
                            <li>
                                <strong>Automatic mapping:</strong> If the user identifier matches a single customer record within
                                the organization, personal contact details and Facebook identities are immediately deleted,
                                and interaction contents are scrubbed.
                            </li>
                            <li>
                                <strong>Unmapped / Ambiguous requests:</strong> If the identifier cannot be safely mapped to a specific
                                customer record without ambiguity, the request is recorded as RECEIVED for manual administrative
                                review to prevent improper data loss.
                            </li>
                            <li>
                                <strong>Status tracking:</strong> The server-side confirmation code allows you to check whether the
                                deletion is RECEIVED, PROCESSING, or COMPLETED at any time.
                            </li>
                        </ul>
                    </Section>

                    <Section title="5. Status Check / Tra cứu trạng thái">
                        <p>
                            To check the authoritative status of a request, visit this page with your confirmation code:
                        </p>
                        <p>
                            <code className="rounded bg-slate-800 px-2 py-0.5 text-blue-400 font-mono text-xs">
                                /data-deletion?code=YOUR_CONFIRMATION_CODE
                            </code>
                        </p>
                    </Section>
                </div>

                <footer className="mt-12 flex flex-col sm:flex-row items-center justify-between border-t border-slate-800 pt-6 text-sm text-slate-500 gap-4">
                    <span>Public Data Deletion Instructions</span>
                    <Link href="/privacy-policy" className="text-blue-400 hover:text-blue-300 transition">
                        Xem Chính sách bảo mật (Privacy Policy) &rarr;
                    </Link>
                </footer>
            </div>
        </main>
    );
}
