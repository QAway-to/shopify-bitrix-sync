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
        title="Instructions & Test Scenarios"
        subtitle="Guide for verifying synchronization between Bitrix24 and Shopify."
        active="instruction"
      >
        <section className="card doc-card">
          <div className="doc-prose">
            <p>
              This guide describes how to verify the integration. Perform actions in one system
              and observe the automatic updates in the other.
            </p>
          </div>
        </section>

        <div className="doc-sections">

          {/* SCENARIO 1: PRE-ORDER (IN THE SHOP) */}
          <SectionCard title="1) Pre-order (in the shop)">
            <p>
              When taking a pre-order in the shop (Category ID: 4), you can select an existing product or define a new one.
            </p>

            <h4>1. Regular Order (Product exists)</h4>
            <p>
              <img
                src="/instructions/regular_order.png"
                alt="Regular Order Selection"
                style={{ width: '50%', maxWidth: '100%', border: '1px solid #ddd', borderRadius: '4px' }}
              />
            </p>
            <p><strong>Action in Bitrix:</strong> Create a Deal and select a product from the list (must have <strong>SIZE</strong> in the title).</p>
            <p><strong>Result in Shopify:</strong> A "Pending" order is created reserving this specific variant.</p>
            <p><em>If the desired product/size is not in the list, proceed to method 2.</em></p>

            <hr style={{ margin: '20px 0', border: '0', borderTop: '1px solid #eee' }} />

            <h4>2. Catalog Order (New/Custom Product)</h4>
            <p>
              <img
                src="/instructions/catalog_order.png"
                alt="Catalog Order Creation"
                style={{ width: '50%', maxWidth: '100%', border: '1px solid #ddd', borderRadius: '4px' }}
              />
            </p>
            <p><strong>Action in Bitrix:</strong> Create a Deal and manually enter <strong>Brand</strong>, <strong>Model</strong>, and <strong>Size</strong> to define the product.</p>
            <p><strong>Result in Shopify:</strong> The system searches for a matching product by these attributes. If found, it creates an order for that item. If not found, it may create a custom item order.</p>
          </SectionCard>

          {/* SCENARIO 2: FULL CONTROL SYNC */}
          <SectionCard title="2) Full Control: Add/Remove Items">
            <p><strong>Action in Bitrix:</strong> Add or remove products in an existing Deal.</p>
            <p><strong>Result in Shopify:</strong> The Order updates immediately to match.</p>
            <ul>
              <li><strong>Add Item:</strong> Add a product row in Bitrix → Item appears in Shopify order.</li>
              <li><strong>Remove Item:</strong> Delete a product row in Bitrix → Item is removed from Shopify order.</li>
              <li><strong>Quantity Change:</strong> Change quantity in Bitrix → Quantity updates in Shopify.</li>
            </ul>
          </SectionCard>

          {/* SCENARIO 3: DELIVERY */}
          <SectionCard title="3) Delivery: Trigger Fulfillment">
            <p><strong>Action in Bitrix:</strong> Move Deal stage to <strong>Delivery</strong>.</p>
            <p><strong>Result in Shopify:</strong> All open items in the order are marked as <strong>Fulfilled</strong>.</p>
            <ul>
              <li><strong>Verification:</strong> Shopify Order status changes to "Fulfilled".</li>
              <li><strong>Tracking:</strong> If tracking info is available, it is sent to Shopify.</li>
            </ul>
          </SectionCard>

          {/* SCENARIO 4: REFUNDS & CANCELLATION */}
          <SectionCard title="4) Refunds & Cancellation (LOSE Stage)">
            <p><strong>Action in Bitrix:</strong> Move Deal stage to <strong>LOSE</strong>.</p>
            <p><strong>Result in Shopify:</strong> Expected behavior depends on how you handle items:</p>
            <ul>
              <li><strong>Full Cancel:</strong> Move Deal to LOSE directly → **Full Refund** & Order Cancelled in Shopify.</li>
              <li><strong>Partial Refund (Step-by-Step):</strong>
                <ol>
                  <li>Move Deal to <strong>LOSE</strong> stage.</li>
                  <li><strong>Remove one item</strong> in Bitrix Deal.</li>
                  <li>Result: Shopify issues a **Partial Refund** for <em>only</em> that item.</li>
                  <li>Remove remaining items → Shopify issues Full Refund and Cancels order.</li>
                </ol>
              </li>
            </ul>
          </SectionCard>

          {/* SCENARIO 5: CONTACT SYNC */}
          <SectionCard title="5) Customer Sync: Update Email">
            <p><strong>Action in Shopify:</strong> Update Customer Email on an existing Order.</p>
            <p><strong>Result in Bitrix:</strong> The Deal links to the correct Contact.</p>
            <ul>
              <li>If the contact exists in Bitrix, the Deal is linked to it.</li>
              <li>If the contact is new, a new Contact is created in Bitrix and linked.</li>
            </ul>
          </SectionCard>

          <SectionCard title="What NOT to do">
            <ul>
              <li>Don't manually refund in Shopify if you expect Bitrix to handle it (let Bitrix drive the process).</li>
              <li>Don't delete orders in Shopify; cancel them via Bitrix LOSE stage instead.</li>
            </ul>
          </SectionCard>

        </div>
      </DocsLayout>
    </>
  );
}
