import Head from 'next/head';
import DocsLayout from '../src/components/docs/DocsLayout';
import { readPublicDoc } from '../src/lib/docs/readPublicDoc';

export default function ReportPage({ doc }) {
  return (
    <>
      <Head>
        <title>Отчёт для заказчика - Middleware сервис</title>
        <meta name="description" content="Отчёт о функциональности Middleware сервиса для заказчика" />
      </Head>
      <DocsLayout
        title={doc?.title || 'Отчёт'}
        subtitle="Что реализовано, что работает частично, и известные ограничения."
        active="report"
      >
        {doc?.introHtml ? (
          <section className="card doc-card">
            <div className="doc-prose" dangerouslySetInnerHTML={{ __html: doc.introHtml }} />
          </section>
        ) : null}

        <div className="doc-sections">
          {(doc?.sections || []).map((section, idx) => (
            <section key={`${section.heading}-${idx}`} className="card doc-card">
              <div className="card-header">
                <h2>{section.heading}</h2>
              </div>
              <div className="doc-prose" dangerouslySetInnerHTML={{ __html: section.html }} />
            </section>
          ))}
        </div>
      </DocsLayout>
    </>
  );
}

export async function getServerSideProps({ res }) {
  let doc;

  try {
    doc = readPublicDoc('01_OTCHET_DLYA_ZAKAZCHIKA.html');
  } catch (error) {
    console.error('Error reading report HTML:', error);
    doc = {
      title: 'Отчёт',
      introHtml: '<p>Ошибка загрузки документа</p>',
      sections: []
    };
  }

  // Avoid stale caching of docs pages
  if (res) {
    res.setHeader('Cache-Control', 'no-store');
  }

  return {
    props: {
      doc
    }
  };
}
