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
            <div className="doc-kicker">Documentation</div>
            <h2 style={{ fontSize: '1.8rem', marginBottom: '8px' }}>{title}</h2>
            {subtitle ? <p className="subtitle">{subtitle}</p> : null}
          </div>
          <div className="header-actions">
            <a className={`btn ${active === 'report' ? 'btn-primary' : ''}`} href="/report">
              📄 Report
            </a>
            <a className={`btn ${active === 'instruction' ? 'btn-primary' : ''}`} href="/instruction">
              📋 Instructions
            </a>
            <a className={`btn ${active === 'tech_doc' ? 'btn-primary' : ''}`} href="/tech_doc">
              🔧 Tech Docs
            </a>
            <a className="btn" href="/">
              ← Dashboard
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
