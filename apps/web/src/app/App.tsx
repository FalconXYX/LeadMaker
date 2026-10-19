import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { AuthProvider } from '@/auth/AuthContext';
import { ToastProvider } from '@/components/ui';
import { createQueryClient } from './queryClient';
import { createRouter } from './routes';

export function App({ queryClient }: { queryClient?: QueryClient }) {
  const [qc] = useState(() => queryClient ?? createQueryClient());
  const [router] = useState(createRouter);
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
