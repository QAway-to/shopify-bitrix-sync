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
            <p><strong>Tip:</strong> You can copy the <em>full product title</em> (including the size) into the <strong>Model</strong> field (e.g., <code>Ilo KL grey Suede Barefoot Mens Sneakers - 42</code>). The system will correctly parse it.</p>
            <p><strong>Result in Shopify:</strong> The system searches for a matching product by these attributes. If found, it creates an order for that item.</p>

            <hr style={{ margin: '20px 0', border: '0', borderTop: '1px solid #eee' }} />

            <h4>3. Custom Order (Different Product)</h4>
            <p>
              <img
                src="/instructions/custom_preorder.png"
                alt="New Custom Product Creation"
                style={{ width: '50%', maxWidth: '100%', border: '1px solid #ddd', borderRadius: '4px' }}
              />
            </p>
            <p><strong>Action in Bitrix:</strong> Create a Deal and select/click <strong>"New custom product"</strong>.</p>
            <p><strong>Fill fields:</strong> Unit price, Brand, Model, Color, Size.</p>
            <p><strong>Result in Shopify:</strong> A new product is created in Shopify with these details, and a "Pending" order is created for it.</p>
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
            <p>
              <img
                src="/instructions/delivery_details.png"
                alt="Delivery Details"
                style={{ width: '50%', maxWidth: '100%', border: '1px solid #ddd', borderRadius: '4px' }}
              />
            </p>
            <p><strong>Action in Bitrix:</strong> Move Deal stage to <strong>Delivery</strong>.</p>
            <p><strong>Result in Shopify:</strong></p>
            <ul>
              <li><strong>Fulfillment:</strong> All open items in the order are marked as <strong>Fulfilled</strong>.</li>
              <li><strong>Tracking:</strong> If tracking info is available, it is sent to Shopify. Note: The tracking number will be the same for all items in the Shopify order.</li>
              <li><strong>Address:</strong> The delivery address is also synced from Bitrix to ensure shipping labels are correct.</li>
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
                  <li>Remove remaining items → Shopify issues Full Refund.</li>
                </ol>
              </li>
            </ul>
          </SectionCard>

          {/* SCENARIO 5: SHOPIFY -> BITRIX UPDATE */}
          <SectionCard title="5) Shopify Update → Bitrix Sync">
            <p><strong>Automatic Updates:</strong> Changes made in Shopify are automatically synced to Bitrix.</p>
            <p><strong>What updates:</strong></p>
            <ul>
              <li><strong>Stage:</strong> If order status changes (e.g. Cancelled, Refunded, Partially Refunded), the Bitrix Deal Stage updates automatically.</li>
              <li><strong>Payment Status:</strong> If payment is captured/voided in Shopify, the Payment Status field in Bitrix updates.</li>
              <li><strong>Totals:</strong> Order Total and Paid Amount are kept in sync.</li>
              <li><strong>Customer/Contact:</strong> Updating the customer email or details in a Shopify Order links the Deal to the correct Contact in Bitrix (or creates a new one).</li>
            </ul>
            <p><strong>Conditions:</strong> This sync happens whenever an order is updated in Shopify (e.g., via Admin panel or by another app).</p>
          </SectionCard>

          {/* SCENARIO 6: NEW SHOPIFY PRODUCT */}
          <SectionCard title="6) How to apply new product that was added in Shopify">
            <p>
              If you added a new product directly in Shopify (ensuring <strong>Vendor</strong>, <strong>Title</strong> includes Model, and <strong>Size</strong> option exists):
            </p>
            <p>
              When you next create a deal for this product in Bitrix following the instructions in <strong>1.2 (Catalog Order)</strong>, this product will appear in Bitrix and will be attached to the new deal.
            </p>
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
