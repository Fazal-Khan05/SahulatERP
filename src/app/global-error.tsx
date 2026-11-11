"use client"; // Error boundaries must be Client Components

// Replaces the whole document when the root layout itself fails, so it carries its own
// <html> and <body> and cannot rely on the app's styles.
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", textAlign: "center" }}>
        <title>Something went wrong — SahulatERP</title>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 500 }}>Something went wrong</h1>
        <p>SahulatERP could not be loaded. Try again in a minute.</p>
        <button type="button" onClick={() => retry()} style={{ padding: "0.4rem 0.8rem" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
