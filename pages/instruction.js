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

          {/* SCENARIO 1: BASIC SYNC */}
          <SectionCard title="1) Basic: Create Deal → Shopify Order">
            <p><strong>Action in Bitrix:</strong> Create a new Deal and add products.</p>
            <p><strong>Result in Shopify:</strong> A new Order is immediately created with the same items.</p>
            <ul>
              <li><strong>Verification:</strong> The Deal Title in Bitrix will update to the Shopify Order # (e.g., <strong>#1024</strong>).</li>
              <li><strong>Note:</strong> If you create a deal <em>without</em> products, a "Stub Order" is created. Adding products later will automatically update it to a real order.</li>
            </ul>
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

          {/* SCENARIO 6: PRE-ORDER */}
          <SectionCard title="6) Pre-Order: Reservation">
            <p><strong>Action in Bitrix:</strong> Create a Deal in the <strong>Pre-order</strong> category (Category ID: 4).</p>
            <p><strong>Result in Shopify:</strong> A "Pending" order is created to reserve inventory.</p>
            <ul>
              <li>Once the item is in stock/processed, moving the stage will update the order status.</li>
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
