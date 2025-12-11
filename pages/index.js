import Head from 'next/head';
import ApiCard from '../src/components/ApiCard';

export default function Home() {
  const apis = [
    {
      icon: '📚',
      title: 'Wayback Machine',
      description: 'Access archived website snapshots and analyze historical content.',
      href: '/wayback',
      status: 'ready',
    },
    {
      icon: '🛍️',
      title: 'Shopify Webhook',
      description: 'Receive and monitor Shopify webhook events in real-time.',
      href: '/shopify',
      status: 'ready',
    },
  ];

  return (
    <>
      <Head>
        <title>API Services Manager</title>
        <meta name="description" content="Manage integrations with external APIs" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </Head>
      <main className="page">
        <header className="page-header">
          <div>
            <h1>API Services Manager</h1>
            <p className="subtitle">
              Manage integrations with external APIs
            </p>
          </div>
        </header>

        <section>
          <div className="api-grid">
            {apis.map((api, index) => (
              <ApiCard
                key={index}
                icon={api.icon}
                title={api.title}
                description={api.description}
                href={api.href}
                status={api.status}
              />
            ))}
          </div>
        </section>

      </main>
    </>
  );
}

