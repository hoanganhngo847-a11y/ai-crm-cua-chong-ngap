import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Privacy Policy | AI CRM Cửa Chống Ngập',
    description:
        'Privacy Policy for AI CRM Cửa Chống Ngập and its Facebook Messenger integration.',
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

export default function PrivacyPolicyPage() {
    return (
        <main className="min-h-screen bg-slate-950 text-slate-100">
            <div className="mx-auto max-w-4xl px-6 py-12 sm:px-8 lg:py-16">
                <header className="mb-10 border-b border-slate-800 pb-8">
                    <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-blue-400">
                        AI CRM Cửa Chống Ngập
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                        Privacy Policy / Chính sách bảo mật
                    </h1>
                    <p className="mt-4 text-slate-400">
                        Last updated / Cập nhật lần cuối: 08 October 2026
                    </p>
                </header>

                <div className="space-y-10">
                    <Section title="1. Scope / Phạm vi áp dụng">
                        <p>
                            This Privacy Policy explains how AI CRM Cửa Chống Ngập
                            processes personal data when businesses use the CRM,
                            including data received through connected Facebook Pages
                            and Messenger conversations.
                        </p>
                        <p>
                            Chính sách này giải thích cách AI CRM Cửa Chống Ngập xử lý
                            dữ liệu cá nhân khi doanh nghiệp sử dụng hệ thống CRM, bao gồm
                            dữ liệu nhận được từ Trang Facebook được kết nối và các cuộc hội
                            thoại Messenger.
                        </p>
                    </Section>

                    <Section title="2. Data we process / Dữ liệu được xử lý">
                        <ul className="list-disc space-y-2 pl-6">
                            <li>
                                Facebook Page-scoped user identifiers and profile display
                                names used to associate a customer with a conversation.
                            </li>
                            <li>
                                Message content, timestamps, delivery/read metadata and
                                conversation metadata needed to operate the unified inbox.
                            </li>
                            <li>
                                Contact details such as a phone number only when a customer
                                voluntarily provides them in a message, form or other business
                                interaction.
                            </li>
                            <li>
                                CRM records, support notes and security/audit metadata needed
                                for customer service and system integrity.
                            </li>
                        </ul>
                        <p>
                            Hệ thống có thể xử lý mã định danh người dùng theo phạm vi Trang,
                            tên hiển thị Facebook, nội dung hội thoại, thời gian gửi nhận,
                            metadata vận hành, dữ liệu CRM và thông tin liên hệ mà khách hàng
                            chủ động cung cấp.
                        </p>
                    </Section>

                    <Section title="3. How we use data / Mục đích sử dụng">
                        <ul className="list-disc space-y-2 pl-6">
                            <li>Display and manage customer conversations in the CRM inbox.</li>
                            <li>
                                Allow authorized staff to respond to customer-initiated
                                Messenger conversations on behalf of a connected Facebook Page.
                            </li>
                            <li>
                                Create and update customer records, route support requests and
                                maintain sales/service history.
                            </li>
                            <li>
                                Protect the service, investigate errors and maintain security
                                and audit logs.
                            </li>
                        </ul>
                        <p>
                            Dữ liệu được sử dụng để hiển thị hội thoại, hỗ trợ nhân sự có thẩm
                            quyền trả lời khách, quản lý hồ sơ CRM, chăm sóc khách hàng, vận
                            hành hệ thống và đảm bảo an toàn bảo mật.
                        </p>
                    </Section>

                    <Section title="4. Zero-Phone access controls / Kiểm soát hiển thị số điện thoại">
                        <p>
                            The CRM applies role-based access controls. Where configured,
                            sales users receive a masked or redacted representation of a valid
                            customer phone number, while authorized administrators may access
                            the underlying contact record for legitimate business purposes.
                        </p>
                        <p>
                            CRM áp dụng phân quyền theo vai trò. Trong luồng Zero-Phone, nhân
                            viên Sale chỉ nhận phiên bản số điện thoại đã được che/ẩn, trong khi
                            quản trị viên được ủy quyền có thể truy cập dữ liệu liên hệ gốc khi
                            có mục đích nghiệp vụ hợp lệ.
                        </p>
                    </Section>

                    <Section title="5. Sharing and service providers / Chia sẻ dữ liệu và nhà cung cấp dịch vụ">
                        <p>
                            We do not sell customer personal data. Data may be processed by
                            service providers that are necessary to operate the application,
                            such as Meta for Messenger connectivity and infrastructure/database
                            providers used to host the CRM. Access is limited to what is needed
                            to provide the service.
                        </p>
                        <p>
                            Chúng tôi không bán dữ liệu cá nhân của khách hàng. Dữ liệu có thể
                            được xử lý bởi các nhà cung cấp cần thiết để vận hành dịch vụ, ví dụ
                            Meta cho kết nối Messenger và các nhà cung cấp hạ tầng/cơ sở dữ liệu
                            phục vụ hệ thống CRM.
                        </p>
                    </Section>

                    <Section title="6. Retention and security / Lưu trữ và bảo mật">
                        <p>
                            Data is retained only for as long as reasonably necessary for
                            customer service, business records, security, legal obligations and
                            operational continuity. The application uses access controls,
                            tenant separation, audit logging and other technical safeguards to
                            reduce unauthorized access.
                        </p>
                        <p>
                            Dữ liệu được lưu trong thời gian hợp lý để phục vụ chăm sóc khách
                            hàng, hồ sơ nghiệp vụ, bảo mật, nghĩa vụ pháp lý và tính liên tục vận
                            hành. Hệ thống sử dụng phân quyền truy cập, tách dữ liệu theo doanh
                            nghiệp, nhật ký kiểm tra và các biện pháp kỹ thuật phù hợp.
                        </p>
                    </Section>

                    <Section title="7. Data access, correction and deletion / Truy cập, chỉnh sửa và xóa dữ liệu">
                        <p>
                            Customers may request access, correction or deletion of personal
                            data associated with their conversation by contacting the business
                            through the same connected Facebook Page or through the business's
                            authorized CRM administrator. Requests will be reviewed and handled
                            subject to applicable legal and record-keeping requirements.
                        </p>
                        <p>
                            Khách hàng có thể yêu cầu truy cập, chỉnh sửa hoặc xóa dữ liệu cá
                            nhân liên quan đến cuộc hội thoại bằng cách liên hệ doanh nghiệp qua
                            chính Trang Facebook đã kết nối hoặc thông qua quản trị viên CRM được
                            ủy quyền. Yêu cầu sẽ được xử lý phù hợp với nghĩa vụ pháp lý và yêu
                            cầu lưu trữ hồ sơ hiện hành.
                        </p>
                    </Section>

                    <Section title="8. Facebook Platform data / Dữ liệu từ Nền tảng Facebook">
                        <p>
                            Data obtained through Meta products is used only to provide the
                            customer messaging and CRM functionality described in this policy.
                            The application does not use Facebook Platform data for unrelated
                            advertising profiles or sell that data to third parties.
                        </p>
                        <p>
                            Dữ liệu nhận qua nền tảng Meta chỉ được sử dụng để cung cấp chức
                            năng hội thoại và CRM nêu trong chính sách này, không được bán cho
                            bên thứ ba hoặc sử dụng để xây dựng hồ sơ quảng cáo không liên quan.
                        </p>
                    </Section>

                    <Section title="9. Changes to this policy / Thay đổi chính sách">
                        <p>
                            We may update this Privacy Policy when the application, legal
                            requirements or business processes change. The current version and
                            update date will always be published on this page.
                        </p>
                        <p>
                            Chính sách có thể được cập nhật khi chức năng hệ thống, quy định pháp
                            luật hoặc quy trình nghiệp vụ thay đổi. Phiên bản hiện hành và ngày
                            cập nhật sẽ được công bố tại trang này.
                        </p>
                    </Section>

                    <Section title="10. Contact / Liên hệ">
                        <p>
                            For privacy or data-deletion requests, please contact the business
                            through the Facebook Page connected to this CRM or contact the
                            authorized administrator of the business account using this service.
                        </p>
                        <p>
                            Với yêu cầu về quyền riêng tư hoặc xóa dữ liệu, vui lòng liên hệ
                            doanh nghiệp thông qua Trang Facebook đang kết nối với CRM hoặc quản
                            trị viên được ủy quyền của tài khoản doanh nghiệp sử dụng hệ thống.
                        </p>
                    </Section>
                </div>

                <footer className="mt-12 border-t border-slate-800 pt-6 text-sm text-slate-500">
                    AI CRM Cửa Chống Ngập · Public privacy notice
                </footer>
            </div>
        </main>
    );
}
