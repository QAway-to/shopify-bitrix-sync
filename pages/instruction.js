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

export default function InstructionPage() {
  return (
    <>
      <Head>
        <title>Instructions - Middleware Service</title>
        <meta
          name="description"
          content="Test scenarios: what to do and what to expect in Bitrix and Shopify."
        />
      </Head>

      <DocsLayout
        title="Instructions"
        subtitle="Test scenarios: actions and expected results in Bitrix and Shopify."
        active="instruction"
      >
        <section className="card doc-card">
          <div className="doc-prose">
            <p>
              Below are practical test scenarios. Perform an action in one system and verify
              the result in the other.
            </p>
          </div>
        </section>

        <div className="doc-sections">
          <SectionCard title="Shopify → Bitrix (auto)">
            <p>
              <strong>Test:</strong> Create an order in Shopify (site or POS) → deal appears in
              Bitrix.
            </p>
            <ul>
              <li>
                <strong>In Bitrix you'll see:</strong> new deal with products and order total.
              </li>
              <li>
                <strong>Deal name:</strong> matches Shopify order number (e.g.,
                <strong> #2448</strong>).
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Bitrix → Shopify (main scenarios)">
            <p>
              Actions by manager in Bitrix and what automatically changes in Shopify.
            </p>
          </SectionCard>

          <SectionCard title="1) Test: Create deal with products → Order appears in Shopify">
            <p>
              <strong>Action in Bitrix:</strong> create deal and add products.
            </p>
            <p>
              <strong>What you'll see in Shopify:</strong> new order (inventory reserved) with
              same products and quantities.
            </p>
            <ul>
              <li>
                <strong>Detail:</strong> order in Shopify gets tags (e.g.,
                <code> BITRIX:1234</code>).
              </li>
              <li>
                <strong>Detail:</strong> deal name in Bitrix updates to Shopify order number
                (e.g., <strong>#2513</strong>).
              </li>
            </ul>
            <p>
              <strong>How to test:</strong>
            </p>
            <ol>
              <li>Create new deal in Bitrix and add 1-2 products</li>
              <li>Wait 10-60 seconds</li>
              <li>Open Shopify → Orders → find the new order</li>
            </ol>
          </SectionCard>

          <SectionCard title="1.1) Test: Create deal WITHOUT products → Stub order in Shopify">
            <p>
              <strong>Action in Bitrix:</strong> create deal but <strong>don't add products</strong> (or add products without SKU/XML_ID).
            </p>
            <p>
              <strong>What you'll see in Shopify:</strong> stub order with default product.
            </p>
            <ul>
              <li>
                <strong>Visual marker:</strong> order has tag <code>BITRIX_STUB</code> and note marked "STUB ORDER".
              </li>
              <li>
                <strong>Auto cleanup:</strong> when real products are added in Bitrix, stub clears automatically:
                <ul>
                  <li>Default product removed</li>
                  <li>Tag <code>BITRIX_STUB</code> removed</li>
                  <li>Note updates to normal format</li>
                </ul>
              </li>
              <li>
                <strong>Detail:</strong> deal name in Bitrix updates to Shopify order number.
              </li>
            </ul>
            <p>
              <strong>How to test:</strong>
            </p>
            <ol>
              <li>Create new deal in Bitrix <strong>without products</strong></li>
              <li>Wait 10-60 seconds</li>
              <li>Open Shopify → Orders → find order with <code>BITRIX_STUB</code> tag</li>
              <li>Add products to deal in Bitrix</li>
              <li>Wait 10-60 seconds</li>
              <li>Verify <code>BITRIX_STUB</code> tag is gone and default product removed</li>
            </ol>
          </SectionCard>

          <SectionCard title="2) Test: Change address in Bitrix → Address updates in Shopify">
            <p>
              <strong>Action in Bitrix:</strong> change shipping address in deal.
            </p>
            <p>
              <strong>What you'll see in Shopify:</strong> shipping address updates in order.
            </p>
            <ul>
              <li>
                <strong>Detail:</strong> after Bitrix update, Shopify order gets
                <code> BitrixUpdated</code> tag (prevents sync loops).
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="3) Test: Move deal to 'Delivery' → Fulfillment updates in Shopify">
            <p>
              <strong>Action in Bitrix:</strong> move deal to "Delivery" stage.
            </p>
            <p>
              <strong>What you'll see in Shopify:</strong> order gets fulfillment info,
              showing it's "being delivered".
            </p>
          </SectionCard>

          <SectionCard title="4) Test: Move deal to LOSE → Order cancelled in Shopify">
            <p>
              <strong>Action in Bitrix:</strong> move deal to LOSE.
            </p>
            <p>
              <strong>What you'll see in Shopify:</strong> linked order is cancelled,
              inventory restocked.
            </p>
            <ul>
              <li>
                <strong>Detail:</strong> order in Shopify gets <code>BitrixUpdated</code>{' '}
                tag after cancellation from Bitrix.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="What NOT to do (to avoid confusion)">
            <ul>
              <li>
                Don't change the same thing in both places simultaneously (e.g., address in both
                Bitrix and Shopify)
              </li>
              <li>
                Don't manually duplicate an order in Shopify if you're managing it via Bitrix
              </li>
            </ul>
          </SectionCard>
        </div>
      </DocsLayout>
    </>
  );
}
