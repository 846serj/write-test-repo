'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabase';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getUser().then(({ data, error }) => {
      if (error || !data.user) {
        router.push('/auth'); // Redirect to Supabase Auth page if not logged in
      } else {
        router.push('/generate'); // Redirect to Generate page if logged in
      }
    });
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center">
      <p>Redirecting...</p>
    </main>
  );
}
