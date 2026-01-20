import Head from 'next/head';
import DocsLayout from '../src/components/docs/DocsLayout';

function SectionCard({ title, children }) {
  return (
    <section className="card doc-card">
      <div className="card-header">
        <h3>{title}</h3>
      </div>
      <div className="doc-prose">{children}</div>
    </section>
  );
}

export default function ReportPage() {
  return (
    <>
      <Head>
        <title>Report - Middleware Service</title>
        <meta name="description" content="Middleware functionality report" />
      </Head>

      <DocsLayout
        title="Report"
        subtitle="What's implemented, what works partially, and known limitations."
        active="report"
      >
        <section className="card doc-card">
          <div className="doc-prose">
            <p>
              This report describes current Middleware (Shopify ↔ Bitrix) capabilities:
              what happens automatically and where there are limitations.
            </p>
          </div>
        </section>

        <div className="doc-sections">
          <SectionCard title="Implemented Features">
            <ul>
              <li>
                <strong>Shopify → Bitrix:</strong> deal creation/update from orders, product and amount transfer,
                payment/refund status updates.
              </li>
              <li>
                <strong>Bitrix → Shopify:</strong> order creation from Bitrix deal (inventory reservation),
                shipping address update, fulfillment, cancellation on LOSE.
              </li>
              <li>
                <strong>Loop guard:</strong> when changes come from Bitrix, Shopify order gets <code>BitrixUpdated</code>
                tag and/or <code>middleware.last_write</code> provenance marker to prevent sync loops.
              </li>
              <li>
                <strong>Linking tags:</strong> orders from Bitrix are tagged with <code>BITRIX:{'{dealId}'}</code>.
              </li>
              <li>
                <strong>UI & Logs:</strong> web interface with "Download Logs" button, logs include server output
                (captured <code>stdout/stderr</code>).
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Partial / Limitations">
            <ul>
              <li>
                <strong>Inventory:</strong> currently only products with <code>qty &gt; 0</code> are processed.
                Zero-stock products are excluded from auto operations.
              </li>
              <li>
                <strong>Size in Bitrix:</strong> Size enum is not fully configured (values only up to{' '}
                <strong>32</strong>), so larger sizes may not be set automatically.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Quick Verification for Managers">
            <ol>
              <li>Create order in Shopify → verify deal appears in Bitrix (deal name = <code>#XXXX</code>)</li>
              <li>Change address in Bitrix → verify address updates in Shopify</li>
              <li>Move deal to "Delivery" → verify fulfillment updates in Shopify</li>
              <li>Move deal to LOSE → verify order cancellation in Shopify</li>
            </ol>
          </SectionCard>

          <SectionCard title="12. Delivery tracking number sync (Bitrix → Shopify)">
            <ul>
              <li>
                <strong>Issue:</strong> Tracking numbers entered in Bitrix are not transferred to Shopify. As a result,
                Shopify does not send automatic tracking emails to customers.
              </li>
              <li>
                <strong>Fix:</strong> Tracking numbers now sync automatically from Bitrix to Shopify.
              </li>
            </ul>

            <hr style={{ margin: '20px 0', border: '0', borderTop: '2px solid #fbbf24' }} />

            <h4>How it works:</h4>
            <ul>
              <li>
                <strong>Trigger:</strong> When a deal is moved to the <strong>"Delivery"</strong> stage in Bitrix, the system
                automatically creates a fulfillment in Shopify.
              </li>
              <li>
                <strong>Data Transfer:</strong> The tracking number from Bitrix field <code>UF_CRM_1741776378819</code> is
                passed to Shopify.
              </li>
              <li>
                <strong>Notification:</strong> Shopify sends an automatic <em>"Your order has been shipped"</em> email to the
                customer <u>with</u> the tracking number.
              </li>
            </ul>

            <h4 style={{ marginTop: '20px' }}>Supported pipelines:</h4>
            <ul>
              <li>
                <strong>Category 2 (Stock - Site):</strong> Stage <code>C2:EXECUTING</code>
              </li>
              <li>
                <strong>Category 4 (Pre-order - Shop):</strong> Stage <code>C4:2</code>
              </li>
              <li>
                <strong>Category 8 (Pre-order - Site):</strong> Stage <code>C8:2</code>
              </li>
            </ul>
          </SectionCard>
        </div>
      </DocsLayout>
    </>
  );
}
