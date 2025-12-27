import Head from 'next/head';
import DocsLayout from '../src/components/docs/DocsLayout';
import { readPublicDoc } from '../src/lib/docs/readPublicDoc';

export default function InstructionPage({ doc }) {
  return (
    <>
      <Head>
        <title>Инструкция для менеджеров - Middleware сервис</title>
        <meta name="description" content="Инструкция для менеджеров по работе с Bitrix24" />
      </Head>
      <DocsLayout
        title={doc?.title || 'Инструкция'}
        subtitle="Короткие сценарии “что сделать” и “что увидеть” в Bitrix и Shopify."
        active="instruction"
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
    doc = readPublicDoc('02_INSTRUKTSIYA_DLYA_MENEDZHEROV.html');
  } catch (error) {
    console.error('Error reading instruction HTML:', error);
    doc = {
      title: 'Инструкция',
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

