import { useEffect } from 'react';

/** "Leads · LeadMaker" in the browser tab while the page is mounted. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = `${title} · LeadMaker`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
