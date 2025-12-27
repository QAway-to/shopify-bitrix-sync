import Head from 'next/head';

export default function DocsLayout({
  title,
  subtitle,
  active = 'instruction',
  children
}) {
  return (
    <>
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </Head>
      <main className="page">
        <header className="page-header">
          <div>
            <div className="doc-kicker">Публичные страницы</div>
            <h1>{title}</h1>
            {subtitle ? <p className="subtitle">{subtitle}</p> : null}
          </div>
          <div className="header-actions">
            <a className={`btn ${active === 'report' ? 'btn-primary' : ''}`} href="/report">
              📄 Отчёт
            </a>
            <a className={`btn ${active === 'instruction' ? 'btn-primary' : ''}`} href="/instruction">
              📋 Инструкция
            </a>
            <a className={`btn ${active === 'tech_doc' ? 'btn-primary' : ''}`} href="/tech_doc">
              🔧 Тех.док
            </a>
            <a className="btn" href="/">
              ← В интерфейс
            </a>
          </div>
        </header>

        {children}

        <footer className="page-footer">
          Middleware • Public pages
        </footer>
      </main>
    </>
  );
}


