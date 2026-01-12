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

export default function TechDocPage() {
  return (
    <>
      <Head>
        <title>Tech Docs - Middleware Service</title>
        <meta name="description" content="Technical reference for UI and integration rules" />
      </Head>

      <DocsLayout
        title="Tech Docs"
        subtitle="Quick technical reference: tags, loop guard, logs and UI."
        active="tech_doc"
      >
        <section className="card doc-card">
          <div className="doc-prose">
            <p>
              This page is a compact technical reference: what UI elements mean, what markers
              are used for linking and loop protection, and where to find logs.
            </p>
          </div>
        </section>

        <div className="doc-sections">
          <SectionCard title="Main UI">
            <ul>
              <li>
                Main page: event monitoring for <strong>Shopify → Bitrix</strong> and <strong>Bitrix → Shopify</strong>
              </li>
              <li>
                Manual event sending available (in case auto-processing fails)
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Tags & Order Linking">
            <ul>
              <li>
                <strong>BITRIX:{'{dealId}'}</strong> — tag on Shopify order linking it to Bitrix deal
                (prevents duplicates).
              </li>
              <li>
                <strong>Bitrix deal name:</strong> updates to Shopify order number (e.g., <code>#2494</code>)
                for easy matching by managers.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Loop Guard (cycle protection)">
            <ul>
              <li>
                When changes come from Bitrix, Shopify order gets <code>BitrixUpdated</code> tag.
              </li>
              <li>
                Additional provenance marker (metafield) <code>middleware.last_write=bitrix</code> may be set.
              </li>
              <li>
                Shopify webhook sees these markers and skips the event to prevent chain like{' '}
                <code>Shopify → Middleware → Bitrix → Middleware → Shopify</code>.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Logs">
            <ul>
              <li>
                <strong>"Download Logs"</strong> button exports full log file including server output
                (captured <code>stdout/stderr</code>).
              </li>
              <li>
                Logs show Shopify/Bitrix payloads and responses for diagnostics (4xx/5xx errors, address validation, etc.).
              </li>
            </ul>
          </SectionCard>
        </div>
      </DocsLayout>
    </>
  );
}
