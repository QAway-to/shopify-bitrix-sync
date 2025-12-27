import Head from 'next/head';
import DocsLayout from '../src/components/docs/DocsLayout';
import { readPublicDoc } from '../src/lib/docs/readPublicDoc';

export default function TechDocPage({ doc }) {
  return (
    <>
      <Head>
        <title>Техническая документация UI - Middleware сервис</title>
        <meta name="description" content="Техническая документация UI для разработчиков" />
      </Head>
      <DocsLayout
        title={doc?.title || 'Тех.док'}
        subtitle="Описание интерфейса, логов и правил работы интеграции."
        active="tech_doc"
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
    doc = readPublicDoc('03_TEKHNICHESKAYA_DOKUMENTATSIYA_UI.html');
  } catch (error) {
    console.error('Error reading tech doc HTML:', error);
    doc = {
      title: 'Техническая документация',
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

